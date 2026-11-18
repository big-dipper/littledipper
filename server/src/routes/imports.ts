/**
 * Bringing people in from a contacts file (imports/contacts.ts). The owner's alone, signed in:
 *
 *   POST /api/imports/contacts     the file (text/vcard) → what's in it, and ready-made ways to import it
 *   POST /api/imports/:id/plan     { rules } → what would happen, in plain words
 *   POST /api/imports/:id/rules    { text, model } → rules an assistant wrote from the owner's words, and their plan
 *   POST /api/imports/:id/run      { rules } → the import
 *   GET  /api/imports              past imports
 *   POST /api/imports/:id/undo     take an import back
 */
import type { FastifyInstance } from 'fastify';
import { requireSession, bad } from '../auth.js';
import { audit, ownerActor } from '../audit.js';
import { ctx } from '../ctx.js';
import { getModel, secretsOf } from '../ai/models.js';
import { adapterFor, ModelError } from '../ai/providers.js';
import { checkRules, heldFile, holdFile, importOut, parseRulesReply, planFor, rulesPrompt, runImport, summarize, undoImport, type ImportDoc } from '../imports/contacts.js';

const MAX_BYTES = 20 * 1024 * 1024;

export default async function importRoutes(app: FastifyInstance) {
  app.addContentTypeParser(['text/vcard', 'text/x-vcard', 'text/directory'], { parseAs: 'buffer', bodyLimit: MAX_BYTES }, (_req, body, done) => done(null, body));

  app.post('/api/imports/contacts', { bodyLimit: MAX_BYTES }, async (req, reply) => {
    await requireSession(req);
    if (!Buffer.isBuffer(req.body)) throw bad('unsupported_type', 'Send a contacts file (text/vcard) as the request body');
    const name = String((req.query as { name?: string }).name ?? 'contacts.vcf');
    reply.code(201);
    return holdFile(name, req.body.toString('utf8'));
  });

  app.post('/api/imports/:id/plan', async (req) => {
    await requireSession(req);
    return planFor((req.params as { id: string }).id, checkRules((req.body as { rules?: unknown } | null)?.rules));
  });

  /** The owner says how it should go; their assistant writes the rules from a summary of the file (never the file). */
  app.post('/api/imports/:id/rules', async (req) => {
    await requireSession(req);
    const { id } = req.params as { id: string };
    const b = (req.body || {}) as { text?: unknown; model?: unknown; rules?: unknown };
    const text = String(b.text ?? '').trim().slice(0, 2000);
    if (!text) throw bad('text_required', 'Say how the import should go');
    const h = heldFile(id);
    const m = await getModel(String(b.model ?? ''));
    const { apiKey } = await secretsOf(m);
    const adapter = adapterFor(m, apiKey);
    const system = rulesPrompt(await summarize(h.cards), checkRules(b.rules));
    let reply;
    try {
      reply = await adapter.turn([adapter.userMessage(text, [])], [], system, () => {});
    } catch (e) {
      if (e instanceof ModelError) throw bad(e.code, e.message);
      throw e;
    }
    const { rules, said } = parseRulesReply(reply.text);
    return { said, rules, plan: await planFor(id, rules), usage: reply.usage, model: { id: m._id, label: m.label, model: m.model } };
  });

  app.post('/api/imports/:id/run', async (req, reply) => {
    const p = await requireSession(req);
    const rules = checkRules((req.body as { rules?: unknown } | null)?.rules);
    const doc = await runImport((req.params as { id: string }).id, rules, { type: 'owner', id: p.key._id });
    const c = doc.counts;
    await audit({
      actor: ownerActor(p.key._id), action: 'import.contacts', resource: `imports/${doc._id}`, tone: 'owner',
      text: `You imported ${c.people} ${c.people === 1 ? 'person' : 'people'} from ${doc.name}${c.updated ? `, and added details to ${c.updated} already here` : ''}.`,
    });
    reply.code(201);
    return importOut(doc);
  });

  app.get('/api/imports', async (req) => {
    await requireSession(req);
    const all = await ctx.store.find<ImportDoc>('imports', {});
    return { imports: all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(importOut) };
  });

  app.post('/api/imports/:id/undo', async (req) => {
    const p = await requireSession(req);
    const { id } = req.params as { id: string };
    const by = { type: 'owner' as const, id: p.key._id };
    const r = await undoImport(id, by);
    const doc = await ctx.store.get<ImportDoc>('imports', id);
    await audit({ actor: ownerActor(p.key._id), action: 'import.undo', resource: `imports/${id}`, tone: 'owner', text: `You undid the import of ${doc?.name ?? 'a contacts file'}.` });
    return r;
  });
}
