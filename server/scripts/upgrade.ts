/**
 * The upgrade test: a node full of data on the previous release, updated to this code, must come back with every
 * entry, secret, person, share, document and sign-in exactly as it was. Nodes update on their own (Railway installs
 * patch releases by itself), so a release that loses or changes anyone's data must never be published.
 *
 *   npm run upgrade -w server                  (from the latest release tag that isn't this version)
 *   npm run upgrade -w server -- --from v0.4.0
 *
 * The previous release runs from its git tag in a temporary worktree, sharing this checkout's node_modules.
 * Releases before the 0.4.0 reset are never compared: nodes started fresh at 0.4.0.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SoftKey } from './softkey.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EPOCH = [0, 4, 0];
const PORT = Number(process.env.UPGRADE_PORT || 4250);
const BASE = `http://localhost:${PORT}`;

const git = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const semver = (t: string) => t.replace(/^v/, '').split('.').map(Number);
const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function pickFrom(): string | null {
  const args = process.argv.slice(2);
  if (args.includes('--from')) return args[args.indexOf('--from') + 1];
  const current = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;
  const tags = git('tag', '--list', 'v*.*.*').split('\n').filter(Boolean)
    .filter((t) => t !== `v${current}` && cmp(semver(t), semver(current)) < 0 && cmp(semver(t), EPOCH) >= 0)
    .sort((a, b) => cmp(semver(b), semver(a)));
  return tags[0] ?? null;
}

let failures = 0;
const ok = (cond: unknown, msg: string) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };

/** A client with its own cookie jar. */
function client() {
  const jar = new Map<string, string>();
  /** body: JSON, or a Buffer sent as-is with its content type (`type`). */
  return async function call<T = any>(method: string, p: string, body?: unknown, expect: number[] = [], type = 'application/json'): Promise<T> {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(BASE + p, {
      method,
      headers: { origin: BASE, ...(body !== undefined ? { 'content-type': type } : {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : raw ? (body as Buffer) : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (v) jar.set(k, v); else jar.delete(k); }
    const text = await res.text();
    if (res.status >= 400 && !expect.includes(res.status)) throw new Error(`${method} ${p} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

/** Start a node from this server folder on this data folder; resolves with its claim link (if it printed one). */
function start(serverDir: string, dataDir: string): Promise<{ proc: ChildProcess; claimUrl: string | null }> {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(PORT), LD_DATA_DIR: dataDir, LOG_LEVEL: 'warn', LD_PUBLIC_URL: BASE, LD_COOKIE_SUFFIX: 'upgrade' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    proc.on('exit', (code) => reject(new Error(`node exited (${code}) before answering:\n${out}`)));
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('Answering at')) resolve({ proc, claimUrl: out.match(/https?:\/\/\S+\/claim\?token=\S+/)?.[0] ?? null });
    });
  });
}
const stop = (proc: ChildProcess) => new Promise<void>((r) => { proc.removeAllListeners('exit'); proc.once('exit', () => r()); proc.kill(); });

/** Data that every release since 0.4.0 accepts (the compatibility contract keeps it valid in every later one). */
async function seed(call: ReturnType<typeof client>) {
  const party = async (name: string, type = 'organisation', more = {}) => (await call('POST', '/api/parties', { type, name, ...more })).id as string;
  const add = async (domain: string, data: Record<string, unknown>, more = {}) => (await call('POST', `/api/data/${domain}`, { data, ...more })).id as string;
  await add('names', { kind: 'legal', full: 'Sam Avery Rivera', given: 'Sam', middle: 'Avery', family: 'Rivera', reason: 'birth' }, { validFrom: '1990-05-01' });
  await add('birth', { date: '1990-05-01', city: 'Tucson', region: 'Arizona', country: 'US' });
  await add('ids', { kind: 'passport', number: 'P7654321', issuer: 'US', expires: '2032-01' });
  await add('contact_methods', { kind: 'phone', value: '(520) 555-0101', label: 'Mobile', primary: true });
  const landlord = await party('Jo Park', 'person');
  await add('residences', { street1: '10 Elm St', city: 'Tucson', region: 'AZ', country: 'US', ownership: 'rent', landlord, primary: true }, { validFrom: '2021-03' });
  await add('residences', { street1: '4 Oak Ave', city: 'Phoenix', country: 'US', ownership: 'rent' }, { validFrom: '2015-01', validTo: '2021-02' });
  const acme = await party('Acme Co');
  const job = await add('employment', { employer: acme, title: 'Engineer', currentPay: { amount: 95000, currency: 'USD', period: 'year' }, employeeId: 'E-1234' }, { validFrom: '2020-01' });
  const partner = await party('Alex Rivera', 'person', { birthDate: '1989-02-02' });
  await add('relationships', { party: partner, relation: 'spouse' }, { validFrom: '2018-06' });
  const bank = await party('Desert Bank');
  await add('financial_accounts', { kind: 'checking', institution: bank, number: '0001112223', routingNumber: '122105155', status: 'current' }, { validFrom: '2019-01' });
  await add('allergies', { substance: 'Peanuts', reaction: 'Hives', severity: 'severe' });
  await add('events', { title: 'Dentist', start: { at: '2027-02-03T09:00', tz: 'America/Phoenix' } });
  await add('notes', { text: 'Garage code: left keypad, then the bell.' });
  // A document filed on the job.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await call('POST', `/api/documents?name=offer.png&link=employment:${job}`, png, [], 'image/png');
  // An assistant: a party with a share and its own key.
  const muse = await party('Muse', 'assistant');
  await call('PUT', `/api/parties/${muse}/share`, { basic: true, categories: { employment: true, residences: { scope: 'current' } }, write: 'suggest', confirm: true });
  const key = await call('POST', '/api/keys', { party: muse });
  return { assistantKey: key.secret as string, muse };
}

/** Everything a person would notice if it changed, in a stable shape. */
async function snapshot(call: ReturnType<typeof client>) {
  const { domains } = await call('GET', '/api/catalog');
  const records: Record<string, unknown[]> = {};
  for (const d of domains as { id: string }[]) {
    const { items } = await call('GET', `/api/data/${d.id}`);
    const out = [];
    for (const r of items as { id: string; masked?: string[] }[]) {
      const full = r.masked?.length ? await call('POST', `/api/data/${d.id}/${r.id}/reveal`) : r;
      const { id, data, validFrom, validTo, notes, sensitivity, title } = full;
      out.push({ id, title, data, validFrom, validTo, notes, sensitivity });
    }
    if (out.length) records[d.id] = out.sort((a, b) => a.id.localeCompare(b.id));
  }
  const parties = (await call('GET', '/api/parties')).items.map((p: any) => ({ id: p.id, type: p.type, name: p.name, birthDate: p.birthDate ?? null, share: p.share }));
  const profile = (await call('GET', '/api/profile')).items.map((l: any) => ({ key: l.key, value: l.value }));
  const documents = (await call('GET', '/api/documents')).items.map((d: any) => ({ id: d.id, title: d.title, kind: d.kind ?? null, status: d.status, links: d.links, pages: (d.pages ?? []).length })).sort((a: any, b: any) => a.id.localeCompare(b.id));
  const node = await call('GET', '/api/node');
  const owner = await call('GET', '/api/owner');
  return { node: { id: node.id, address: node.address }, owner: owner.name, records, parties, profile, documents };
}

function diff(a: unknown, b: unknown, at = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap((k) => diff((a as any)[k], (b as any)[k], `${at}/${k}`));
  }
  return [`${at || '/'}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`];
}

async function main() {
  const from = pickFrom();
  if (!from) { console.log('No earlier release since the 0.4.0 reset to upgrade from: nothing to test.'); return; }
  console.log(`upgrade: ${from} → this code`);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ld-upgrade-'));
  const old = path.join(tmp, 'old');
  const data = path.join(tmp, 'data');
  git('worktree', 'add', '--detach', '--force', old, from);
  let proc: ChildProcess | null = null;
  try {
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(old, 'node_modules'));
    for (const ws of ['server', 'web']) if (existsSync(path.join(ROOT, ws, 'node_modules'))) symlinkSync(path.join(ROOT, ws, 'node_modules'), path.join(old, ws, 'node_modules'));

    // ── the previous release: claim it, fill it in, record everything ──
    const before = await start(path.join(old, 'server'), data);
    proc = before.proc;
    const call = client();
    const key = new SoftKey();
    await call('POST', '/api/node/claim', { token: new URL(before.claimUrl!).searchParams.get('token') });
    await call('POST', '/api/owner', { displayName: 'Sam Rivera' });
    const reg = await call('POST', '/api/auth/passkeys/register/options', {});
    await call('POST', '/api/auth/passkeys/register', { challengeId: reg.challengeId, response: key.register(reg.options, BASE), label: 'Upgrade test key' });
    const { codes } = await call('POST', '/api/auth/recovery-codes', {});
    await call('POST', '/api/node/claim/complete', {});
    const { assistantKey } = await seed(call);
    const was = await snapshot(call);
    const assistantWas = await (await fetch(`${BASE}/api/keys/me`, { headers: { authorization: `Bearer ${assistantKey}` } })).json();
    const total = Object.values(was.records).reduce((n, r) => n + r.length, 0);
    ok(total >= 13 && was.parties.length >= 5 && was.documents.length === 1, `${from} holds ${total} entries in ${Object.keys(was.records).length} categories, ${was.parties.length} people and organisations, and a document`);
    await stop(proc);

    // ── this code, on the same data ──
    const after = await start(path.join(ROOT, 'server'), data);
    proc = after.proc;
    ok(!after.claimUrl, 'the updated node is still claimed (no new setup link)');
    const me = client();
    const lo = await me('POST', '/api/auth/passkeys/options', {});
    await me('POST', '/api/auth/passkeys/verify', { challengeId: lo.challengeId, response: key.assert(lo.options, BASE) });
    ok((await me('GET', '/api/owner')).name === 'Sam Rivera', 'the owner signs in with the same passkey');
    const now = await snapshot(me);
    const changes = diff(was, now);
    ok(!changes.length, `every entry, secret, person, share, document and profile line is unchanged${changes.length ? `:\n      ${changes.slice(0, 15).join('\n      ')}` : ''}`);
    const r = client();
    ok((await r('POST', '/api/auth/recovery', { code: codes[0] })).codesLeft === codes.length - 1, 'a recovery code from before the update still works');
    const assistantNow = await (await fetch(`${BASE}/api/keys/me`, { headers: { authorization: `Bearer ${assistantKey}` } })).json();
    ok(assistantNow.name === assistantWas.name && JSON.stringify([...assistantNow.scopes].sort()) === JSON.stringify([...assistantWas.scopes].sort()) && assistantNow.assistant?.mode === assistantWas.assistant?.mode,
      "the assistant's key still works, with the same access and mode");
  } finally {
    if (proc) await stop(proc);
    try { git('worktree', 'remove', '--force', old); } catch { /* best effort */ }
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failures) { console.error(`\n✗ ${failures} upgrade ${failures === 1 ? 'check' : 'checks'} failed: this release would change someone's data.`); process.exit(1); }
  console.log('\nAll good.');
}

await main();
