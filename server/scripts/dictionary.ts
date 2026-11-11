/**
 * Writes docs/DATA-DICTIONARY.md from the code: every built-in category and its fields (catalog.ts), the owner's
 * profile lines (profile.ts) and where each comes from, and every stored collection. Run it after changing any of
 * them; `--check` fails if the file is out of date or a collection used in the code isn't described below.
 *
 *   npm run dictionary -w server            write the file
 *   npm run dictionary -w server -- --check  CI: fail if stale or incomplete
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILT_IN_DOMAINS } from '../src/domains/catalog.js';
import type { DomainDef, PartDef } from '../src/domains/types.js';
import { PROFILE_DOMAINS, PROFILE_LINES } from '../src/profile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(root, 'docs/DATA-DICTIONARY.md');

/** What each stored collection is for, in plain words. The check below fails if the code uses one that isn't here. */
const COLLECTIONS: Record<string, { area: string; holds: string }> = {
  owners: { area: 'Account', holds: 'How the owner signs in: passkeys, password hash, authenticator secret, recovery code hashes, display preferences. Their name and email live in Names and Contact methods.' },
  nodes: { area: 'Account', holds: 'This node: its Node ID, signing key reference, key history, addresses and address history, claim state, hosting.' },
  domainDefs: { area: 'Records', holds: 'Custom categories the owner creates (ids start x_). Built-in categories live in code, not here.' },
  records: { area: 'Records', holds: 'Every entry in every category: its data, validFrom/validTo, notes, who created it (source) and last changed it (updatedBy).' },
  recordVersions: { area: 'Records', holds: 'History: a copy of a record after each change (or before a delete), with who made it. Powers undo and restore.' },
  reviews: { area: 'Assistants', holds: 'Changes an assistant proposed that wait for the owner (encrypted), and their outcome.' },
  documents: { area: 'Documents', holds: 'Documents: title, kind, date, status (inbox/filed), notes, extracted text, links to records, suggestions, pages.' },
  files: { area: 'Documents', holds: 'The stored bytes of each page or file (encrypted), with type, size and who added it.' },
  shares: { area: 'Sharing', holds: 'Everything shared: who (a party, a link, everyone), what (the basic profile, extra profile lines, categories, single entries, documents), live or a snapshot, and until when. One live share per connected party.' },
  copies: { area: 'Sharing', holds: 'Snapshots of entries sent to someone (link, file or email text), encrypted, with views and downloads counted.' },
  publicProfile: { area: 'Sharing', holds: 'What the owner shows publicly: which Names entry is the public name, chosen profile lines, record sections, photo.' },
  parties: { area: 'Contacts', holds: 'People and organisations in the owner’s life: type, name, contact methods (one shape), notes, affiliations, their node if they run Little Dipper, and what they last shared with the owner.' },
  nodeLinks: { area: 'Contacts', holds: 'A connection with another Little Dipper: its Node ID and address, status, the tokens each side holds, timeline.' },
  connectionRequests: { area: 'Contacts', holds: 'Incoming and outgoing requests to connect, with what each side asked for and offered.' },
  invites: { area: 'Contacts', holds: 'Invite links the owner created to connect with someone.' },
  messages: { area: 'Messages', holds: 'Messages to and from connected nodes (encrypted), with delivery status and retries.' },
  apiKeys: { area: 'Assistants & apps', holds: 'Every credential: the browser session, app and assistant keys (scopes, mode, secret fields), peer tokens. Only hashes are stored.' },
  oauthClients: { area: 'Assistants & apps', holds: 'Assistant platforms registered through OAuth (self-reported name, redirect addresses).' },
  oauthCodes: { area: 'Assistants & apps', holds: 'Short-lived authorization codes during an OAuth connection.' },
  oauthTokens: { area: 'Assistants & apps', holds: 'Hashes of OAuth access and refresh tokens, each tied to an assistant key.' },
  audit: { area: 'System', holds: 'The activity log: who did what, when, in plain words.' },
  notices: { area: 'System', holds: 'Notifications for the owner (Review waiting, digests, ended connections), and which were dismissed.' },
  backups: { area: 'System', holds: 'Backups kept on the node itself, and backup settings.' },
  challenges: { area: 'System', holds: 'One-time sign-in and passkey challenges.' },
};

const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const yes = (b: unknown) => (b ? 'yes' : '');

function partType(p: PartDef) {
  if (p.type === 'enum') return `one of: ${p.options!.map(([k]) => k).join(', ')}`;
  if (p.type === 'list') return `list of (${p.of!.map((x) => `${x.key}: ${x.type}`).join(', ')})`;
  if (p.type === 'record') return `${p.many ? 'links' : 'link'} to ${p.to?.join(' or ') || 'any entry'}`;
  if (p.type === 'money' && p.periodic) return 'money per period';
  return p.type;
}

function domainSection(d: DomainDef) {
  const lines = [
    `### ${d.label} \`${d.id}\``,
    '',
    d.description,
    '',
    `One entry: ${d.noun} · Group: ${d.group} · Default sensitivity: ${d.sensitivity}${d.sensitivityBy ? ` (by ${d.sensitivityBy.part}: ${Object.entries(d.sensitivityBy.values).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''} · Keeps dates (validFrom/validTo): ${d.dated ? 'yes' : 'no'}${d.single ? ' · One entry only' : ''} · Can be public: ${d.publicable ? 'yes' : 'no'}${d.confirmShare ? ' · Sharing needs a confirm' : ''}${d.documents ? ` · Takes documents: ${d.documents}` : ''}`,
    '',
    '| Field | Key | Type | Required | Sensitivity (at least) | Notes |',
    '|---|---|---|---|---|---|',
    ...d.parts.map((p) => `| ${cell(p.label)} | \`${p.key}\` | ${cell(partType(p))} | ${yes(p.required)} | ${p.sensitivity ?? 'follows the entry'} | ${cell([p.hint, p.when && `only when ${(Array.isArray(p.when) ? p.when : [p.when]).map((w) => `${w.part} is ${w.in.join(' or ')}`).join(', or ')}`, p.remind && 'reminder before it passes', p.deprecated && 'deprecated'].filter(Boolean).join('; '))} |`),
    '',
  ];
  if (d.companions?.length) lines.push(`Invites: ${d.companions.map((c) => c.label).join('; ')}.`, '');
  if (PROFILE_DOMAINS.has(d.id)) lines.push('Feeds the owner’s profile.', '');
  return lines.join('\n');
}

function profileSection() {
  return [
    '## Owner profile (computed)',
    '',
    'Nothing is stored on the profile: each line is worked out from the categories every time (profile.ts), and is as sensitive as the parts it shows. The basic profile is every standard line; secret lines never leave.',
    '',
    '| Line | Key |',
    '|---|---|',
    ...PROFILE_LINES.map(([key, label]) => `| ${label} | \`${key}\` |`),
    '',
    `Read from: ${[...PROFILE_DOMAINS].map((d) => `\`${d}\``).join(', ')}.`,
    '',
  ].join('\n');
}

function collectionsSection() {
  const byArea = new Map<string, string[]>();
  for (const [name, c] of Object.entries(COLLECTIONS)) byArea.set(c.area, [...(byArea.get(c.area) ?? []), `| \`${name}\` | ${cell(c.holds)} |`]);
  return ['## Stored collections', '', 'Everything a node stores, one SQLite table each.', '', ...[...byArea].flatMap(([area, rows]) => [`### ${area}`, '', '| Collection | Holds |', '|---|---|', ...rows, ''])].join('\n');
}

/** Collections the code actually uses, found by scanning ctx.store calls. */
function usedCollections() {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) for (const m of readFileSync(p, 'utf8').matchAll(/store\.\w+(?:<[^>]*>)?\(\s*'([a-zA-Z_]+)'/g)) found.add(m[1]);
    }
  };
  walk(path.join(root, 'server/src'));
  return found;
}

const groups = [...new Set(BUILT_IN_DOMAINS.map((d) => d.group))];
const doc = [
  '# Data dictionary',
  '',
  '> Generated by `server/scripts/dictionary.ts` from the code. Don\'t edit by hand: change the code, then run `npm run dictionary -w server`.',
  '',
  `${BUILT_IN_DOMAINS.length} built-in categories, ${BUILT_IN_DOMAINS.reduce((n, d) => n + d.parts.length, 0)} fields, ${PROFILE_LINES.length} profile lines, ${Object.keys(COLLECTIONS).length} stored collections.`,
  '',
  'Every record also carries: `validFrom` and `validTo` (dated categories), `sensitivity` (the owner’s choice for that entry; unset means the default), `notes`, `source` (who created it), `updatedBy` (who last changed it), and timestamps.',
  '',
  profileSection(),
  '## Categories',
  '',
  ...groups.flatMap((g) => [`## Group: ${g}`, '', ...BUILT_IN_DOMAINS.filter((d) => d.group === g).map(domainSection)]),
  collectionsSection(),
].join('\n');

const missing = [...usedCollections()].filter((c) => !COLLECTIONS[c]);
if (missing.length) { console.error(`Describe these collections in scripts/dictionary.ts: ${missing.join(', ')}`); process.exit(1); }

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(out, 'utf8'); } catch { /* missing */ }
  if (current !== doc) { console.error('docs/DATA-DICTIONARY.md is out of date. Run: npm run dictionary -w server'); process.exit(1); }
  console.log('✓ Data dictionary is up to date.');
} else {
  writeFileSync(out, doc);
  console.log(`✓ Wrote docs/DATA-DICTIONARY.md (${BUILT_IN_DOMAINS.length} categories, ${Object.keys(COLLECTIONS).length} collections).`);
}
