/**
 * The owner's AI models: Claude, or any service that speaks the OpenAI-compatible chat API (open-weight models on
 * Together, Fireworks, OpenRouter, Hugging Face, a cloud account…). The owner brings their own API key; Little Dipper
 * calls the model itself, from the node, and pays nothing and sees nothing on anyone's behalf.
 *
 * Each model is an ordinary assistant: a party with a share (what it sees, whether it suggests or makes changes) and
 * a key. So everything the owner already has for assistants applies unchanged: Review, undo, the activity log, and
 * ending its access on its page. Its key's secret is kept here, encrypted, because the node uses it on the model's
 * behalf; the provider's API key is encrypted too and never leaves the node except to that provider.
 */
import { bad, HttpError, issueKey, notFound, type ApiKeyDoc } from '../auth.js';
import { decrypt, encrypt, newId } from '../crypto.js';
import { ctx } from '../ctx.js';
import type { PartyDoc } from '../federation.js';
import { setLiveShare } from '../shares.js';
import { checkInstructions } from './settings.js';

export type Provider = 'anthropic' | 'openai';
export const PROVIDERS: { id: Provider; label: string; hint: string }[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)', hint: 'An API key from console.anthropic.com. Billed by Anthropic per use.' },
  { id: 'openai', label: 'Another service (OpenAI-compatible)', hint: 'Most services that run open-weight models: give their API address, a model name and a key.' },
];

export type AiModelDoc = {
  _id: string;
  label: string;
  provider: Provider;
  /** OpenAI-compatible services only, e.g. https://openrouter.ai/api/v1 */
  baseUrl: string | null;
  model: string;
  apiKeyEnc: string;
  partyId: string;
  /** The assistant key the node uses for this model's tool calls (encrypted). */
  keyEnc: string;
  keyId: string;
  /** Extra standing instructions for this model only (encrypted), on top of the ones every model follows. */
  instructionsEnc?: string;
  createdAt: string;
  updatedAt: string;
};

const now = () => new Date().toISOString();
const keyHint = (k: string) => (k.length > 8 ? `…${k.slice(-4)}` : '…');

/** As the API shows it: never the API key, never the assistant key. */
/** This model's own standing instructions, in the clear (the owner's, for the owner). */
export const modelInstructions = (m: AiModelDoc) => (m.instructionsEnc ? decrypt(ctx.keys.masterKey, m.instructionsEnc) : '');

export async function modelOut(m: AiModelDoc) {
  const party = await ctx.store.get<PartyDoc>('parties', m.partyId);
  return {
    id: m._id, label: m.label, provider: m.provider, baseUrl: m.baseUrl, model: m.model,
    apiKey: keyHint(decrypt(ctx.keys.masterKey, m.apiKeyEnc)),
    instructions: modelInstructions(m),
    assistant: party ? { id: party._id, name: party.name } : null,
    createdAt: m.createdAt, updatedAt: m.updatedAt,
  };
}

function checkInput(b: Record<string, unknown>, partial = false) {
  const out: Partial<Pick<AiModelDoc, 'label' | 'provider' | 'baseUrl' | 'model'>> & { apiKey?: string } = {};
  if (!partial || b.provider !== undefined) {
    if (!PROVIDERS.some((p) => p.id === b.provider)) throw bad('invalid_value', `provider: ${PROVIDERS.map((p) => p.id).join(' or ')}`);
    out.provider = b.provider as Provider;
  }
  if (!partial || b.model !== undefined) {
    const model = String(b.model ?? '').trim();
    if (!model || model.length > 200) throw bad('invalid_value', 'model: the model\'s name at the service, e.g. claude-opus-5-5');
    out.model = model;
  }
  if (b.label !== undefined || !partial) {
    const label = String(b.label ?? '').trim().slice(0, 80);
    out.label = label || String(out.model ?? '');
  }
  if (b.baseUrl !== undefined) {
    const u = String(b.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (u) {
      let url: URL;
      try { url = new URL(u); } catch { throw bad('invalid_value', 'baseUrl: the service\'s API address, e.g. https://openrouter.ai/api/v1'); }
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw bad('invalid_value', 'baseUrl must use https');
    }
    out.baseUrl = u || null;
  }
  if (b.apiKey !== undefined || !partial) {
    const k = String(b.apiKey ?? '').trim();
    if (!k || k.length > 500) throw bad('invalid_value', 'apiKey: the key from the service');
    out.apiKey = k;
  }
  return out;
}

/** Add a model. It becomes an assistant that sees everything except secret details and suggests changes for the owner's OK. */
export async function addModel(b: Record<string, unknown>) {
  const v = checkInput(b);
  if (v.provider === 'openai' && !v.baseUrl) throw bad('invalid_value', 'baseUrl: the service\'s API address, e.g. https://openrouter.ai/api/v1');
  const { assistantParty } = await import('../routes/oauth.js');
  const party = await assistantParty(`${v.label} (in Little Dipper)`);
  // A sensible start the owner changes on the assistant's page: everything but secrets, changes wait for them.
  await setLiveShare(party._id, { everything: { includeSecret: false }, basic: true, categories: [], lines: [], entries: [], write: 'suggest', expiresAt: null });
  for (const old of await ctx.store.find<ApiKeyDoc>('apiKeys', { kind: 'app', contactId: party._id })) {
    if (!old.revokedAt) await ctx.store.update('apiKeys', old._id, { revokedAt: now() }); // one key per relationship
  }
  const { secret, doc } = await issueKey({ kind: 'app', name: party.name, scopes: [], contactId: party._id });
  const m: AiModelDoc = {
    _id: newId('aim'), label: v.label!, provider: v.provider!, baseUrl: v.provider === 'openai' ? v.baseUrl ?? null : null, model: v.model!,
    apiKeyEnc: encrypt(ctx.keys.masterKey, v.apiKey!), partyId: party._id, keyEnc: encrypt(ctx.keys.masterKey, secret), keyId: doc._id,
    createdAt: now(), updatedAt: now(),
  };
  await ctx.store.insert('aiModels', m);
  return m;
}

export async function updateModel(id: string, b: Record<string, unknown>) {
  const m = await getModel(id);
  const v = checkInput(b, true);
  const patch: Record<string, unknown> = { updatedAt: now() };
  if (v.label) patch.label = v.label;
  if (v.provider) patch.provider = v.provider;
  if (v.model) patch.model = v.model;
  if (v.baseUrl !== undefined) patch.baseUrl = v.baseUrl;
  if (v.apiKey) patch.apiKeyEnc = encrypt(ctx.keys.masterKey, v.apiKey);
  if (b.instructions !== undefined) {
    const t = checkInstructions(b.instructions);
    patch.instructionsEnc = t ? encrypt(ctx.keys.masterKey, t) : undefined;
  }
  if ((v.provider ?? m.provider) === 'openai' && !(v.baseUrl !== undefined ? v.baseUrl : m.baseUrl)) throw bad('invalid_value', 'baseUrl is needed for this kind of service');
  await ctx.store.update('aiModels', id, patch);
  return (await ctx.store.get<AiModelDoc>('aiModels', id))!;
}

/** Remove a model: its key ends at once. Its conversations and its party (with its history) stay until the owner removes them. */
export async function removeModel(id: string) {
  const m = await getModel(id);
  await ctx.store.update('apiKeys', m.keyId, { revokedAt: now() });
  await ctx.store.remove('aiModels', id);
  return m;
}

export async function getModel(id: string) {
  const m = await ctx.store.get<AiModelDoc>('aiModels', id);
  if (!m) throw notFound('model_not_found');
  return m;
}

export async function listModels() {
  return (await ctx.store.find<AiModelDoc>('aiModels', {})).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** What the node needs to talk to the model and act for it. Never leaves the server. */
export async function secretsOf(m: AiModelDoc) {
  const key = await ctx.store.get<ApiKeyDoc>('apiKeys', m.keyId);
  if (!key || key.revokedAt) throw new HttpError(409, 'assistant_ended', `${m.label}'s access has ended. Remove it and add it again to use it.`);
  return { apiKey: decrypt(ctx.keys.masterKey, m.apiKeyEnc), assistantKey: decrypt(ctx.keys.masterKey, m.keyEnc) };
}
