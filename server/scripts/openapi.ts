/**
 * Writes docs/openapi.json, the Little Dipper API as an OpenAPI 3.1 document, from the code:
 *   - every route the server registers (so nothing is missing and nothing is invented),
 *   - what each one does, who may call it and the scope it needs (web/src/reference.ts),
 *   - one schema per built-in category of records (domains/catalog.ts),
 *   - the capabilities this release has (node.ts).
 * Big Dipper's docs render it. `--check` fails if the file is stale or a route isn't described.
 *
 *   npm run openapi -w server            write the file
 *   npm run openapi -w server -- --check  CI: fail if stale or incomplete
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { VERSION } from '../src/config.js';
import { BUILT_IN_DOMAINS } from '../src/domains/catalog.js';
import type { DomainDef, PartDef } from '../src/domains/types.js';
import { CAPABILITIES } from '../src/node.js';
import { ENDPOINTS, SCOPES, type Endpoint } from '../../web/src/reference.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../docs/openapi.json');
const check = process.argv.includes('--check');

/** /x/:id, /x/{id} and /x/{recordId} are the same route. */
const shape = (p: string) => p.split('?')[0].replace(/:[A-Za-z_]+|\{[^}]+\}/g, '{}').replace(/\/+$/, '') || '/';

// ── The routes the server really has ─────────────────────────────────
const routes: { method: string; url: string }[] = [];
const app = await buildApp({ onRoute: (m: string, url: string) => { if (m !== 'HEAD' && m !== 'OPTIONS') routes.push({ method: m, url }); } });
await app.close();

const described = new Map<string, Endpoint>();
for (const e of ENDPOINTS) if (!described.has(`${e.m} ${shape(e.p)}`)) described.set(`${e.m} ${shape(e.p)}`, e);

// The web app's own pages and files aren't API.
const isApi = (url: string) => /^\/(api|peer|public|oauth|\.well-known|s|c)\b/.test(url);
// Pages the web app serves (no server route of their own), but part of the API's flow: listed all the same.
const PAGES = ['GET /oauth/authorize'];
for (const k of PAGES) { const [method, url] = k.split(' '); if (!routes.some((r) => r.method === method && r.url === url)) routes.push({ method, url }); }
const api = routes.filter((r) => isApi(r.url)).sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
const missing = api.filter((r) => !described.has(`${r.method} ${shape(r.url)}`));
const stale = [...described.keys()].filter((k) => !api.some((r) => `${r.method} ${shape(r.url)}` === k));

// ── Who may call what ────────────────────────────────────────────────
const SECURITY: Record<Endpoint['auth'], { name: string; scheme: object; label: string }> = {
  owner: {
    name: 'ownerKey', label: 'The owner, an app key with the scope shown, or an assistant',
    scheme: { type: 'http', scheme: 'bearer', description: `An owner session, or an app or assistant key (\`ldk_…\`) the owner made. Each key carries scopes: ${SCOPES.map((s) => `\`${s}\``).join(', ')}. OAuth access tokens (assistants) work the same way.` },
  },
  session: {
    name: 'ownerSession', label: 'The owner, signed in (passkey session)',
    scheme: { type: 'apiKey', in: 'cookie', name: 'ld_session', description: 'The owner signed in with a passkey. Account-level changes need the owner themselves, never a key.' },
  },
  peer: {
    name: 'peerSignature', label: 'Another Little Dipper or a service, signed',
    scheme: { type: 'http', scheme: 'bearer', description: 'Node to node. The body is a signed envelope `{ payload: { …, from, ts, nonce }, signature }` (Ed25519 over canonical JSON), checked against the caller\'s published key. Reads use the token issued when the connection was accepted.' },
  },
  claim: {
    name: 'claimToken', label: 'Whoever holds the one-time claim code (setup only)',
    scheme: { type: 'apiKey', in: 'query', name: 'token', description: 'The one-time claim code a new node is created with. It stops working once the node is claimed.' },
  },
  public: { name: '', label: 'Anyone', scheme: {} },
};

// ── Records: one schema per category ─────────────────────────────────
function partSchema(p: PartDef): Record<string, unknown> {
  const base: Record<string, unknown> = { title: p.label, ...(p.hint ? { description: p.hint } : {}) };
  switch (p.type) {
    case 'number': return { ...base, type: 'number' };
    case 'boolean': return { ...base, type: 'boolean' };
    case 'enum': return { ...base, type: 'string', enum: (p.options ?? []).map(([k]) => k), 'x-labels': Object.fromEntries((p.options ?? []).map(([k, l]) => [k, l])) };
    case 'date': return { ...base, type: 'string', pattern: '^\\d{4}(-\\d{2}(-\\d{2})?)?$', description: [p.hint, 'Partial ISO date: YYYY, YYYY-MM or YYYY-MM-DD.'].filter(Boolean).join(' ') };
    case 'datetime': return { ...base, $ref: '#/components/schemas/DateTime' };
    case 'money': return { ...base, $ref: '#/components/schemas/Money' };
    case 'address': return { ...base, $ref: '#/components/schemas/Address' };
    case 'geo': return { ...base, type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' } }, required: ['lat', 'lon'] };
    case 'country': return { ...base, type: 'string', pattern: '^[A-Z]{2}$', description: 'ISO 3166-1 alpha-2, e.g. US.' };
    case 'currency': return { ...base, type: 'string', pattern: '^[A-Z]{3}$', description: 'ISO 4217, e.g. USD.' };
    case 'region': return { ...base, type: 'string', description: 'ISO 3166-1 country or ISO 3166-2 subdivision, e.g. US or US-OR.' };
    case 'last4': return { ...base, type: 'string', pattern: '^\\d{4}$' };
    case 'time': return { ...base, type: 'string', pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' };
    case 'timezone': return { ...base, type: 'string', description: 'IANA time zone, e.g. America/Chicago.' };
    case 'repeat': return { ...base, type: 'string', description: 'iCalendar repeat rule (RFC 5545 RRULE), e.g. FREQ=WEEKLY;BYDAY=TU.' };
    case 'email': return { ...base, type: 'string', format: 'email' };
    case 'url': return { ...base, type: 'string', format: 'uri' };
    case 'party': case 'contact': return { ...base, type: 'string', description: [p.hint, 'Id of a party: a person or organisation.'].filter(Boolean).join(' ') };
    case 'record': {
      const one = { type: 'string', description: `Id of an entry in ${(p.to ?? []).join(' or ') || 'another category'}.` };
      return p.many ? { ...base, type: 'array', items: one } : { ...base, ...one };
    }
    case 'list': return { ...base, type: 'array', items: { type: 'object', properties: Object.fromEntries((p.of ?? []).map((q) => [q.key, partSchema(q)])) } };
    default: return { ...base, type: 'string' };
  }
}

function domainSchema(d: DomainDef) {
  const name = `Record_${d.id}`;
  return [name, {
    title: d.label,
    description: `${d.description} One ${d.noun} per entry${d.single ? ' (at most one)' : ''}. Default sensitivity: ${d.sensitivity}.${d.dated ? ' Dated: entries carry validFrom and validTo.' : ''}`,
    type: 'object',
    properties: Object.fromEntries(d.parts.map((p) => [p.key, {
      ...partSchema(p),
      'x-part-type': p.type,
      ...(p.sensitivity === 'secret' ? { 'x-sensitivity': 'secret' } : {}),
      ...(p.deprecated ? { deprecated: true } : {}),
      ...(p.system ? { readOnly: true } : {}),
    }])),
    required: d.parts.filter((p) => p.required).map((p) => p.key),
  }] as const;
}

// ── Operations ───────────────────────────────────────────────────────
const firstSentence = (s: string) => {
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  // A title, not a spec: drop the request shape ("Add a record: { data, … }" → "Add a record") and the full stop.
  const t = (m ? m[1] : s).split(/:?\s*[{(]|[:;]\s/)[0].replace(/[.:]\s*$/, '').trim();
  return (t || s).slice(0, 100);
};

function queryParams(doc: string) {
  const q = doc.split('?')[1];
  if (!q) return [];
  return q.split('&').map((kv) => kv.split('=')).filter(([k]) => k).map(([k, v]) => ({
    name: k, in: 'query', required: false,
    schema: v && v.includes('|') ? { type: 'string', enum: v.split('|') } : { type: 'string' },
  }));
}

/** Titles where the description starts with a request shape or a fragment. */
const TITLES: Record<string, string> = {
  'POST /api/copies': 'Send a copy of entries',
  'PATCH /api/documents/{}': 'Change a document',
  'POST /api/documents/{}/shares': 'Share a document by link',
  'POST /api/keys/{}/sessions/undo': 'Undo an app’s session',
  'DELETE /api/federation/links/{}': 'Disconnect from a node',
  'POST /api/federation/requests/{}/accept': 'Accept a connection request',
  'POST /api/federation/requests/{}/decline': 'Decline a connection request',
  'POST /api/messages/conversations/{}': 'Send a message',
  'POST /api/owner': 'Set up the owner',
  'POST /api/tasks/requests/{}': 'Answer a task request',
  'POST /oauth/token': 'Get or refresh a token',
  'POST /peer/requests': 'Receive a connection request',
  'POST /peer/requests/{}/accept': 'Receive an acceptance',
  'POST /peer/requests/{}/decline': 'Receive a decline',
  'GET /.well-known/oauth-protected-resource/api/mcp': 'MCP resource metadata (path form)',
  'GET /api/attention': 'What’s expiring soon',
  'GET /api/catalog': 'Every category and its schema',
};

const paths: Record<string, Record<string, object>> = {};
const tags = new Set<string>();
for (const r of api) {
  const e = described.get(`${r.method} ${shape(r.url)}`);
  const p = r.url.replace(/:([A-Za-z_]+)/g, '{$1}');
  const params = [...r.url.matchAll(/:([A-Za-z_]+)/g)].map(([, n]) => ({
    name: n, in: 'path', required: true,
    schema: n === 'domain' ? { type: 'string', description: 'A category id: a built-in one (see Categories in the docs) or the owner\'s own (x_…).', examples: BUILT_IN_DOMAINS.map((d) => d.id) } : { type: 'string' },
  }));
  const tag = e?.g ?? 'Other';
  tags.add(tag);
  const sec = e ? SECURITY[e.auth] : null;
  paths[p] ??= {};
  paths[p][r.method.toLowerCase()] = {
    tags: [tag],
    operationId: `${r.method.toLowerCase()}${p.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))}`,
    summary: TITLES[`${r.method} ${shape(r.url)}`] ?? (e ? firstSentence(e.d) : 'Not described yet.'),
    ...(e ? { description: `${e.d}\n\n**Who:** ${sec!.label}${e.scope ? ` (scope \`${e.scope}\`)` : ''}.` } : {}),
    ...(params.length || (e && queryParams(e.p).length) ? { parameters: [...params, ...(e ? queryParams(e.p) : [])] } : {}),
    security: sec && sec.name ? [{ [sec.name]: e?.scope ? [e.scope] : [] }] : [],
    ...(e?.scope ? { 'x-scope': e.scope } : {}),
    responses: { default: { description: 'JSON. Errors are `{ code, message }` with a matching HTTP status: branch on `code` (stable), never on `message` (for people, may change).' } },
  };
}

const doc = {
  openapi: '3.1.0',
  info: {
    title: 'Little Dipper API',
    version: VERSION,
    summary: 'A private home for all of your life\'s data. Every Little Dipper serves this API at its own address.',
    description: [
      'Every Little Dipper is one person\'s own server, so there is no central API: you call **the owner\'s node** at its address, with their permission.',
      '',
      '- **No versions in the paths.** Endpoints only ever get added. Check `capabilities` in `/.well-known/little-dipper` before using a feature; a missing capability means "do without", never an error.',
      '- **Records** live at `/api/data/{category}`. Each built-in category has a schema below; owners can add their own (`x_…`).',
      '- **Secret values** come back masked unless you ask to reveal them and have permission.',
      '- **Nodes talk to each other** under `/peer`, with signed envelopes.',
      '',
      'Generated from the code of this release, so it matches exactly what the server does.',
    ].join('\n'),
    license: { name: 'AGPL-3.0-or-later', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
  },
  servers: [{ url: 'https://{address}', description: 'The owner\'s Little Dipper', variables: { address: { default: 'your-little-dipper.example', description: 'The node\'s address' } } }],
  tags: [...tags].map((name) => ({ name })),
  paths,
  components: {
    securitySchemes: Object.fromEntries(Object.values(SECURITY).filter((s) => s.name).map((s) => [s.name, s.scheme])),
    schemas: {
      Money: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } }, required: ['amount', 'currency'] },
      DateTime: { type: 'object', description: 'A moment and its time zone: local time in `tz`, with offset.', properties: { at: { type: 'string', format: 'date-time' }, tz: { type: 'string', description: 'IANA time zone' } }, required: ['at', 'tz'] },
      Address: { type: 'object', properties: { street1: { type: 'string' }, street2: { type: 'string' }, city: { type: 'string' }, region: { type: 'string' }, postalCode: { type: 'string' }, country: { type: 'string', pattern: '^[A-Z]{2}$' } }, required: ['country'] },
      Entry: {
        type: 'object', description: 'One entry in a category, as the API returns it. `data` follows the category\'s schema; secret parts are masked and listed in `masked`.',
        properties: {
          id: { type: 'string' }, domain: { type: 'string' }, title: { type: 'string' }, data: { type: 'object' },
          masked: { type: 'array', items: { type: 'string' } }, sensitivity: { type: 'string', enum: ['standard', 'sensitive', 'secret'] },
          validFrom: { type: ['string', 'null'] }, validTo: { type: ['string', 'null'] }, current: { type: 'boolean' }, notes: { type: ['string', 'null'] },
          source: { type: 'object', description: 'Who created it' }, updatedBy: { type: 'object', description: 'Who last changed it' },
          createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      ...Object.fromEntries(BUILT_IN_DOMAINS.map(domainSchema)),
    },
  },
  'x-capabilities': [...CAPABILITIES].sort(),
};

const json = JSON.stringify(doc, null, 2) + '\n';
const problems = [
  ...missing.map((r) => `${r.method} ${r.url} isn't described in web/src/reference.ts`),
  ...stale.map((k) => `web/src/reference.ts describes ${k}, which the server doesn't have`),
];

if (check) {
  let was = '';
  try { was = readFileSync(out, 'utf8'); } catch { /* missing */ }
  if (was !== json) problems.unshift('docs/openapi.json is out of date. Run: npm run openapi -w server');
  if (problems.length) { for (const p of problems) console.error(`✗ ${p}`); process.exit(1); }
  console.log(`✓ docs/openapi.json is current: ${api.length} operations, ${BUILT_IN_DOMAINS.length} categories.`);
} else {
  writeFileSync(out, json);
  for (const p of problems) console.warn(`! ${p}`);
  console.log(`✓ Wrote docs/openapi.json: ${api.length} operations, ${BUILT_IN_DOMAINS.length} categories${problems.length ? `, ${problems.length} to fix` : ''}.`);
}
