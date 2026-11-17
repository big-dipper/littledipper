/**
 * How the owner wants their assistants to work: standing instructions every model follows (plus extra instructions
 * per model, kept on the model), and their own saved prompts. One document, encrypted: instructions often say
 * personal things ("I'm paying off debt").
 */
import { decrypt, encrypt, newId } from '../crypto.js';
import { ctx } from '../ctx.js';
import { bad } from '../auth.js';

export type Prompt = { id: string; text: string };
export type AiSettings = { instructions: string; prompts: Prompt[] };
type Doc = { _id: 'settings'; enc: string; updatedAt: string };

const MAX_INSTRUCTIONS = 4000;
const MAX_PROMPTS = 40;

export async function getSettings(): Promise<AiSettings> {
  const d = await ctx.store.get<Doc>('aiSettings', 'settings');
  if (!d) return { instructions: '', prompts: [] };
  return JSON.parse(decrypt(ctx.keys.masterKey, d.enc)) as AiSettings;
}

export const checkInstructions = (v: unknown) => {
  const s = String(v ?? '').trim();
  if (s.length > MAX_INSTRUCTIONS) throw bad('too_long', `Instructions can be up to ${MAX_INSTRUCTIONS} characters`);
  return s;
};

/** Change instructions and/or prompts. Prompts keep their ids when sent back; new ones get one. */
export async function saveSettings(b: { instructions?: unknown; prompts?: unknown }) {
  const cur = await getSettings();
  const next: AiSettings = { ...cur };
  if (b.instructions !== undefined) next.instructions = checkInstructions(b.instructions);
  if (b.prompts !== undefined) {
    if (!Array.isArray(b.prompts)) throw bad('invalid_value', 'prompts: a list');
    if (b.prompts.length > MAX_PROMPTS) throw bad('too_many', `Up to ${MAX_PROMPTS} prompts`);
    next.prompts = b.prompts.map((p) => {
      const o = (typeof p === 'string' ? { text: p } : p) as Partial<Prompt>;
      const text = String(o.text ?? '').trim().slice(0, 2000);
      if (!text) throw bad('invalid_value', 'A prompt can’t be empty');
      return { id: typeof o.id === 'string' && o.id.startsWith('prm_') ? o.id : newId('prm'), text };
    });
  }
  const doc: Doc = { _id: 'settings', enc: encrypt(ctx.keys.masterKey, JSON.stringify(next)), updatedAt: new Date().toISOString() };
  if (await ctx.store.get('aiSettings', 'settings')) await ctx.store.update('aiSettings', 'settings', { enc: doc.enc, updatedAt: doc.updatedAt });
  else await ctx.store.insert('aiSettings', doc);
  return next;
}
