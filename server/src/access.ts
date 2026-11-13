/**
 * One access model for every party (decided Nov 13, 2026; Linear "Roadmap: one sharing model…"):
 * access = the party's share (what they see) + what they can change + one credential that proves who they are.
 *
 * A credential never carries permissions of its own. An app key bound to a party (an assistant, later a service)
 * is resolved here on every request: its scopes, mode and secret fields are worked out from that party's live
 * share at that moment, so changing the share or ending it takes effect on the very next call.
 *
 * Rules that hold for everyone, whatever the share says:
 * - Running the node is the owner's alone (OWNER_ONLY): no key other than the owner's own session carries these.
 * - What a party can change follows what it can see. Identity changes and secret values always wait for the owner
 *   (enforced where records are written).
 */
import type { ApiKeyDoc } from './auth.js';
import { ctx } from './ctx.js';
import type { CategoryShare, ShareDoc, WriteMode } from './shares.js';

/** Powers that make you the node's owner. Never on any key but the owner's session, never on a share. */
export const OWNER_ONLY = ['admin:*', 'keys:manage', 'owner:write', 'export', 'public:write', 'audit:read'] as const;
export const isOwnerOnly = (s: string) => (OWNER_ONLY as readonly string[]).includes(s);

/** How much of one category a party sees: all of it, only what's current, or just the entries shared one by one. */
export type DomainAccess = { scope: 'all' | 'current' | 'entries'; ids: string[]; includeSecret: boolean };

/** What a party-bound key may see, for routes that filter records and profile lines. */
export type Access = {
  domains: Record<string, DomainAccess>;
  /** Profile lines it may read: the owner's basic profile (if shared) plus extra lines. */
  lines: string[];
  write: WriteMode;
  everything: boolean;
};

const MODE = { none: 'answer', suggest: 'suggest', make: 'make' } as const;

/** What a share lets its party see, category by category. */
export async function accessFromShare(s: ShareDoc | null): Promise<Access> {
  const empty: Access = { domains: {}, lines: [], write: 'none', everything: false };
  if (!s) return empty;
  const { listDomains, getDomain } = await import('./domains/records.js');
  const { basicLines } = await import('./shares.js');
  const domains: Record<string, DomainAccess> = {};
  if (s.everything) {
    for (const d of await listDomains()) domains[d.id] = { scope: 'all', ids: [], includeSecret: s.everything.includeSecret };
  } else {
    for (const c of s.categories as CategoryShare[]) {
      const d = await getDomain(c.domain);
      // One-at-a-time categories (notes, tasks) are never shared whole, only entry by entry.
      if (d && !d.oneAtATime) domains[c.domain] = { scope: c.scope, ids: [], includeSecret: c.includeSecret };
    }
  }
  for (const e of s.entries) {
    const r = await ctx.store.get<{ _id: string; domain: string }>('records', e.id);
    if (!r || domains[r.domain]?.scope === 'all') continue;
    const cur = domains[r.domain];
    if (cur && cur.scope === 'current') { cur.ids.push(e.id); continue; } // current, plus this one (it may have ended)
    domains[r.domain] = { scope: 'entries', ids: [...(cur?.ids ?? []), e.id], includeSecret: (cur?.includeSecret ?? false) || e.includeSecret };
  }
  const lines = s.everything ? (await import('./profile.js')).PROFILE_LINES.map(([k]) => k) : [...new Set([...(s.basic ? await basicLines() : []), ...s.lines])];
  return { domains, lines, write: s.write ?? 'none', everything: !!s.everything };
}

/**
 * An app key bound to a party, made concrete for this request: scopes, assistant mode and secret fields from
 * the party's live share. Keys that aren't bound to a party (the owner's sessions, a developer's raw key) are
 * returned as they are, minus any owner-only power that should never have been on them.
 */
export async function resolveKey(k: ApiKeyDoc): Promise<ApiKeyDoc> {
  if (k.kind !== 'app') return k;
  if (!k.contactId) return { ...k, scopes: k.scopes.filter((s) => !isOwnerOnly(s)) };
  const { liveShareFor } = await import('./shares.js');
  const access = await accessFromShare(await liveShareFor(k.contactId));
  const { getDomain, partSens } = await import('./domains/records.js');
  const verbs = access.write === 'none' ? ['read'] : ['read', 'write'];
  const scopes = new Set<string>();
  const secretFields: string[] = [];
  for (const [id, a] of Object.entries(access.domains)) {
    for (const v of verbs) scopes.add(`${id}:${v}`);
    if (!a.includeSecret) continue;
    const d = await getDomain(id);
    for (const p of d?.parts ?? []) if (d && partSens(d, p) === 'secret') secretFields.push(`${id}.${p.key}`);
  }
  // Only the profile lines it's given: never the account, node status or anything else behind owner:read.
  if (access.lines.length) scopes.add('profile:read');
  // Records name people and organisations: whoever sees records sees those names, and whoever adds records may add them.
  if (Object.keys(access.domains).length) scopes.add('parties:read');
  if (access.write !== 'none') { scopes.add('parties:write'); scopes.add('documents:write'); }
  // Unfiled documents (the inbox) are only for Everything; filed ones follow the categories they're filed on.
  if (access.everything) scopes.add('documents:read');
  return { ...k, scopes: [...scopes], assistant: { mode: MODE[access.write], secretFields }, access };
}

/** Whether a party-bound key may see this record. Keys without `access` (the owner, raw keys) see by scope alone. */
export function canSeeRecord(key: ApiKeyDoc, d: { id: string }, r: { _id: string }, current: boolean) {
  const a = key.access?.domains[d.id];
  if (!key.access) return true;
  if (!a) return false;
  if (a.scope === 'all') return true;
  if (a.ids.includes(r._id)) return true;
  return a.scope === 'current' && current;
}

/** Whether a party-bound key may add new entries to this category: only where it sees more than single entries. */
export function canAddTo(key: ApiKeyDoc, d: { id: string }) {
  const a = key.access?.domains[d.id];
  return !key.access || (!!a && a.scope !== 'entries');
}
