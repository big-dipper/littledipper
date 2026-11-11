/**
 * A local Little Dipper with sample data, to try the app without touching a real node. Starts a fresh node in a
 * throwaway folder, claims it, fills in a life's worth of sample entries and prints how to sign in.
 *
 *   npm run demo -w server              (Maya at http://localhost:4300, Theo at :4301; stop with Ctrl-C, the data is deleted)
 *   npm run demo -w server -- code      (a sign-in code for Maya's node)
 *   npm run demo -w server -- code theo (a sign-in code for Theo's node)
 *
 * Two nodes, already connected, so sharing can be tried from both sides. Sign in with the password it prints and a code. Built web files are served, so run
 * `npm run build -w web` first after changing the web app.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticator } from 'otplib';
import { SoftKey } from './softkey.js';

const PASSWORD = 'little-dipper-demo';
/** DEMO_PORT moves the demo (Maya on it, Theo on the next), so two demos can run side by side. */
const PORT = Number(process.env.DEMO_PORT || 4300);
const secretFile = (who: string) => path.join(os.tmpdir(), `little-dipper-demo${PORT === 4300 ? '' : `-${PORT}`}${who === 'maya' ? '' : `-${who}`}.totp`);

if (process.argv.includes('code')) {
  const who = process.argv.includes('theo') ? 'theo' : 'maya';
  console.log(authenticator.generate(readFileSync(secretFile(who), 'utf8').trim()));
  process.exit(0);
}

/** A tiny client with its own cookie jar: one per node. */
function client(base: string) {
  const jar = new Map<string, string>();
  return async function call<T = any>(method: string, p: string, body?: unknown): Promise<T> {
    const res = await fetch(base + p, {
      method,
      headers: { origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (v) jar.set(k, v); else jar.delete(k); }
    const text = await res.text();
    if (res.status >= 400) throw new Error(`${method} ${p} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

const dirs: string[] = [];
const procs: ReturnType<typeof spawn>[] = [];
const stop = () => { for (const p of procs) p.kill(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

/** Start a fresh node, claim it as `name` with a software passkey, and set a password and authenticator. */
async function node(port: number, name: string, who: string) {
  const base = `http://localhost:${port}`;
  const signin = randomBytes(16).toString('hex');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ld-demo-'));
  dirs.push(dir);
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), LD_DATA_DIR: dir, LOG_LEVEL: 'warn', LD_PUBLIC_URL: base, LD_COOKIE_SUFFIX: String(port), LD_DEMO_SIGNIN: signin },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  procs.push(proc);
  const claimUrl: string = await new Promise((resolve) => {
    let out = '';
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = out.match(/https?:\/\/\S+\/claim\?token=\S+/);
      if (m && out.includes('Answering at')) resolve(m[0]);
    });
  });
  const call = client(base);
  const key = new SoftKey();
  await call('POST', '/api/node/claim', { token: new URL(claimUrl).searchParams.get('token') });
  await call('POST', '/api/owner', { displayName: name, email: `${name.split(' ')[0].toLowerCase()}@example.com` });
  const reg = await call('POST', '/api/auth/passkeys/register/options', {});
  await call('POST', '/api/auth/passkeys/register', { challengeId: reg.challengeId, response: key.register(reg.options, base), label: 'Demo key' });
  await call('POST', '/api/auth/recovery-codes', {});
  await call('POST', '/api/node/claim/complete', {});
  await call('PUT', '/api/auth/password', { password: PASSWORD });
  const { secret } = await call('POST', '/api/auth/totp/setup', {});
  await call('POST', '/api/auth/totp/enable', { code: authenticator.generate(secret) });
  writeFileSync(secretFile(who), secret);
  return { base, call, link: `${base}/api/auth/demo?t=${signin}` };
}

const maya = await node(PORT, 'Maya Lindqvist', 'maya');
const theo = await node(PORT + 1, 'Theo Nakamura', 'theo');
const call = maya.call;

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
// Income: a year from the W-2, then this autumn's paychecks and a couple of ceramics sales.
await add('income', { received: '2025-12-31', amount: { amount: 82340, currency: 'USD' }, gross: { amount: 116500, currency: 'USD' }, kind: 'wages', payer: alder, source: job, taxForm: 'w2', periodStart: '2025-01-01', periodEnd: '2025-12-31' });
const paychecks: [string, string][] = [];
for (const [day, start] of [['2026-09-04', '2026-08-17'], ['2026-09-18', '2026-08-31'], ['2026-10-02', '2026-09-14'], ['2026-10-16', '2026-09-28'], ['2026-10-30', '2026-10-12']]) {
  const end = new Date(Date.parse(start) + 13 * 86400_000).toISOString().slice(0, 10);
  paychecks.push([day, await add('income', { received: day, amount: { amount: 3412.5, currency: 'USD' }, gross: { amount: 4615.38, currency: 'USD' }, kind: 'wages', payer: alder, source: job, how: 'direct_deposit', periodStart: start, periodEnd: end })]);
}
const etsy = await party('Etsy');
await add('income', { received: '2026-06-14', amount: { amount: 418.2, currency: 'USD' }, kind: 'gig', payer: etsy }, { notes: 'Mugs, spring batch' });
const lampSale = await add('income', { received: '2026-10-21', amount: { amount: 640, currency: 'USD' }, kind: 'gig', payer: etsy }, { notes: 'Lamp bases' });
await add('conditions', { name: 'Gluten sensitivity', status: 'suspected' }, { validFrom: '2025-02' });
await add('medications', { name: 'Magnesium glycinate', kind: 'supplement', dose: '200 mg', frequency: 'nightly' }, { validFrom: '2025-03' });
const pdx = (at: string) => ({ at, tz: 'America/Los_Angeles' });
for (const [at, v] of [['2026-10-20T07:30', '132/86'], ['2026-10-27T07:40', '128/84'], ['2026-11-03T07:35', '124/80']]) await add('measurements', { what: 'Blood pressure', value: v, unit: 'mmHg', at: pdx(at), kind: 'home' });
await add('measurements', { what: 'A1C', value: '5.4', unit: '%', at: pdx('2026-09-12T09:00'), kind: 'lab', by: await party('Providence Lab Services'), range: 'Below 5.7' });
const bank = await party('Harbor Credit Union');
const checking = await add('financial_accounts', { kind: 'checking', institution: bank, nickname: 'Everyday', number: '000123456789', routingNumber: '123000848', status: 'current' }, { validFrom: '2019-07' });
const car = await add('vehicles', { kind: 'car', make: 'Subaru', model: 'Outback', year: 2019, vin: '4S4BSANC5K3123456', registeredIn: 'US-OR', registrationExpires: '2027-03', heldAs: 'financed' }, { validFrom: '2019-09' });
const loan = await add('financial_accounts', { kind: 'loan', institution: bank, finances: car, status: 'current' }, { validFrom: '2019-09' });
const nwMutual = await party('Northwest Mutual');
await add('insurance', { kind: 'auto', insurer: nwMutual, premium: { amount: 96, currency: 'USD', period: 'month' }, coversThings: [car], coversPeople: [robin] }, { validFrom: '2025-01' });
const blueBottle = await party('Blue Bottle');
const coffee = await add('receipts', { merchant: blueBottle, purchased: '2026-10-01', total: { amount: 12.5, currency: 'USD' }, category: 'dining', paymentMethod: 'cash' });
// Transactions: the plain story of money moving, pointing to the income entry or receipt where there is one.
const usd = (amount: number) => ({ amount, currency: 'USD' });
for (const [day, id] of paychecks) await add('transactions', { date: day, direction: 'in', amount: usd(3412.5), counterparty: alder, category: 'income', account: checking, method: 'direct_deposit', description: 'ALDER STUDIO PAYROLL', entry: id });
await add('transactions', { date: '2026-10-22', direction: 'in', amount: usd(640), counterparty: etsy, category: 'income', account: checking, method: 'bank_transfer', description: 'ETSY INC PAYOUT', entry: lampSale });
for (const day of ['2026-09-01', '2026-10-01', '2026-11-01']) await add('transactions', { date: day, direction: 'out', amount: usd(1850), counterparty: landlord, category: 'housing', account: checking, method: 'app', description: 'Rent' });
for (const day of ['2026-09-15', '2026-10-15']) await add('transactions', { date: day, direction: 'out', amount: usd(412.37), counterparty: bank, category: 'debt', account: checking, method: 'autopay', description: 'HARBOR CU LOAN PMT', entry: car });
await add('transactions', { date: '2026-10-01', direction: 'out', amount: usd(12.5), counterparty: blueBottle, category: 'dining', method: 'cash', entry: coffee });
await add('transactions', { date: '2026-10-28', direction: 'out', amount: usd(96), counterparty: nwMutual, category: 'insurance', account: checking, method: 'autopay', description: 'NW MUTUAL AUTO' });
await add('events', { title: 'Book club', start: { at: '2026-01-12T19:00', tz: 'America/Los_Angeles' }, end: { at: '2026-01-12T21:00', tz: 'America/Los_Angeles' }, repeat: 'FREQ=MONTHLY;BYDAY=2MO', location: 'Powell’s' });
await add('preferences', { category: 'drink', name: 'Coffee order', value: 'Oat flat white' });
await add('contact_methods', { kind: 'website', value: 'mayalind.studio' });
await add('contact_methods', { kind: 'social', service: 'Instagram', value: '@maya.makes' });
await add('contact_methods', { kind: 'messaging', service: 'Signal', value: 'maya.07' });

// Maya's public page: a card, then her details, ways to reach her and her work, each folded to a line.
await call('PUT', '/api/public-profile', {
  headline: 'Designer and ceramicist',
  fieldKeys: ['legal_name', 'born', 'citizenship', 'marital_status', 'lives_in'],
  sections: [
    { type: 'about', text: 'I make furniture and lighting that lasts. Happy to talk about craft, production, or clay.' },
    { type: 'details' },
    { type: 'domain', domain: 'contact_methods' },
    { type: 'domain', domain: 'employment' },
    { type: 'domain', domain: 'education' },
  ],
});

// ── Theo, a friend on his own Little Dipper, connected through an invite ──
await theo.call('POST', '/api/data/residences', { data: { street1: '88 Rose St', city: 'Seattle', region: 'WA', country: 'US', primary: true }, validFrom: '2020-04' });
await theo.call('POST', '/api/data/contact_methods', { data: { kind: 'phone', value: '(206) 555-0199', primary: true } });
// Theo asks to connect (with a note, offering his phone, asking for Maya's address) and waits for Maya: the connect moment.
const invite = await call('POST', '/api/federation/invites', { expiresIn: '7d' });
await theo.call('POST', '/api/federation/requests', { address: invite.url, note: 'Hi Maya, it’s Theo from the studio', share: { basic: true, lines: ['phone'] }, asks: ['address'] });

console.log(`
Little Dipper demo is running, two nodes. Theo has asked to connect: see Contacts on Maya's node.
  Maya, one click:  ${maya.link}
  Theo, one click:  ${theo.link}
  (Or sign in normally; codes: npm run demo -w server -- code [theo])
  Password for both:  ${PASSWORD}
Stop with Ctrl-C (the demo's data is deleted).
`);
