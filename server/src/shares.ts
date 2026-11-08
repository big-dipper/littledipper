/**
 * Sharing: one concept for everything that leaves the node. Every share answers four questions:
 * who (a party, or anyone with a link, or everyone), what (the basic profile, extra profile lines, whole categories,
 * specific entries, documents), how (live, or a snapshot as it was) and for how long (expiry, revoke).
 *
 * A connected party has one live share: exactly what they get, chosen at connection time and changed on their page.
 * The basic profile is a list of profile lines the owner edits (plus their Little Dipper line, always), not
 * whatever happens to be marked standard. Secret lines and secret parts never travel without an explicit confirm.
 */
import { ctx } from './ctx.js';
import { newId } from './crypto.js';
import type { Doc } from './store/index.js';

export type CategoryShare = { domain: string; scope: 'all' | 'current'; includeSecret: boolean };
export type EntryShare = { id: string; includeSecret: boolean };

export type ShareDoc = Doc & {
  /** Who: one party, anyone holding a link, or everyone (the public page). */
  audience: 'party' | 'link' | 'everyone';
  party: string | null;
  /** Live: they always see the current values. Snapshot: what it was when shared. */
  mode: 'live' | 'snapshot';
  /** The basic profile (the owner's list of lines). */
  basic: boolean;
  /** Extra profile lines, one by one. */
  lines: string[];
  categories: CategoryShare[];
  entries: EntryShare[];
  documents: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The basic profile when the owner hasn't chosen: preferred name, where they live, email (decision 1.3). */
export const DEFAULT_BASIC = ['preferred_name', 'lives_in', 'email'];
/** Every card carries the owner's Little Dipper: the identity each exchange is built on. Can't be removed. */
export const ALWAYS_SHARED = 'little_dipper';

const now = () => new Date().toISOString();
const active = (s: ShareDoc) => !s.revokedAt && (!s.expiresAt || s.expiresAt > now());

/** The live share for a party, if there is one and it's in force. */
export async function liveShareFor(partyId: string): Promise<ShareDoc | null> {
  const s = (await ctx.store.find<ShareDoc>('shares', { party: partyId, mode: 'live' }))[0];
  return s && active(s) ? s : null;
}

export type WhatTheyGet = { basic: boolean; lines: string[]; categories: Record<string, CategoryShare>; entries: EntryShare[] };

/** What a party may read right now. Nothing shared: nothing at all. */
export async function whatTheyGet(partyId: string): Promise<WhatTheyGet> {
  const s = await liveShareFor(partyId);
  if (!s) return { basic: false, lines: [], categories: {}, entries: [] };
  // A category granted whole before it became one-at-a-time is no longer sent.
  const { getDomain } = await import('./domains/records.js');
  const whole = [];
  for (const c of s.categories) if (!(await getDomain(c.domain))?.oneAtATime) whole.push(c);
  return { basic: s.basic, lines: s.lines, categories: Object.fromEntries(whole.map((c) => [c.domain, c])), entries: s.entries };
}

/** Single entries as people read them: id, title and category, for the owner's screens. */
export async function describeEntries(entries: EntryShare[]) {
  const { getDomain, recordOut } = await import('./domains/records.js');
  const out = [];
  for (const e of entries) {
    const r = await ctx.store.get<import('./domains/types.js').RecordDoc>('records', e.id);
    const d = r && (await getDomain(r.domain));
    if (r && d) out.push({ ...e, title: recordOut(d, r).title, domain: d.id, domainLabel: d.label });
  }
  return out;
}

/** Create or change a party's live share. Fields left out stay as they are. */
export async function setLiveShare(partyId: string, patch: Partial<Pick<ShareDoc, 'basic' | 'lines' | 'categories' | 'entries' | 'expiresAt'>>) {
  const existing = (await ctx.store.find<ShareDoc>('shares', { party: partyId, mode: 'live' }))[0];
  if (existing) {
    await ctx.store.update('shares', existing._id, { ...patch, revokedAt: null, updatedAt: now() });
    return (await ctx.store.get<ShareDoc>('shares', existing._id))!;
  }
  const s: ShareDoc = {
    _id: newId('shr'), audience: 'party', party: partyId, mode: 'live', basic: false, lines: [], categories: [], entries: [], documents: [],
    expiresAt: null, revokedAt: null, createdAt: now(), updatedAt: now(), ...patch,
  };
  await ctx.store.insert('shares', s);
  return s;
}

/** Stop sharing with a party (they keep nothing new; their node keeps the last values it fetched). */
export async function endLiveShare(partyId: string) {
  await ctx.store.removeMany('shares', { party: partyId, mode: 'live' });
}

/** Parties whose live share includes this category or an entry in it: who to nudge when it changes. */
export async function partiesSharing(domain: string, recordIds: string[] = []) {
  const out: string[] = [];
  for (const s of await ctx.store.find<ShareDoc>('shares', { mode: 'live' })) {
    if (s.party && active(s) && (s.categories.some((c) => c.domain === domain) || s.entries.some((e) => recordIds.includes(e.id)))) out.push(s.party);
  }
  return out;
}

/** Who someone is to you, asked (optionally) when you connect. Each only suggests extras; nothing is stored as a card. */
export const RELATIONS = ['friend', 'colleague', 'family', 'business', 'other'] as const;
export type Relation = (typeof RELATIONS)[number];
/** A suggestion item: a profile line key, or a category in words: `category:<domain>:<all|current>`. */
export const DEFAULT_SUGGESTIONS: Record<Relation, string[]> = {
  friend: ['phone', 'address'],
  colleague: ['phone', 'category:employment:current'],
  family: ['phone', 'address', 'born'],
  business: ['legal_name', 'mailing_address'],
  other: [],
};

/** What each relationship pre-ticks when you connect: the owner's own choices, or the defaults. */
export async function suggestions(): Promise<Record<Relation, string[]>> {
  const o = await ctx.store.findOne<{ _id: string; suggestions?: Partial<Record<Relation, string[]>> }>('owners', { pending: { $ne: true } });
  return Object.fromEntries(RELATIONS.map((r) => [r, o?.suggestions?.[r] ?? DEFAULT_SUGGESTIONS[r]])) as Record<Relation, string[]>;
}

/** The owner's basic profile: the lines every connection gets by default. */
export async function basicLines(): Promise<string[]> {
  const o = await ctx.store.findOne<{ _id: string; basicProfile?: string[]; pending?: boolean }>('owners', { pending: { $ne: true } });
  return [ALWAYS_SHARED, ...(o?.basicProfile ?? DEFAULT_BASIC).filter((k) => k !== ALWAYS_SHARED)];
}
