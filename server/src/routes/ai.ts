/**
 * The in-app assistant's API: the owner's AI models (ai/models.ts) and conversations with them (ai/engine.ts).
 * All of it is the owner's alone, signed in: no key, however trusted, can add a model, read a conversation or talk
 * to a model on the owner's behalf.
 *
 * Sending a message answers with a stream (text/event-stream): each event is one JSON line, `data: {...}`.
 */
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth.js';
import { audit, ownerActor } from '../audit.js';
import { ctx } from '../ctx.js';
import { chatOut, chatSummary, createChat, getChat, runTurn, type ChatDoc, type Event } from '../ai/engine.js';
import { addModel, getModel, listModels, modelOut, PROVIDERS, removeModel, updateModel } from '../ai/models.js';
import { getSettings, saveSettings } from '../ai/settings.js';

export default async function aiRoutes(app: FastifyInstance) {
  app.get('/api/ai/providers', async (req) => {
    await requireSession(req);
    return { providers: PROVIDERS };
  });

  app.get('/api/ai/models', async (req) => {
    await requireSession(req);
    return { models: await Promise.all((await listModels()).map(modelOut)) };
  });

  app.post('/api/ai/models', async (req, reply) => {
    const p = await requireSession(req);
    const m = await addModel((req.body || {}) as Record<string, unknown>);
    await audit({ actor: ownerActor(p.key._id), action: 'ai.model.add', resource: `aiModels/${m._id}`, text: `You added the AI model ${m.label}. It suggests changes for your OK until you choose otherwise.`, tone: 'owner' });
    reply.code(201);
    return modelOut(m);
  });

  app.patch('/api/ai/models/:id', async (req) => {
    await requireSession(req);
    return modelOut(await updateModel((req.params as { id: string }).id, (req.body || {}) as Record<string, unknown>));
  });

  app.delete('/api/ai/models/:id', async (req) => {
    const p = await requireSession(req);
    const m = await removeModel((req.params as { id: string }).id);
    await audit({ actor: ownerActor(p.key._id), action: 'ai.model.remove', resource: `aiModels/${m._id}`, text: `You removed the AI model ${m.label}. Its access ended.`, tone: 'owner' });
    return { deleted: true };
  });

  /** Standing instructions every model follows, and the owner's saved prompts. */
  app.get('/api/ai/settings', async (req) => {
    await requireSession(req);
    return getSettings();
  });

  app.put('/api/ai/settings', async (req) => {
    await requireSession(req);
    return saveSettings((req.body || {}) as { instructions?: unknown; prompts?: unknown });
  });

  app.get('/api/ai/chats', async (req) => {
    await requireSession(req);
    const all = await ctx.store.find<ChatDoc>('chats', {});
    return { chats: all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100).map(chatSummary) };
  });

  app.post('/api/ai/chats', async (req, reply) => {
    await requireSession(req);
    const { model } = (req.body || {}) as { model?: string };
    await getModel(String(model || ''));
    reply.code(201);
    return chatOut(await createChat(String(model)));
  });

  app.get('/api/ai/chats/:id', async (req) => {
    await requireSession(req);
    return chatOut(await getChat((req.params as { id: string }).id));
  });

  app.delete('/api/ai/chats/:id', async (req) => {
    await requireSession(req);
    const c = await getChat((req.params as { id: string }).id);
    await ctx.store.remove('chats', c._id);
    return { deleted: true };
  });

  /** Say something: { text, files?: [fileId], context? }. Answers as a stream of events, ending with done or error. */
  app.post('/api/ai/chats/:id/messages', { bodyLimit: 256 * 1024 }, async (req, reply) => {
    await requireSession(req);
    const { id } = req.params as { id: string };
    const b = (req.body || {}) as { text?: unknown; files?: unknown; context?: unknown };
    const chat = await getChat(id); // 404 before the stream starts
    void chat;
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const emit = (e: Event) => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`); };
    try {
      await runTurn(app, id, {
        text: String(b.text ?? ''),
        fileIds: Array.isArray(b.files) ? b.files.map(String) : [],
        context: typeof b.context === 'string' ? b.context : undefined,
      }, emit);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      emit({ type: 'error', code: err.code || 'internal', message: err.message || 'Something went wrong on this Little Dipper.' });
    }
    reply.raw.end();
  });
}
