/**
 * Talking to a model: one turn at a time, streaming, with tools. Two kinds of service:
 *   - Claude, through the official Anthropic SDK;
 *   - anything that speaks the OpenAI-compatible chat API (most services that run open-weight models).
 *
 * Each conversation keeps its history in its provider's own format ("native"), so nothing is lost or rewritten between
 * turns (Claude's thinking blocks must come back unchanged). The engine (engine.ts) stays provider-neutral: it asks an
 * adapter for a turn, runs the tools the model called, and hands the results back.
 *
 * Document pages are referenced in history as { type: 'ld_file', fileId } and filled in with the page's bytes just
 * before each request, so stored conversations stay small and every request sends the same bytes.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFile, TEXT_TYPES } from '../files.js';
import type { AiModelDoc } from './models.js';

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; input: unknown; invalid?: string };
export type ToolOutcome = { id: string; content: string; isError: boolean };
/** input: all input tokens; cacheRead / cacheWrite: the part read from or written to the provider's prompt cache (priced differently). */
export type Usage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
export type TurnResult = {
  /** The model's message, to append to history as is. */
  message: unknown;
  text: string;
  calls: ToolCall[];
  /** end: finished; tools: wants the calls run; stopped: refused or ran out of room (no tools are run). */
  stop: 'end' | 'tools' | 'stopped';
  stopNote?: string;
  usage: Usage;
};

export interface Adapter {
  userMessage(text: string, fileIds: string[]): unknown;
  toolResults(outcomes: ToolOutcome[]): unknown[];
  turn(history: unknown[], tools: ToolSpec[], system: string, onText: (t: string) => void): Promise<TurnResult>;
}

/** A model's message for the owner when the service says no, in plain words. */
export class ModelError extends Error {
  constructor(message: string, readonly code = 'model_error') { super(message); }
}

// ── tool input checks (inputs stream unvalidated) ─────────────────────
/** The checks the tools' JSON schemas ask for at the top level: an object, required fields, basic types. */
export function checkInput(schema: Record<string, unknown>, input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'The input must be an object';
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  for (const k of (schema.required as string[] | undefined) ?? []) if (!(k in (input as object))) return `Missing ${k}`;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const t = props[k]?.type;
    if (!t || v === null) continue;
    const ok = t === 'integer' ? Number.isInteger(v) : t === 'array' ? Array.isArray(v) : t === 'object' ? typeof v === 'object' && !Array.isArray(v) : typeof v === t;
    if (!ok) return `${k} must be ${t === 'integer' ? 'a whole number' : `a ${t}`}`;
  }
  return null;
}

async function fileBytes(fileId: string) {
  const f = await readFile(fileId);
  if (!f) return null;
  return { type: f.doc.type, name: f.doc.name, base64: f.data.toString('base64'), text: TEXT_TYPES.includes(f.doc.type) ? f.data.toString('utf8') : null };
}

type LdFile = { type: 'ld_file'; fileId: string };
const isLdFile = (b: unknown): b is LdFile => !!b && typeof b === 'object' && (b as LdFile).type === 'ld_file';

// ── Claude ────────────────────────────────────────────────────────────
type BParam = Anthropic.Beta.Messages.BetaMessageParam;

/** Models that accept the newer request options: effort, server-side refusal fallbacks. */
const MODERN = /^claude-(opus-5|sonnet-5-5|fable-5|haiku-5-5)/;
const FALLBACKS = /^claude-(opus-5-5|opus-5$|sonnet-5-5|fable-5)/;

export function anthropicAdapter(m: AiModelDoc, apiKey: string): Adapter {
  const client = new Anthropic({ apiKey });

  async function expand(history: unknown[]): Promise<BParam[]> {
    const out: BParam[] = [];
    for (const msg of history as BParam[]) {
      if (!Array.isArray(msg.content)) { out.push(msg); continue; }
      const content = [];
      for (const b of msg.content as unknown[]) {
        if (!isLdFile(b)) { content.push(b); continue; }
        const f = await fileBytes(b.fileId);
        if (!f) content.push({ type: 'text', text: '(A page that has since been deleted.)' });
        else if (f.text !== null) content.push({ type: 'text', text: `The file ${f.name}:\n\n${f.text}` });
        else if (f.type === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.base64 } });
        else if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(f.type)) content.push({ type: 'image', source: { type: 'base64', media_type: f.type, data: f.base64 } });
        else content.push({ type: 'text', text: `(A page in a format this model can't read: ${f.type}.)` });
      }
      out.push({ ...msg, content } as BParam);
    }
    return out;
  }

  return {
    userMessage: (text, fileIds) => ({ role: 'user', content: [...fileIds.map((fileId) => ({ type: 'ld_file', fileId })), { type: 'text', text }] }),
    toolResults: (outcomes) => [{ role: 'user', content: outcomes.map((o) => ({ type: 'tool_result', tool_use_id: o.id, content: o.content, ...(o.isError ? { is_error: true } : {}) })) }],
    async turn(history, tools, system, onText) {
      const params = {
        model: m.model,
        max_tokens: 32000,
        system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }],
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema, eager_input_streaming: true })),
        messages: await expand(history),
        ...(MODERN.test(m.model) ? { output_config: { effort: 'medium' as const } } : {}),
        // If a safety classifier declines, the API retries on a model it picks, inside the same call.
        ...(FALLBACKS.test(m.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      };
      let message: Anthropic.Beta.Messages.BetaMessage | null = null;
      for (let attempt = 0; !message; attempt++) {
        try {
          const stream = client.beta.messages.stream(params as Anthropic.Beta.Messages.MessageCreateParamsStreaming);
          stream.on('text', onText);
          message = await stream.finalMessage();
        } catch (e) {
          if (e instanceof Anthropic.AuthenticationError) throw new ModelError('Anthropic didn\'t accept the API key. Check it in Settings → AI models.', 'model_auth');
          if (e instanceof Anthropic.PermissionDeniedError) throw new ModelError('This API key isn\'t allowed to use that model.', 'model_auth');
          if (e instanceof Anthropic.NotFoundError) throw new ModelError(`Anthropic doesn't know the model "${m.model}".`, 'model_not_found');
          if (e instanceof Anthropic.RateLimitError) throw new ModelError('Anthropic says you\'ve hit a rate or spending limit. Try again shortly.', 'model_rate_limited');
          if (e instanceof Anthropic.BadRequestError) throw new ModelError(`Anthropic turned the request down: ${e.message}`, 'model_bad_request');
          if (e instanceof Anthropic.APIError) throw new ModelError(`Anthropic had a problem (${e.status ?? 'no status'}). Try again in a moment.`);
          // Anything else is a tool input the SDK couldn't parse: ask again, a couple of times.
          if (attempt >= 2) throw new ModelError('The model kept sending a tool call that couldn\'t be read.');
        }
      }
      const cacheRead = message.usage.cache_read_input_tokens ?? 0, cacheWrite = message.usage.cache_creation_input_tokens ?? 0;
      const usage = { input: (message.usage.input_tokens ?? 0) + cacheRead + cacheWrite, output: message.usage.output_tokens ?? 0, cacheRead, cacheWrite };
      const text = message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const uses = message.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
      const assistant = { role: 'assistant', content: message.content };
      if (message.stop_reason === 'refusal') return { message: assistant, text, calls: [], stop: 'stopped', stopNote: 'The model declined to continue.', usage };
      if (message.stop_reason === 'max_tokens') return { message: assistant, text, calls: [], stop: 'stopped', stopNote: uses.length ? 'The model ran out of room mid-action, so nothing was run.' : 'The model ran out of room.', usage };
      if (message.stop_reason === 'pause_turn') return { message: assistant, text, calls: [], stop: 'tools', usage };
      if (!uses.length) return { message: assistant, text, calls: [], stop: 'end', usage };
      const calls = uses.map((u) => {
        const spec = tools.find((t) => t.name === u.name);
        const invalid = !spec ? `There's no tool called ${u.name}` : checkInput(spec.inputSchema, u.input) ?? undefined;
        return { id: u.id, name: u.name, input: u.input, ...(invalid ? { invalid } : {}) };
      });
      return { message: assistant, text, calls, stop: 'tools', usage };
    },
  };
}

// ── OpenAI-compatible services ───────────────────────────────────────
type OaMessage = { role: string; content?: unknown; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; tool_call_id?: string };

export function openaiAdapter(m: AiModelDoc, apiKey: string): Adapter {
  async function expand(history: unknown[]) {
    const out: OaMessage[] = [];
    for (const msg of history as OaMessage[]) {
      if (!Array.isArray(msg.content)) { out.push(msg); continue; }
      const content = [];
      for (const b of msg.content as unknown[]) {
        if (!isLdFile(b)) { content.push(b); continue; }
        const f = await fileBytes(b.fileId);
        if (f && f.text !== null) content.push({ type: 'text', text: `The file ${f.name}:\n\n${f.text}` });
        else if (f && f.type.startsWith('image/')) content.push({ type: 'image_url', image_url: { url: `data:${f.type};base64,${f.base64}` } });
        else content.push({ type: 'text', text: f ? `(A ${f.type === 'application/pdf' ? 'PDF' : f.type} page this kind of model can't read.)` : '(A page that has since been deleted.)' });
      }
      out.push({ ...msg, content });
    }
    return out;
  }

  return {
    userMessage: (text, fileIds) => ({ role: 'user', content: [{ type: 'text', text }, ...fileIds.map((fileId) => ({ type: 'ld_file', fileId }))] }),
    toolResults: (outcomes) => outcomes.map((o) => ({ role: 'tool', tool_call_id: o.id, content: o.isError ? `Error: ${o.content}` : o.content })),
    async turn(history, tools, system, onText) {
      let res: Response;
      try {
        res = await fetch(`${m.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: m.model, stream: true, stream_options: { include_usage: true }, max_tokens: 16000,
            messages: [{ role: 'system', content: system }, ...(await expand(history))],
            tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
          }),
          signal: AbortSignal.timeout(300_000),
        });
      } catch {
        throw new ModelError(`Couldn't reach ${new URL(m.baseUrl!).host}. Check the address in Settings → AI models.`);
      }
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        const msg = (() => { try { const j = JSON.parse(body); return j.error?.message || j.message || body; } catch { return body; } })();
        if (res.status === 401 || res.status === 403) throw new ModelError(`${new URL(m.baseUrl!).host} didn't accept the API key.`, 'model_auth');
        if (res.status === 404) throw new ModelError(`${new URL(m.baseUrl!).host} doesn't know the model "${m.model}".`, 'model_not_found');
        if (res.status === 429) throw new ModelError(`${new URL(m.baseUrl!).host} says you've hit a rate or spending limit.`, 'model_rate_limited');
        throw new ModelError(`${new URL(m.baseUrl!).host} answered ${res.status}: ${String(msg).slice(0, 300)}`);
      }

      let text = '', finish = '';
      const usage = { input: 0, output: 0 };
      const acc = new Map<number, { id: string; name: string; args: string }>();
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let j: { choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
          try { j = JSON.parse(data); } catch { continue; }
          if (j.usage) { usage.input = j.usage.prompt_tokens ?? usage.input; usage.output = j.usage.completion_tokens ?? usage.output; }
          const c = j.choices?.[0];
          if (!c) continue;
          if (c.delta?.content) { text += c.delta.content; onText(c.delta.content); }
          for (const tc of c.delta?.tool_calls ?? []) {
            const cur = acc.get(tc.index) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            acc.set(tc.index, cur);
          }
          if (c.finish_reason) finish = c.finish_reason;
        }
      }

      const raw = [...acc.entries()].sort(([a], [b]) => a - b).map(([i, t]) => ({ ...t, id: t.id || `call_${i}` }));
      const message: OaMessage = { role: 'assistant', content: text || null, ...(raw.length ? { tool_calls: raw.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.args || '{}' } })) } : {}) };
      if (finish === 'content_filter') return { message, text, calls: [], stop: 'stopped', stopNote: 'The service filtered the reply.', usage };
      if (finish === 'length') return { message, text, calls: [], stop: 'stopped', stopNote: raw.length ? 'The model ran out of room mid-action, so nothing was run.' : 'The model ran out of room.', usage };
      if (!raw.length) return { message, text, calls: [], stop: 'end', usage };
      const calls = raw.map((t) => {
        let input: unknown = null, invalid: string | undefined;
        try { input = JSON.parse(t.args || '{}'); } catch { invalid = `The tool input wasn't valid JSON: ${t.args.slice(0, 200)}`; }
        const spec = tools.find((s) => s.name === t.name);
        if (!invalid) invalid = !spec ? `There's no tool called ${t.name}` : checkInput(spec.inputSchema, input) ?? undefined;
        return { id: t.id, name: t.name, input, ...(invalid ? { invalid } : {}) };
      });
      return { message, text, calls, stop: 'tools', usage };
    },
  };
}

export const adapterFor = (m: AiModelDoc, apiKey: string) => (m.provider === 'anthropic' ? anthropicAdapter(m, apiKey) : openaiAdapter(m, apiKey));
