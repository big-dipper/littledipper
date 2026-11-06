/**
 * A local Little Dipper with sample data, to try the app without touching a real node. Starts a fresh node in a
 * throwaway folder, claims it, fills in a life's worth of sample entries and prints how to sign in.
 *
 *   npm run demo -w server             (http://localhost:4300, stop with Ctrl-C; the folder is deleted)
 *   npm run demo -w server -- code     (a sign-in code for a demo that's already running)
 *
 * Sign in with the password it prints and a code from `-- code`. Built web files are served, so run
 * `npm run build -w web` first after changing the web app.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticator } from 'otplib';
import { SoftKey } from './softkey.js';

const PORT = 4300;
const base = `http://localhost:${PORT}`;
const PASSWORD = 'little-dipper-demo';
const secretFile = path.join(os.tmpdir(), 'little-dipper-demo.totp');

if (process.argv.includes('code')) {
  console.log(authenticator.generate(readFileSync(secretFile, 'utf8').trim()));
  process.exit(0);
}

const jar = new Map<string, string>();
async function call<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(base + p, {
    method,
    headers: { origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (v) jar.set(k, v); else jar.delete(k); }
  const text = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'ld-demo-'));
const proc = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), LD_DATA_DIR: dir, LOG_LEVEL: 'warn', LD_PUBLIC_URL: base },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const stop = () => { proc.kill(); rmSync(dir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const claimUrl: string = await new Promise((resolve) => {
  let out = '';
  proc.stdout!.on('data', (d: Buffer) => {
    out += d.toString();
    const m = out.match(/https?:\/\/\S+\/claim\?token=\S+/);
    if (m && out.includes('Answering at')) resolve(m[0]);
  });
});

// Claim with a software passkey, then a password and authenticator for signing in from a browser.
const key = new SoftKey();
await call('POST', '/api/node/claim', { token: new URL(claimUrl).searchParams.get('token') });
await call('POST', '/api/owner', { displayName: 'Maya Lindqvist', email: 'maya@example.com' });
const reg = await call('POST', '/api/auth/passkeys/register/options', {});
await call('POST', '/api/auth/passkeys/register', { challengeId: reg.challengeId, response: key.register(reg.options, base), label: 'Demo key' });
await call('POST', '/api/auth/recovery-codes', {});
await call('POST', '/api/node/claim/complete', {});
await call('PUT', '/api/auth/password', { password: PASSWORD });
const { secret } = await call('POST', '/api/auth/totp/setup', {});
await call('POST', '/api/auth/totp/enable', { code: authenticator.generate(secret) });
writeFileSync(secretFile, secret);

// ── sample data ──────────────────────────────────────────────────────────
const party = async (name: string, type = 'organisation', more = {}) => (await call('POST', '/api/parties', { type, name, ...more })).id as string;
const add = async (domain: string, data: Record<string, unknown>, more = {}) => (await call('POST', `/api/data/${domain}`, { data, ...more })).id as string;

await add('names', { kind: 'legal', full: 'Maya Elin Lindqvist', given: 'Maya', middle: 'Elin', family: 'Lindqvist', reason: 'birth' }, { validFrom: '1984-03-09' });
await add('birth', { date: '1984-03-09', time: '06:42:17', timeZone: 'America/Chicago', city: 'Peoria', region: 'Illinois', country: 'US', coordinates: { lat: 40.6936, lon: -89.589 } });
const passport = await add('ids', { kind: 'passport', number: 'X1234567', issuer: 'US', expires: '2031-04' });
await add('citizenship', { country: 'US', status: 'citizen', acquiredBy: 'birth', provenBy: [passport] }, { validFrom: '1984' });
await add('citizenship', { country: 'CA', status: 'permanent_resident' }, { validFrom: '2020' });
await add('contact_methods', { kind: 'phone', value: '(503) 555-0148', label: 'Mobile', primary: true });
const landlord = await party('Pat Okoro', 'person');
await add('residences', { street1: '2214 SE Ankeny St', city: 'Portland', region: 'OR', postalCode: '97214', country: 'US', ownership: 'rent', landlord, primary: true }, { validFrom: '2019-06' });
await add('residences', { street1: '12 Kungsgatan', city: 'Stockholm', country: 'SE', ownership: 'rent' }, { validFrom: '2012-01', validTo: '2019-05' });
const robin = await party('Robin Lindqvist', 'person', { birthDate: '1983-11-20' });
await add('relationships', { party: robin, relation: 'spouse' }, { validFrom: '2015-08' });
const alder = await party('Alder Studio');
const ana = await party('Ana Ruiz', 'person', { affiliations: [{ party: alder, role: 'Design director' }] });
const job = await add('employment', { employer: alder, title: 'Design lead', arrangement: 'hybrid', location: { city: 'Portland', region: 'OR', country: 'US' }, supervisor: ana, currentPay: { amount: 120000, currency: 'USD', period: 'year' } }, { validFrom: '2021-03' });
await add('employment', { employer: await party('Kiln Co'), title: 'Ceramicist', endedHow: 'resigned', startingPay: { amount: 28, currency: 'USD', period: 'hour' } }, { validFrom: '2016-01', validTo: '2021-02' });
await add('relationships', { party: ana, relation: 'reference', job });
await add('education', { institution: await party('Konstfack'), level: 'master', degree: 'MFA', field: 'Ceramics', outcome: 'graduated', conferredOn: '2014-06-05' }, { validFrom: '2012-09', validTo: '2014-06' });
await add('awards', { name: 'Oregon Craft Award', issuer: await party('Oregon Arts Commission'), date: '2023-05' });
await add('conditions', { name: 'Gluten sensitivity', status: 'suspected' }, { validFrom: '2025-02' });
await add('medications', { name: 'Magnesium glycinate', kind: 'supplement', dose: '200 mg', frequency: 'nightly' }, { validFrom: '2025-03' });
await add('observations', { what: 'Energy', value: '6', unit: '1–10', at: { at: '2026-11-05T08:00', tz: 'America/Los_Angeles' } });
const bank = await party('Harbor Credit Union');
await add('financial_accounts', { kind: 'checking', institution: bank, nickname: 'Everyday', number: '000123456789', routingNumber: '123000848', status: 'current' }, { validFrom: '2019-07' });
const car = await add('vehicles', { kind: 'car', make: 'Subaru', model: 'Outback', year: 2019, vin: '4S4BSANC5K3123456', registeredIn: 'US-OR', registrationExpires: '2027-03', heldAs: 'financed' }, { validFrom: '2019-09' });
await add('financial_accounts', { kind: 'loan', institution: bank, finances: car, status: 'current' }, { validFrom: '2019-09' });
await add('insurance', { kind: 'auto', insurer: await party('Northwest Mutual'), premium: { amount: 96, currency: 'USD', period: 'month' }, coversThings: [car], coversPeople: [robin] }, { validFrom: '2025-01' });
await add('receipts', { merchant: await party('Blue Bottle'), purchased: '2026-10-01', total: { amount: 12.5, currency: 'USD' }, category: 'dining', paymentMethod: 'cash' });
await add('events', { title: 'Book club', start: { at: '2026-01-12T19:00', tz: 'America/Los_Angeles' }, end: { at: '2026-01-12T21:00', tz: 'America/Los_Angeles' }, repeat: 'FREQ=MONTHLY;BYDAY=2MO', location: 'Powell’s' });
await add('preferences', { category: 'drink', name: 'Coffee order', value: 'Oat flat white' });

console.log(`
Little Dipper demo is running: ${base}
  Sign in with the password:  ${PASSWORD}
  Authenticator code:         npm run demo -w server -- code
Stop with Ctrl-C (the demo's data is deleted).
`);
