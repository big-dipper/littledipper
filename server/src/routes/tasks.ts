/** Tasks: yours, the ones you ask of people, and the ones people ask of you. The stored form is ordinary records. */
import type { FastifyInstance } from 'fastify';
import { ctx } from '../ctx.js';
import { bad, notFound, requireOwner } from '../auth.js';
import { getDomain, partyName, plainData, recordOut, recordsOf, type RecordDoc } from '../domains/records.js';
import { createRecord } from './domains.js';
import { answerRequest, askIfConnected, setDone, waitingRequests } from '../tasks.js';

const READ = ['tasks:read', 'records:read'];
const WRITE = ['tasks:write', 'records:write'];

/** A task as the action bar shows it: who it's for or from by name, and where the asking stands. */
async function taskOut(r: RecordDoc) {
  const d = (await getDomain('tasks'))!;
  const t = plainData(r);
  return {
    ...recordOut(d, r),
    title: String(t.title), due: (t.due as string) ?? null, done: t.done === true, doneAt: (t.doneAt as string) ?? null,
    who: typeof t.who === 'string' ? { id: t.who, name: partyName(t.who) } : null,
    from: typeof t.from === 'string' ? { id: t.from, name: partyName(t.from) } : null,
    answer: (t.answer as 'asked' | 'accepted' | 'not_now') ?? null,
  };
}

export default async function taskRoutes(app: FastifyInstance) {
  /** Open tasks (soonest first, undated last), then the ones done in the last week. */
  app.get('/api/tasks', async (req) => {
    await requireOwner(req, READ);
    const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const all = await Promise.all((await recordsOf('tasks')).map(taskOut));
    const open = all.filter((t) => !t.done).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.createdAt.localeCompare(b.createdAt));
    const done = all.filter((t) => t.done && (t.doneAt ?? '') >= weekAgo).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
    return { open, done };
  });

  /** A new task. With `who` set to someone connected, they're asked in your conversation with them. */
  app.post('/api/tasks', async (req, reply) => {
    const p = await requireOwner(req, WRITE);
    const b = (req.body || {}) as { title?: string; due?: string | null; who?: string | null };
    if (!String(b.title ?? '').trim()) throw bad('required', 'What needs doing?');
    const out = await createRecord((await getDomain('tasks'))!, { data: { title: String(b.title).trim(), due: b.due || undefined, who: b.who || undefined } }, { type: 'owner', id: p.key._id }, p.isSession ? 'You' : p.key.name);
    const rec = (await ctx.store.get<RecordDoc>('records', out.id))!;
    const asked = await askIfConnected(rec);
    reply.code(201);
    return { ...(await taskOut((await ctx.store.get<RecordDoc>('records', out.id))!)), asked };
  });

  app.post('/api/tasks/:id/done', async (req) => {
    await requireOwner(req, WRITE);
    const rec = await ctx.store.get<RecordDoc>('records', (req.params as { id: string }).id);
    if (!rec || rec.domain !== 'tasks') throw notFound('task_not_found');
    await setDone(rec, (req.body as { done?: boolean } | undefined)?.done !== false);
    return taskOut((await ctx.store.get<RecordDoc>('records', rec._id))!);
  });

  /** What people have asked of you and you haven't answered yet. */
  app.get('/api/tasks/requests', async (req) => {
    await requireOwner(req, READ);
    return { items: await waitingRequests() };
  });

  app.post('/api/tasks/requests/:messageId', async (req) => {
    const p = await requireOwner(req, WRITE);
    const answer = (req.body as { answer?: string } | undefined)?.answer;
    if (answer !== 'accepted' && answer !== 'not_now') throw bad('invalid_value', 'answer: accepted or not_now');
    const r = await answerRequest((req.params as { messageId: string }).messageId, answer, { type: 'owner', id: p.key._id });
    if (!r) throw notFound('request_not_found');
    return r;
  });
}
