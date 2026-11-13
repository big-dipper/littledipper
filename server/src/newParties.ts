/**
 * People and organisations that arrive with an assistant's suggestion (BRY-114). An entry points to parties, so an
 * assistant suggesting a debt with a collector the owner hasn't added yet brings the collector along:
 *
 *   { data: { collector: "new:bonneville", ... }, newParties: [{ ref: "bonneville", type: "organisation", name: "Bonneville Collections" }] }
 *
 * Nothing is created until the owner approves: approving creates the parties and the entry together, turning it down
 * creates nothing. A name that already matches someone on the node (same kind, same name) uses them instead.
 */
import { ctx } from './ctx.js';
import { newId } from './crypto.js';
import { bad } from './auth.js';
import type { PartyDoc } from './federation.js';

export type NewParty = { ref: string; type: 'person' | 'organisation'; name: string };
export const NEW = 'new:';
const MAX = 10;

/** The list as sent, checked: at most ten, each with a short ref, a kind and a name. */
export function checkNewParties(v: unknown): NewParty[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX) throw bad('invalid_value', `newParties: a list of at most ${MAX}`);
  const seen = new Set<string>();
  return v.map((x) => {
    const p = (x ?? {}) as Partial<NewParty>;
    const ref = String(p.ref ?? '').trim();
    const name = String(p.name ?? '').trim().slice(0, 200);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(ref)) throw bad('invalid_value', 'newParties: each needs a ref of letters, digits, - or _');
    if (seen.has(ref)) throw bad('invalid_value', `newParties: ${ref} twice`);
    seen.add(ref);
    if (p.type !== 'person' && p.type !== 'organisation') throw bad('invalid_value', 'newParties: type is person or organisation');
    if (!name) throw bad('invalid_value', 'newParties: each needs a name');
    return { ref, type: p.type, name };
  });
}

/** Every "new:<ref>" in the data, nested lists included. */
export function refsIn(data: Record<string, unknown> | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith(NEW)) out.add(v.slice(NEW.length));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(data);
  return out;
}

/** Replace "new:<ref>" with party ids, everywhere in the data. */
export function substitute(data: Record<string, unknown> | undefined, ids: Map<string, string>) {
  const swap = (v: unknown): unknown =>
    typeof v === 'string' && v.startsWith(NEW) && ids.has(v.slice(NEW.length)) ? ids.get(v.slice(NEW.length))
      : Array.isArray(v) ? v.map(swap) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v;
  return data ? (swap(data) as Record<string, unknown>) : data;
}

/** Someone already on the node with this kind and name, if any. */
export async function existingParty(p: NewParty) {
  const name = p.name.toLowerCase();
  return (await ctx.store.find<PartyDoc>('parties', { type: p.type })).find((x) => x.name.trim().toLowerCase() === name) ?? null;
}

/** Create (or reuse) every party in the list; returns ref → id. */
export async function createParties(list: NewParty[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const p of list) {
    const found = await existingParty(p);
    if (found) { ids.set(p.ref, found._id); continue; }
    const c: PartyDoc = {
      _id: newId('pty'), type: p.type, name: p.name, methods: [], notes: '', affiliations: [], node: null, sharedIn: [], sharedInFetchedAt: null, createdAt: new Date().toISOString(),
    };
    await ctx.store.insert('parties', c);
    ids.set(p.ref, c._id);
  }
  return ids;
}
