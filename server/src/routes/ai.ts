/**
 * The in-app assistant's API: the owner's AI models (ai/models.ts) and conversations with them (ai/engine.ts).
 * All of it is the owner's alone, signed in: no key, however trusted, can add a model, read a conversation or talk
 * to a model on the owner's behalf.
 *
 * Sending a message answers with a stream (text/event-stream): each event is one JSON line, `data: {...}`.
 */
import type { FastifyInstance } from 'fastify';
import { bad, requireSession } from '../auth.js';
import { audit, ownerActor } from '../audit.js';
import { ctx } from '../ctx.js';
import { chatOut, chatSummary, createChat, getChat, runTurn, type ChatDoc, type Event } from '../ai/engine.js';
import { addModel, getModel, listModels, modelOut, PROVIDERS, removeModel, updateModel } from '../ai/models.js';
import { getSettings, saveSettings } from '../ai/settings.js';
import { listServiceModels, ModelError } from '../ai/providers.js';

export default async function aiRoutes(app: FastifyInstance) {
  app.get('/api/ai/providers', async (req) => {
    await requireSession(req);
    return { providers: PROVIDERS };
  });

  /** The models a service offers, to pick from when adding one: { provider, apiKey, baseUrl? }. Nothing is saved. */
  app.post('/api/ai/providers/models', async (req) => {
    await requireSession(req);
    const b = (req.body || {}) as { provider?: unknown; baseUrl?: unknown; apiKey?: unknown };
    const provider = b.provider === 'anthropic' ? 'anthropic' : b.provider === 'openai' ? 'openai' : null;
    if (!provider) throw bad('invalid_value', 'provider: anthropic or openai');
    const apiKey = String(b.apiKey ?? '').trim();
    if (!apiKey || apiKey.length > 500) throw bad('invalid_value', 'apiKey: the key from the service');
    let baseUrl: string | null = null;
    if (provider === 'openai') {
      baseUrl = String(b.baseUrl ?? '').trim().replace(/\/+$/, '');
      let url: URL;
      try { url = new URL(baseUrl); } catch { throw bad('invalid_value', 'baseUrl: the service\'s API address, e.g. https://api.openai.com/v1'); }
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw bad('invalid_value', 'baseUrl must use https');
    }
    try {
      return { models: await listServiceModels(provider, baseUrl, apiKey) };
    } catch (e) {
      if (e instanceof ModelError) throw bad(e.code, e.message);
      throw e;
    }
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
