/**
 * Tasks between people. A task you ask of someone connected travels as messages over the same secure channel as
 * chat, so it's part of your conversation with them on both nodes:
 *
 *   task.assign  { taskId, title, due }        you → them   "Maya asked you to: Test software"
 *   task.reply   { taskId, answer }            them → you   accepted | not_now (never "declined")
 *   task.done    { taskId, done }              them → you   when they tick it off (or untick it)
 *
 * taskId is always the asker's record id. The person asked keeps their own task (with `from` and `ref`), so it's
 * theirs to edit; only the answer and done state travel back.
 */
import { ctx } from './ctx.js';
import { audit } from './audit.js';
import { linkFor } from './contacts.js';
import { getDomain, plainData, partyName, type RecordDoc } from './domains/records.js';
import { queueMessage, type MessageDoc } from './messages.js';
import type { LinkDoc, PartyDoc } from './federation.js';

export const TASK_KINDS = ['task.assign', 'task.reply', 'task.done'] as const;
const system = { type: 'system' as const, id: 'node' };
const today = () => new Date().toISOString().slice(0, 10);

const tasksDomain = async () => (await getDomain('tasks'))!;
const taskRecord = async (id: string) => {
  const r = await ctx.store.get<RecordDoc>('records', id);
  return r && r.domain === 'tasks' ? r : null;
};

/** Ask the person a task is for, if they're on Little Dipper and connected. Returns whether they were asked. */
export async function askIfConnected(rec: RecordDoc) {
  const t = plainData(rec);
  const party = typeof t.who === 'string' ? await ctx.store.get<PartyDoc>('parties', t.who) : null;
  const link = party ? await linkFor(party) : null;
  if (!party || link?.status !== 'active' || t.from) return false;
  await queueMessage(party, 'task.assign', { taskId: rec._id, title: t.title, due: t.due ?? null }, null);
  await setParts(rec, { answer: 'asked' });
  return true;
}

/** Tick a task off (or back on). If someone asked it of you, they hear about it in your conversation. */
export async function setDone(rec: RecordDoc, done: boolean) {
  await setParts(rec, { done, doneAt: done ? today() : null });
  const t = plainData(rec);
  const asker = typeof t.from === 'string' ? await ctx.store.get<PartyDoc>('parties', t.from) : null;
  if (asker && typeof t.ref === 'string' && (await linkFor(asker))?.status === 'active') {
    await queueMessage(asker, 'task.done', { taskId: t.ref, done }, null);
  }
}

/** Requests waiting for your answer: task.assign messages you haven't replied to. */
export async function waitingRequests() {
  const asks = await ctx.store.find<MessageDoc>('messages', { kind: 'task.assign', direction: 'in' }, { sort: { createdAt: -1 } });
  const replied = new Set((await ctx.store.find<MessageDoc>('messages', { kind: 'task.reply', direction: 'out' })).map((m) => m.inReplyTo));
  const { messageOut } = await import('./messages.js');
  return asks.filter((m) => !replied.has(m._id)).map((m) => {
    const body = messageOut(m).body as { taskId: string; title: string; due: string | null };
    return { messageId: m._id, party: { id: m.contactId, name: partyName(m.contactId) }, title: body.title, due: body.due, at: m.createdAt };
  });
}

/** Accept (it becomes your task, linked back to theirs) or say not now. Either way they see your answer. */
export async function answerRequest(messageId: string, answer: 'accepted' | 'not_now', by: { type: 'owner'; id: string }) {
  const { messageOut } = await import('./messages.js');
  const m = await ctx.store.get<MessageDoc>('messages', messageId);
  if (!m || m.kind !== 'task.assign' || m.direction !== 'in') return null;
  if (await ctx.store.findOne('messages', { kind: 'task.reply', direction: 'out', inReplyTo: m._id })) return { accepted: false, alreadyAnswered: true };
  const party = await ctx.store.get<PartyDoc>('parties', m.contactId);
  if (!party) return null;
  const body = messageOut(m).body as { taskId: string; title: string; due: string | null };
  await queueMessage(party, 'task.reply', { taskId: body.taskId, answer }, m._id);
  if (answer !== 'accepted') return { accepted: false };
  const { createRecord } = await import('./routes/domains.js');
  const rec = await createRecord(await tasksDomain(), { data: { title: body.title, due: body.due ?? undefined, from: party._id, ref: body.taskId } }, by, 'You');
  return { accepted: true, task: rec };
}

/** A task message from a connected peer: their answer, or that they finished. The message itself is already stored. */
export async function onTaskMessage(link: LinkDoc, kind: string, body: unknown) {
  const b = (body ?? {}) as { taskId?: string; title?: string; answer?: string; done?: boolean };
  const name = partyName(link.contactId);
  if (kind === 'task.assign') {
    await audit({ actor: { type: 'peer', id: link.peerNodeId }, action: 'task.asked', resource: `parties/${link.contactId}`, text: `${name} asked you to: ${String(b.title ?? '').slice(0, 200)}`, tone: 'request' });
    return;
  }
  // Replies and done only ever touch a task you asked of this very person.
  const rec = typeof b.taskId === 'string' ? await taskRecord(b.taskId) : null;
  if (!rec || plainData(rec).who !== link.contactId) return;
  const title = String(plainData(rec).title);
  if (kind === 'task.reply' && (b.answer === 'accepted' || b.answer === 'not_now')) {
    await setParts(rec, { answer: b.answer });
    await audit({ actor: { type: 'peer', id: link.peerNodeId }, action: 'task.answer', resource: `tasks/${rec._id}`, text: b.answer === 'accepted' ? `${name} is taking care of: ${title}` : `${name} can’t take this one: ${title}`, tone: 'peer' });
  }
  if (kind === 'task.done' && typeof b.done === 'boolean') {
    await setParts(rec, { done: b.done, doneAt: b.done ? today() : null });
    if (b.done) await audit({ actor: { type: 'peer', id: link.peerNodeId }, action: 'task.done', resource: `tasks/${rec._id}`, text: `${name} finished: ${title}`, tone: 'peer' });
  }
}

/** Change a few parts of a task as Little Dipper itself (state that comes from the conversation, not typing). */
async function setParts(rec: RecordDoc, data: Record<string, unknown>) {
  const { updateRecord } = await import('./routes/domains.js');
  const fresh = (await taskRecord(rec._id)) ?? rec;
  await updateRecord(await tasksDomain(), fresh, { data }, system, 'Little Dipper');
}
