/**
 * Bringing people in from a contacts file. The file is read once and held in memory while the owner decides how
 * the import should go (an hour at most); only what they choose to import is ever stored.
 *
 * How it goes is a set of rules (ImportRules): merge duplicates, skip cards without a name, keep only some labels,
 * what each label means (Family → family, Work → colleague), companies or email domains that mean colleague… The
 * owner picks a ready-made set, adjusts it, or describes what they want in words and their assistant writes the
 * rules (it sees a summary of the file, never the whole of it). The plan is shown before anything happens, and an
 * import is undone in one step.
 *
 * People become parties; how the owner knows them becomes a Relationships entry. People with no relation yet are
 * added to sort later: they're people without a Relationships entry.
 */
import { ctx } from '../ctx.js';
import { bad, HttpError, notFound } from '../auth.js';
import { newId } from '../crypto.js';
import type { PartyDoc } from '../federation.js';
import type { ContactMethod } from '../methods.js';
import { buildRecord, getDomain, recordVersion, unlinkParty, unlinkRecord, partyReferences } from '../domains/records.js';
import type { Actor, RecordDoc } from '../domains/types.js';
import { recordRemoved } from '../documents.js';
import { contactsSharing, nudgePeers } from '../contacts.js';
import { parseVcards, type Card } from './vcard.js';

export const RELATIONS = ['spouse', 'partner', 'child', 'parent', 'sibling', 'grandparent', 'grandchild', 'other_family', 'friend', 'colleague', 'manager', 'mentor', 'reference', 'other'] as const;
export type Relation = (typeof RELATIONS)[number];
const RELATION_PLURAL: Record<Relation, string> = {
  spouse: 'spouse', partner: 'partners', child: 'children', parent: 'parents', sibling: 'siblings', grandparent: 'grandparents', grandchild: 'grandchildren',
  other_family: 'family', friend: 'friends', colleague: 'colleagues', manager: 'managers', mentor: 'mentors', reference: 'references', other: 'other relations',
};

export type ImportRules = {
  /** Combine cards for the same person, and with people already here. */
  merge: boolean;
  /** Leave out cards with no name (just an email or number). */
  skipNoName: boolean;
  /** Leave out cards with an email address and nothing else, the kind email services collect on their own. */
  skipEmailOnly: boolean;
  /** Bring in businesses (cards that are a company, not a person). */
  organisations: boolean;
  /** Add where people work, as organisations they belong to. */
  workplaces: boolean;
  /** Only people with one of these labels (or matching a company rule). null: everyone. */
  only: string[] | null;
  /** What a label means: label (as written) → relation. */
  relations: Record<string, Relation>;
  /** People at a company, or with an email at a domain, and how the owner knows them. */
  companies: { match: string; relation: Relation }[];
  /** People with no relation: added to sort later, or left out. */
  rest: 'add' | 'skip';
};

const LABEL_GUESSES: [RegExp, Relation][] = [
  [/^(family|famille|familia|familie|relatives?|kin)$/i, 'other_family'],
  [/^(parents?|mom|dad|mum)$/i, 'parent'], [/^(siblings?|brothers?|sisters?)$/i, 'sibling'], [/^(kids|children)$/i, 'child'],
  [/friend/i, 'friend'],
  [/^(work|co-?workers?|colleagues?|office|team|job)$/i, 'colleague'],
  [/^mentors?$/i, 'mentor'],
];
const guessRelation = (label: string) => LABEL_GUESSES.find(([re]) => re.test(label.trim()))?.[1] ?? null;

// ── matching people ──────────────────────────────────────────────────

const normName = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/** Names good enough to match on: two words or more ("Sam" alone matches too many). */
const nameKey = (s: string) => { const n = normName(s); return n.includes(' ') ? `n:${n}` : null; };
const methodKeys = (ms: ContactMethod[]) => ms.flatMap((m) => {
  if (m.kind === 'email') return [`e:${String(m.value).toLowerCase()}`];
  if (m.kind === 'phone') return [`p:${String(m.value).split(';')[0]}`];
  return [];
});
const keysOf = (name: string, named: boolean, ms: ContactMethod[]) => [...methodKeys(ms), ...(named ? [nameKey(name)].filter((k): k is string => !!k) : [])];

/** One person (or business) after merging: the cards it came from, and who it is on this node already, if anyone. */
type Person = {
  cards: Card[];
  name: string; named: boolean; type: Card['type'];
  org: string; title: string; methods: ContactMethod[]; birthDate: string; labels: string[]; note: string;
  existing: { id: string; name: string } | null;
};

function combine(cards: Card[]): Omit<Person, 'existing'> {
  const named = cards.filter((c) => c.named);
  const best = (named.length ? named : cards).slice().sort((a, b) => b.name.length - a.name.length)[0];
  const methods: ContactMethod[] = [];
  for (const c of cards) for (const m of c.methods) if (!methods.some((x) => x.kind === m.kind && JSON.stringify(x.value) === JSON.stringify(m.value))) methods.push(m);
  const labels: string[] = [];
  for (const c of cards) for (const l of c.labels) if (!labels.some((x) => x.toLowerCase() === l.toLowerCase())) labels.push(l);
  return {
    cards, name: best.name, named: best.named, type: best.type,
    org: cards.find((c) => c.org)?.org ?? '', title: cards.find((c) => c.title)?.title ?? '',
    methods, birthDate: cards.find((c) => c.birthDate)?.birthDate ?? '', labels,
    note: [...new Set(cards.map((c) => c.note).filter(Boolean))].join('\n\n').slice(0, 10000),
  };
}

/** Group the cards into people: with merge on, cards sharing an email, phone or full name are one person. */
async function peopleOf(cards: Card[], merge: boolean): Promise<Person[]> {
  const parties = await ctx.store.find<PartyDoc>('parties', {});
  const here = new Map<string, PartyDoc>();
  for (const p of parties) if (p.type !== 'assistant') for (const k of keysOf(p.name, true, p.methods ?? [])) if (!here.has(k)) here.set(k, p);
  const match = (ks: string[]) => { for (const k of ks) { const p = here.get(k); if (p) return { id: p._id, name: p.name }; } return null; };

  if (!merge) return cards.map((c) => ({ ...combine([c]), existing: null }));
  // Union-find over cards that share a key.
  const parent = cards.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map<string, number>();
  cards.forEach((c, i) => {
    for (const k of keysOf(c.name, c.named, c.methods)) {
      const j = owner.get(k);
      if (j === undefined) owner.set(k, i); else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, Card[]>();
  cards.forEach((c, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), c]); });
  return [...groups.values()].map((g) => {
    const p = combine(g);
    return { ...p, existing: match(g.flatMap((c) => keysOf(c.name, c.named, c.methods))) };
  });
}

// ── held files ───────────────────────────────────────────────────────

type Held = { id: string; name: string; cards: Card[]; at: number };
const HOLD_MS = 60 * 60_000;
const held = new Map<string, Held>();

function sweep() { for (const [k, v] of held) if (Date.now() - v.at > HOLD_MS) held.delete(k); }

export function heldFile(id: string) {
  sweep();
  const h = held.get(id);
  if (!h) throw new HttpError(404, 'import_not_found', 'That file is no longer open. Add it again.');
  return h;
}

const emailOnly = (c: { methods: ContactMethod[]; named: boolean; org: string }) => !c.named && !c.org && c.methods.length > 0 && c.methods.every((m) => m.kind === 'email');

/** What's in the file, as counts: what the owner sees first, and all an assistant sees when it writes rules. */
export async function summarize(cards: Card[]) {
  const people = await peopleOf(cards, true);
  const count = (xs: string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, count: n }));
  };
  const domains = cards.flatMap((c) => [...new Set(c.methods.filter((m) => m.kind === 'email').map((m) => String(m.value).split('@')[1]))])
    .filter((d) => !/^(gmail|googlemail|yahoo|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|comcast|att|verizon|sbcglobal)\./.test(d));
  return {
    cards: cards.length,
    people: people.length,
    duplicates: cards.length - people.length,
    alreadyHere: people.filter((p) => p.existing).length,
    noName: cards.filter((c) => !c.named).length,
    emailOnly: cards.filter(emailOnly).length,
    businesses: cards.filter((c) => c.type === 'organisation').length,
    withBirthday: cards.filter((c) => c.birthDate).length,
    labels: count(cards.flatMap((c) => c.labels)),
    unlabelled: cards.filter((c) => !c.labels.length).length,
    companies: count(cards.map((c) => c.org).filter(Boolean)).slice(0, 25),
    emailDomains: count(domains).filter((d) => d.count > 1).slice(0, 25),
  };
}
export type Summary = Awaited<ReturnType<typeof summarize>>;

export async function holdFile(name: string, text: string) {
  sweep();
  const cards = parseVcards(text);
  if (!cards.length) throw bad('no_contacts', 'There are no contacts in that file. Export them as vCard (.vcf).');
  if (cards.length > 20000) throw bad('too_many', 'That file has more than 20,000 contacts. Split it and add each part.');
  // A few files open at once is plenty; the oldest goes.
  if (held.size >= 5) held.delete([...held.values()].sort((a, b) => a.at - b.at)[0].id);
  const h: Held = { id: newId('imp'), name: name.slice(0, 200) || 'contacts.vcf', cards, at: Date.now() };
  held.set(h.id, h);
  const summary = await summarize(cards);
  return { id: h.id, name: h.name, summary, presets: presetsFor(summary) };
}

// ── rules ────────────────────────────────────────────────────────────

/** The ready-made choices, fitted to the labels in this file. */
export function presetsFor(s: Pick<Summary, 'labels'>) {
  const relations: Record<string, Relation> = {};
  for (const l of s.labels) { const r = guessRelation(l.name); if (r) relations[l.name] = r; }
  const known = Object.keys(relations);
  const base: ImportRules = { merge: true, skipNoName: true, skipEmailOnly: true, organisations: false, workplaces: true, only: null, relations, companies: [], rest: 'add' };
  return [
    { id: 'clean', label: 'Clean everything', text: 'Combine duplicates, leave out cards with no name, keep everyone else.', rules: base },
    { id: 'known', label: 'Only people I know', text: known.length ? `Only people labelled ${known.join(', ')}.` : 'Only people with a label. Your file has none that say family, friends or work yet.', rules: { ...base, only: known, rest: 'skip' as const } },
    { id: 'everything', label: 'Everything as is', text: 'Every card, businesses too, as written. Nothing combined or left out.', rules: { ...base, merge: false, skipNoName: false, skipEmailOnly: false, organisations: true } },
  ];
}

/** Rules as sent, checked. */
export function checkRules(v: unknown): ImportRules {
  const r = (v ?? {}) as Partial<ImportRules>;
  const relation = (x: unknown, where: string): Relation => {
    if (!RELATIONS.includes(x as Relation)) throw bad('invalid_value', `${where}: one of ${RELATIONS.join(', ')}`);
    return x as Relation;
  };
  const relations: Record<string, Relation> = {};
  for (const [k, x] of Object.entries(r.relations ?? {})) if (k.trim()) relations[k.trim().slice(0, 60)] = relation(x, `relations.${k}`);
  if (r.companies !== undefined && !Array.isArray(r.companies)) throw bad('invalid_value', 'companies: a list of { match, relation }');
  const companies = (r.companies ?? []).slice(0, 50).map((c, i) => {
    const match = String(c?.match ?? '').trim().toLowerCase().replace(/^@/, '').slice(0, 100);
    if (!match) throw bad('invalid_value', `companies[${i}]: say which company or email domain`);
    return { match, relation: relation(c.relation, `companies[${i}].relation`) };
  });
  if (r.only !== undefined && r.only !== null && !Array.isArray(r.only)) throw bad('invalid_value', 'only: a list of labels, or null for everyone');
  return {
    merge: r.merge !== false, skipNoName: r.skipNoName !== false, skipEmailOnly: !!r.skipEmailOnly,
    organisations: !!r.organisations, workplaces: r.workplaces !== false,
    only: r.only ? r.only.map((x) => String(x).trim()).filter(Boolean).slice(0, 100) : null,
    relations, companies, rest: r.rest === 'skip' ? 'skip' : 'add',
  };
}

// ── the plan ─────────────────────────────────────────────────────────

type Decision =
  | { person: Person; action: 'skip'; reason: 'no_name' | 'email_only' | 'business' | 'not_chosen' }
  | { person: Person; action: 'add'; relation: Relation | null };

const lc = (s: string) => s.toLowerCase();

async function decide(cards: Card[], rules: ImportRules): Promise<Decision[]> {
  const people = await peopleOf(cards, rules.merge);
  const rel = new Map(Object.entries(rules.relations).map(([k, v]) => [lc(k), v]));
  const only = rules.only ? new Set(rules.only.map(lc)) : null;
  return people.map((p): Decision => {
    if (p.type === 'organisation' && !rules.organisations) return { person: p, action: 'skip', reason: 'business' };
    if (rules.skipNoName && !p.named && !p.existing) return { person: p, action: 'skip', reason: 'no_name' };
    if (rules.skipEmailOnly && emailOnly(p) && !p.existing) return { person: p, action: 'skip', reason: 'email_only' };
    const emails = p.methods.filter((m) => m.kind === 'email').map((m) => lc(String(m.value)));
    const company = rules.companies.find((c) => lc(p.org) === c.match || lc(p.org).includes(c.match) || emails.some((e) => e.endsWith(`@${c.match}`) || e.endsWith(`.${c.match}`)));
    const byLabel = p.labels.map((l) => rel.get(lc(l))).find(Boolean) ?? null;
    if (only && !p.labels.some((l) => only.has(lc(l))) && !company) return { person: p, action: 'skip', reason: 'not_chosen' };
    const relation = p.type === 'organisation' ? null : byLabel ?? company?.relation ?? null;
    if (!relation && rules.rest === 'skip' && !only) return { person: p, action: 'skip', reason: 'not_chosen' };
    return { person: p, action: 'add', relation };
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The plan in plain words, a line per group, each with who's in it. */
export async function planFor(id: string, rules: ImportRules) {
  const h = heldFile(id);
  const ds = await decide(h.cards, rules);
  const groups: { id: string; text: string; names: string[] }[] = [];
  const push = (gid: string, text: string, list: Decision[], name = (d: Decision) => d.person.name) => {
    if (list.length) groups.push({ id: gid, text, names: list.map(name).sort((a, b) => a.localeCompare(b)) });
  };
  const adding = ds.filter((d): d is Extract<Decision, { action: 'add' }> => d.action === 'add');
  const merged = adding.filter((d) => d.person.cards.length > 1);
  push('merge', `Combine ${plural(merged.reduce((n, d) => n + d.person.cards.length, 0), 'card')} into ${plural(merged.length, 'person', 'people')}`, merged, (d) => `${d.person.name} (${d.person.cards.length} cards)`);
  push('existing', `Add details to ${plural(adding.filter((d) => d.person.existing).length, 'person', 'people')} already here`, adding.filter((d) => d.person.existing), (d) => d.person.existing!.name);
  for (const r of RELATIONS) {
    const list = adding.filter((d) => d.relation === r);
    push(`relation:${r}`, `Add ${list.length.toLocaleString('en-US')} as ${list.length === 1 && r !== 'other_family' ? r.replace('_', ' ') : RELATION_PLURAL[r]}`, list);
  }
  const fresh = adding.filter((d) => !d.relation && d.person.type === 'person');
  push('sort', `Add ${plural(fresh.length, 'person', 'people')} to sort later`, fresh);
  push('businesses', `Add ${plural(adding.filter((d) => d.person.type === 'organisation').length, 'business', 'businesses')}`, adding.filter((d) => d.person.type === 'organisation'));
  const skips: [string, string, string][] = [['no_name', 'with no name', 'with no name'], ['email_only', 'with only an email address', 'with only an email address'], ['business', 'that is a business', 'that are businesses'], ['not_chosen', rules.only ? 'without those labels' : 'with no relation', rules.only ? 'without those labels' : 'with no relation']];
  for (const [reason, one, many] of skips) {
    const list = ds.filter((d) => d.action === 'skip' && d.reason === reason);
    const n = list.reduce((k, d) => k + d.person.cards.length, 0);
    push(`skip:${reason}`, `Leave out ${plural(n, 'card')} ${n === 1 ? one : many}`, list);
  }
  const companies = rules.workplaces ? new Set(adding.filter((d) => d.person.org).map((d) => lc(d.person.org))).size : 0;
  return {
    name: h.name, rules, groups,
    totals: { adding: adding.filter((d) => !d.person.existing).length, updating: adding.filter((d) => d.person.existing).length, relationships: adding.filter((d) => d.relation).length, workplaces: companies, leftOut: ds.filter((d) => d.action === 'skip').length },
  };
}

// ── importing and undoing ────────────────────────────────────────────

/** What an import did, kept so it can be undone: what it created, and what it added to people already here. */
export type ImportDoc = {
  _id: string;
  name: string;
  rules: ImportRules;
  parties: string[];
  records: string[];
  /** Additions to people already here: the methods, birth date and workplaces the import gave them. */
  added: { party: string; methods: ContactMethod[]; birthDate?: string; affiliations: { party: string; role: string }[] }[];
  counts: { people: number; updated: number; relationships: number; organisations: number };
  createdAt: string;
  undoneAt: string | null;
};

const sameMethod = (a: ContactMethod, b: ContactMethod) => a.kind === b.kind && JSON.stringify(a.value) === JSON.stringify(b.value);

export async function runImport(id: string, rules: ImportRules, by: Actor): Promise<ImportDoc> {
  const h = heldFile(id);
  const ds = await decide(h.cards, rules);
  const d = await getDomain('relationships');
  if (!d) throw new Error('relationships kind missing');
  const t = new Date().toISOString();
  const doc: ImportDoc = { _id: h.id, name: h.name, rules, parties: [], records: [], added: [], counts: { people: 0, updated: 0, relationships: 0, organisations: 0 }, createdAt: t, undoneAt: null };

  // Workplaces: an organisation already here with the same name, or a new one.
  const orgs = new Map<string, string>();
  for (const o of await ctx.store.find<PartyDoc>('parties', { type: 'organisation' })) orgs.set(normName(o.name), o._id);
  const orgFor = async (name: string) => {
    const k = normName(name);
    if (!k) return null;
    let oid = orgs.get(k);
    if (!oid) {
      oid = newId('pty');
      await ctx.store.insert('parties', { _id: oid, type: 'organisation', name, methods: [], notes: '', affiliations: [], node: null, sharedIn: [], sharedInFetchedAt: null, createdAt: t } satisfies PartyDoc);
      orgs.set(k, oid); doc.parties.push(oid); doc.counts.organisations++;
    }
    return oid;
  };

  const related = new Set((await ctx.store.find<RecordDoc>('records', { domain: 'relationships' })).map((r) => r.data.party as string));
  for (const dec of ds) {
    if (dec.action !== 'add') continue;
    const p = dec.person;
    const work = rules.workplaces && p.type === 'person' && p.org ? await orgFor(p.org) : null;
    const affiliation = work ? { party: work, role: p.title } : null;
    let partyId: string;
    if (p.existing) {
      const cur = await ctx.store.get<PartyDoc>('parties', p.existing.id);
      if (!cur) continue;
      partyId = cur._id;
      const methods = p.methods.filter((m) => !cur.methods.some((x) => sameMethod(x, m))).map(({ primary: _p, ...m }) => m as ContactMethod);
      const birthDate = !cur.birthDate && p.birthDate ? p.birthDate : undefined;
      const affiliations = affiliation && !cur.affiliations?.some((a) => a.party === affiliation.party) ? [affiliation] : [];
      if (methods.length || birthDate || affiliations.length) {
        await ctx.store.update('parties', cur._id, {
          methods: [...cur.methods, ...methods].slice(0, 50), affiliations: [...(cur.affiliations ?? []), ...affiliations], ...(birthDate ? { birthDate } : {}),
        });
        doc.added.push({ party: cur._id, methods, affiliations, ...(birthDate ? { birthDate } : {}) });
        doc.counts.updated++;
      }
    } else {
      // The first of each kind is the main one.
      const methods = p.methods.slice(0, 50).map((m, i, all) => (all.findIndex((x) => x.kind === m.kind) === i ? { ...m, primary: true } : m));
      const party: PartyDoc = {
        _id: newId('pty'), type: p.type, name: p.name, methods, notes: p.note, affiliations: affiliation ? [affiliation] : [],
        node: null, sharedIn: [], sharedInFetchedAt: null, createdAt: t, ...(p.birthDate ? { birthDate: p.birthDate } : {}),
      };
      await ctx.store.insert('parties', party);
      partyId = party._id;
      doc.parties.push(partyId);
      doc.counts.people++;
    }
    // How the owner knows them, unless they're already in Relationships.
    if (dec.relation && !related.has(partyId)) {
      related.add(partyId);
      const rec = await buildRecord(d, { data: { party: partyId, relation: dec.relation } }, null, by);
      await ctx.store.insert('records', rec);
      await recordVersion(rec, 'create', by);
      doc.records.push(rec._id);
      doc.counts.relationships++;
    }
  }
  await ctx.store.insert('imports', doc);
  held.delete(id);
  if (doc.records.length) nudgePeers(await contactsSharing('relationships', doc.records));
  return doc;
}

/**
 * Undo an import: its Relationships entries are removed (restorable for 30 days, like any deletion), the people
 * and organisations it added are removed unless they've been used since (a message, a connection, an entry that
 * points to them), and what it added to people already here is taken back off.
 */
export async function undoImport(id: string, by: Actor) {
  const doc = await ctx.store.get<ImportDoc>('imports', id);
  if (!doc) throw notFound('import_not_found');
  if (doc.undoneAt) throw bad('already_undone', 'That import was undone already.');
  let records = 0, removed = 0, kept: string[] = [], restored = 0;
  for (const rid of doc.records) {
    const r = await ctx.store.get<RecordDoc>('records', rid);
    if (!r) continue;
    await unlinkRecord(r._id, by);
    await recordVersion(r, 'delete', by);
    await ctx.store.remove('records', r._id);
    await recordRemoved(r._id);
    records++;
  }
  const mine = new Set(doc.parties);
  // People first, then the workplaces they pointed to.
  const all = await ctx.store.find<PartyDoc>('parties', {});
  const ps = doc.parties.map((pid) => all.find((p) => p._id === pid)).filter((p): p is PartyDoc => !!p).sort((a, b) => (a.type === 'organisation' ? 1 : 0) - (b.type === 'organisation' ? 1 : 0));
  for (const p of ps) {
    const usedBy = await partyReferences(p._id);
    const members = (await ctx.store.find<PartyDoc>('parties', {})).filter((o) => o._id !== p._id && o.affiliations?.some((a) => a.party === p._id) && !mine.has(o._id));
    const busy = p.node || usedBy.length || members.length || (await ctx.store.count('messages', { contactId: p._id })) || (await ctx.store.count('copies', { contactId: p._id }));
    if (busy) { kept.push(p.name); continue; }
    await unlinkParty(p._id, by.id);
    await ctx.store.remove('parties', p._id);
    removed++;
  }
  for (const a of doc.added) {
    const p = await ctx.store.get<PartyDoc>('parties', a.party);
    if (!p) continue;
    await ctx.store.update('parties', p._id, {
      methods: p.methods.filter((m) => !a.methods.some((x) => sameMethod(x, m))),
      affiliations: (p.affiliations ?? []).filter((x) => !a.affiliations.some((y) => y.party === x.party)),
      ...(a.birthDate && p.birthDate === a.birthDate ? { birthDate: undefined } : {}),
    });
    restored++;
  }
  await ctx.store.update('imports', doc._id, { undoneAt: new Date().toISOString() });
  if (doc.records.length) nudgePeers(await contactsSharing('relationships', doc.records));
  kept = [...new Set(kept)];
  return { relationships: records, removed, kept, restored };
}

export const importOut = (d: ImportDoc) => ({ id: d._id, name: d.name, counts: d.counts, createdAt: d.createdAt, undoneAt: d.undoneAt });

/** What the assistant is told when it writes rules from the owner's words. */
export function rulesPrompt(summary: Summary, current: ImportRules) {
  return [
    'You turn what the owner says about importing their contacts into import rules for Little Dipper. Reply with one JSON object and nothing else:',
    '{ "rules": <ImportRules>, "said": "<one short sentence, to the owner, saying what the rules will do>" }',
    '',
    'ImportRules:',
    '- merge (boolean): combine cards for the same person (same email, phone or full name), and with people already in Little Dipper.',
    '- skipNoName (boolean): leave out cards with no name.',
    '- skipEmailOnly (boolean): leave out cards that are only an email address.',
    '- organisations (boolean): bring in cards that are businesses.',
    '- workplaces (boolean): record where people work.',
    '- only (list of labels, or null): bring in only people with one of these labels, plus anyone a company rule matches. null brings in everyone.',
    `- relations (object): label exactly as written in the file → one of ${RELATIONS.join(', ')}. other_family is family in general.`,
    '- companies (list of { match, relation }): a company name or an email domain (e.g. acme.com), and the relation for people who match.',
    '- rest ("add" or "skip"): people with no relation are added to sort later, or left out. Ignored when only is set.',
    '',
    'Use only labels, companies and domains that appear in the summary. Start from the current rules and change what the owner asks for.',
    '',
    `The file: ${JSON.stringify(summary)}`,
    `Current rules: ${JSON.stringify(current)}`,
  ].join('\n');
}

/** The first JSON object in a model's reply. */
export function parseRulesReply(text: string) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw bad('model_unclear', 'The assistant didn’t answer with rules. Try saying it another way.');
  let j: { rules?: unknown; said?: unknown };
  try { j = JSON.parse(text.slice(start, end + 1)); } catch { throw bad('model_unclear', 'The assistant’s answer couldn’t be read. Try again.'); }
  return { rules: checkRules(j.rules), said: String(j.said ?? '').slice(0, 500) };
}

