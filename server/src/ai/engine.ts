/**
 * The in-app assistant: one conversation turn, run on the node. The owner says something; the model answers, calling
 * Little Dipper's tools as it goes (the same tools assistants use over MCP, each a call to this node's own API with
 * the assistant's key). So its scopes, Review, undo and the activity log all apply, exactly as for Claude or Muse
 * connected from outside.
 *
 * Conversations are stored encrypted on the node: the provider's own history (so nothing is rewritten between turns)
 * and a plain transcript for the panel.
 */
import type { FastifyInstance } from 'fastify';
import { decrypt, encrypt, newId } from '../crypto.js';
import { ctx } from '../ctx.js';
import { HttpError, notFound } from '../auth.js';
import { readFile } from '../files.js';
import { INSTRUCTIONS, TOOLS, ToolError, type Call } from '../routes/mcp.js';
import { getModel, modelInstructions, secretsOf, type AiModelDoc } from './models.js';
import { getSettings } from './settings.js';
import { adapterFor, ModelError, type ToolOutcome, type Usage } from './providers.js';

export type ToolNote = { name: string; title: string; ok: boolean; note?: string; pending?: boolean; reviewIds?: string[] };
export type Turn =
  | { role: 'user'; text: string; files: { id: string; name: string }[]; at: string }
  | { role: 'assistant'; text: string; tools: ToolNote[]; stopNote?: string; error?: string; usage: Usage; at: string;
      /** The standing instructions it was following, so answers from different models and instructions can be compared. */
      followed?: { all: string; model: string } };

export type ChatDoc = {
  _id: string;
  modelId: string;
  title: string;
  /** Turn[] as JSON, encrypted. */
  turnsEnc: string;
  /** The provider's own message history as JSON, encrypted. */
  nativeEnc: string;
  usage: Usage;
  createdAt: string;
  updatedAt: string;
};

export type Event =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; title: string; phase: 'start' }
  | { type: 'tool'; id: string; name: string; title: string; phase: 'done'; ok: boolean; note?: string; pending?: boolean; reviewIds?: string[] }
  | { type: 'done'; turn: Turn; usage: Usage }
  | { type: 'error'; code: string; message: string };

const MAX_STEPS = 16;
const MAX_FILES = 6;
const now = () => new Date().toISOString();
const enc = (v: unknown) => encrypt(ctx.keys.masterKey, JSON.stringify(v));
const dec = <T>(s: string): T => JSON.parse(decrypt(ctx.keys.masterKey, s)) as T;

const SYSTEM = `${INSTRUCTIONS}

You are talking with the owner inside their own Little Dipper, in a chat panel beside what they're looking at. Each message may say which page they're on, and may come with pages of a document they attached.
- Be warm, plain and brief. Use the owner's own words for things; no jargon.
- When they attach a document and ask you to add what it says, read it, check what's already recorded (search first, so you don't add twice), then add or update the entries. Mention anything you couldn't read clearly.
- Say what you did in one or two lines at the end, and when changes are waiting for them, say they're in Review.
- If something needs the owner (approving, deleting, sharing), tell them where to do it rather than trying.`;

/** The owner's standing instructions go after the rules, which they can't override. */
function withInstructions(f: { all: string; model: string }) {
  const parts = [f.all, f.model].filter(Boolean);
  if (!parts.length) return SYSTEM;
  return `${SYSTEM}

The owner's standing instructions, in their words. Follow them in everything you do, unless they conflict with the rules above (the rules win):
${parts.join('\n\n')}`;
}

export async function createChat(modelId: string) {
  await getModel(modelId);
  const c: ChatDoc = { _id: newId('cht'), modelId, title: 'New conversation', turnsEnc: enc([]), nativeEnc: enc([]), usage: { input: 0, output: 0 }, createdAt: now(), updatedAt: now() };
  await ctx.store.insert('chats', c);
  return c;
}

export async function getChat(id: string) {
  const c = await ctx.store.get<ChatDoc>('chats', id);
  if (!c) throw notFound('chat_not_found');
  return c;
}

export const chatSummary = (c: ChatDoc) => ({ id: c._id, modelId: c.modelId, title: c.title, usage: c.usage, createdAt: c.createdAt, updatedAt: c.updatedAt });
export const chatOut = (c: ChatDoc) => ({ ...chatSummary(c), turns: dec<Turn[]>(c.turnsEnc) });

/** A turn runs at a time per conversation. */
const running = new Set<string>();

/** What a tool did, in a line for the panel. Changes that wait for the owner are flagged. */
function noteFor(name: string, out: unknown): { note?: string; pending?: boolean; reviewIds?: string[] } {
  const o = (out ?? {}) as Record<string, unknown>;
  // Suggestions waiting for the owner: the panel shows them as cards to approve right there.
  const all = [o, o.pendingReview, ...(Array.isArray(o.results) ? (o.results as Record<string, unknown>[]) : [])] as (Record<string, unknown> | undefined)[];
  const reviewIds = all.map((x) => (x && x.status === 'pending_review' && typeof x.reviewId === 'string' ? x.reviewId : null)).filter((x): x is string => !!x);
  if (reviewIds.length) return { pending: true, reviewIds, note: reviewIds.length === 1 ? 'Waiting for your OK' : `${reviewIds.length} waiting for your OK` };
  if (Array.isArray(o.records)) return { note: `${o.records.length} found` };
  if (Array.isArray(o.results)) return { note: `${o.results.length} done` };
  if (Array.isArray(o.documents)) return { note: `${o.documents.length} found` };
  return name.startsWith('add') || name.startsWith('update') || name.startsWith('file') || name.startsWith('upload') ? { note: 'Saved' } : {};
}

export async function runTurn(app: FastifyInstance, chatId: string, input: { text: string; fileIds: string[]; context?: string }, emit: (e: Event) => void) {
  const chat = await getChat(chatId);
  if (running.has(chatId)) throw new HttpError(409, 'busy', 'This conversation is still answering.');
  const text = input.text.trim().slice(0, 20_000);
  if (!text) throw new HttpError(400, 'empty', 'Say something first');
  const fileIds = [...new Set(input.fileIds)].slice(0, MAX_FILES);
  const files: { id: string; name: string }[] = [];
  for (const id of fileIds) {
    const f = await readFile(id);
    if (!f) throw new HttpError(404, 'file_not_found', 'One of the attached pages is no longer there');
    files.push({ id, name: f.doc.name });
  }

  const model = await getModel(chat.modelId).catch(() => { throw new HttpError(409, 'model_removed', 'The model this conversation used has been removed. Start a new one.'); });
  running.add(chatId);
  const turns = dec<Turn[]>(chat.turnsEnc);
  const native = dec<unknown[]>(chat.nativeEnc);
  const startLen = native.length;
  const usage: Usage = { input: 0, output: 0 };
  const tools: ToolNote[] = [];
  const followed = { all: (await getSettings()).instructions, model: modelInstructions(model) };
  const system = withInstructions(followed);
  let reply = '', stopNote: string | undefined, error: string | undefined;

  try {
    const { apiKey, assistantKey } = await secretsOf(model);
    const adapter = adapterFor(model, apiKey);
    // Every tool call is a request to this node's own API, carrying the assistant's key and nothing else.
    const call: Call = async (method, url, body, contentType) => {
      const r = await app.inject({
        method: method as 'GET', url,
        headers: { authorization: `Bearer ${assistantKey}`, ...(body !== undefined ? { 'content-type': contentType || 'application/json' } : {}) },
        payload: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
      let parsed: unknown = null;
      try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = r.body; }
      return { status: r.statusCode, body: parsed };
    };
    const specs = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    const today = new Date().toISOString().slice(0, 10);
    const said = `${input.context ? `[On screen: ${input.context.slice(0, 300)}]\n` : ''}[Today: ${today}]\n${text}`;
    native.push(adapter.userMessage(said, fileIds));

    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await adapter.turn(native, specs, system, (t) => { reply += t; emit({ type: 'text', text: t }); });
      native.push(r.message);
      usage.input += r.usage.input; usage.output += r.usage.output;
      if (r.stop === 'stopped') { stopNote = r.stopNote; break; }
      if (r.stop === 'end') break;
      if (!r.calls.length) continue; // paused: send it back so it carries on
      const outcomes: ToolOutcome[] = [];
      for (const c of r.calls) {
        const tool = TOOLS.find((t) => t.name === c.name);
        const title = tool?.title ?? c.name;
        emit({ type: 'tool', id: c.id, name: c.name, title, phase: 'start' });
        let outcome: ToolOutcome, note: ToolNote;
        if (c.invalid || !tool) {
          outcome = { id: c.id, content: JSON.stringify({ INVALID_INPUT: c.invalid ?? 'unknown tool' }), isError: true };
          note = { name: c.name, title, ok: false, note: 'Couldn\'t read its request' };
        } else {
          try {
            const out = await tool.run(c.input as Record<string, unknown>, call);
            outcome = { id: c.id, content: JSON.stringify(out), isError: false };
            note = { name: c.name, title, ok: true, ...noteFor(c.name, out) };
          } catch (e) {
            if (!(e instanceof ToolError)) throw e;
            outcome = { id: c.id, content: e.message, isError: true };
            note = { name: c.name, title, ok: false, note: e.message.replace(/^[a-z_]+: /, '') };
          }
        }
        tools.push(note);
        emit({ type: 'tool', id: c.id, name: c.name, title, phase: 'done', ok: note.ok, note: note.note, pending: note.pending, reviewIds: note.reviewIds });
        outcomes.push(outcome);
      }
      native.push(...adapter.toolResults(outcomes));
      if (step === MAX_STEPS - 1) stopNote = 'That took a lot of steps, so I stopped here. Ask me to carry on.';
    }
  } catch (e) {
    // The service failed: keep the conversation as it was, so the next try starts clean.
    native.length = startLen;
    if (e instanceof ModelError) { error = e.message; emit({ type: 'error', code: e.code, message: e.message }); }
    else if (e instanceof HttpError) { error = e.message; emit({ type: 'error', code: e.code, message: e.message }); }
    else { error = 'Something went wrong on this Little Dipper.'; emit({ type: 'error', code: 'internal', message: error }); app.log.error(e); }
  } finally {
    running.delete(chatId);
  }

  const at = now();
  const userTurn: Turn = { role: 'user', text, files, at };
  const botTurn: Turn = { role: 'assistant', text: reply, tools, ...(stopNote ? { stopNote } : {}), ...(error ? { error } : {}), usage, at, ...(followed.all || followed.model ? { followed } : {}) };
  turns.push(userTurn, botTurn);
  const title = chat.title === 'New conversation' ? text.split('\n')[0].slice(0, 70) : chat.title;
  await ctx.store.update('chats', chatId, {
    turnsEnc: enc(turns), nativeEnc: enc(native), title, updatedAt: at,
    usage: { input: chat.usage.input + usage.input, output: chat.usage.output + usage.output },
  });
  emit({ type: 'done', turn: botTurn, usage });
}

export type { AiModelDoc };
