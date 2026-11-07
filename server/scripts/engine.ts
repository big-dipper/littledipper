/**
 * Unit tests for the records engine: part types, per-entry sensitivity, parts that only apply in some
 * states, single-entry categories and links between entries. Runs in-process on a throwaway store,
 * so it's fast; the HTTP behaviour is covered by smoke.ts.
 *
 *   npm run engine -w server
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ctx } from '../src/ctx.js';
import { isEncrypted, newId } from '../src/crypto.js';
import { newKeystore } from '../src/keystore.js';
import { openStore } from '../src/store/index.js';
import { buildRecord, describeRepeat, trackPartyNames, displayValue, entrySens, recordOut } from '../src/domains/records.js';
import { shapeRecords } from '../src/domains/sharing.js';
import type { Actor, DomainDef, PartDef } from '../src/domains/types.js';

let failures = 0;
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? '✓' : '✗'} ${what}`); if (!cond) failures++; };
async function rejects(fn: () => Promise<unknown>, code: string, what: string) {
  try { await fn(); ok(false, what); } catch (e) { ok((e as { code?: string }).code === code, `${what} (${(e as Error).message})`); }
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'ld-engine-'));
ctx.store = trackPartyNames(await openStore({ dataDir: dir }));
ctx.keys = newKeystore();
const owner: Actor = { type: 'owner', id: 'test' };

const domain = (id: string, parts: PartDef[], extra: Partial<DomainDef> = {}): DomainDef => ({
  id, label: id, noun: id, group: 'custom', description: '', sensitivity: 'sensitive', parts, dated: false, title: `{${parts[0].key}}`,
  publicable: false, builtIn: false, schemaVersion: 1, ...extra,
});
const save = async (d: DomainDef, data: Record<string, unknown>, more = {}) => {
  const r = await buildRecord(d, { data, ...more }, null, owner);
  await ctx.store.insert('records', r);
  return r;
};

try {
  console.log('part types');
  const t = domain('types', [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'region', label: 'Region', type: 'region' },
    { key: 'home', label: 'Home', type: 'address' },
    { key: 'repeat', label: 'Repeats', type: 'repeat' },
    { key: 'pay', label: 'Pay', type: 'money', periodic: true },
    { key: 'who', label: 'Who', type: 'party' },
  ]);
  const r1 = await buildRecord(t, { data: { name: 'x', region: 'us-or', home: { street1: ' 1 Main St ', city: 'Portland', country: 'us' }, repeat: 'rrule:freq=monthly;byday=2mo', pay: { amount: '42.5', currency: 'usd', period: 'hour' } } }, null, owner);
  ok(r1.data.region === 'US-OR', 'a region code is normalised: US-OR');
  ok(JSON.stringify(r1.data.home) === JSON.stringify({ street1: '1 Main St', city: 'Portland', country: 'US' }), 'an address keeps only what was given, trimmed');
  ok(r1.data.repeat === 'FREQ=MONTHLY;BYDAY=2MO', 'a repeat rule is stored as a plain RRULE');
  ok(describeRepeat('FREQ=MONTHLY;BYDAY=2MO') === 'Monthly on the second Monday', 'and reads as "Monthly on the second Monday"');
  ok(describeRepeat('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=10') === 'Every 2 weeks on Tuesday, 10 times', 'and "Every 2 weeks on Tuesday, 10 times"');
  ok(displayValue(t.parts[4], r1.data.pay) === '$42.50 an hour', 'pay shows its period: $42.50 an hour');
  ok(displayValue(t.parts[1], 'US-OR') === 'OR, United States', 'a region shows with its country');
  await rejects(() => buildRecord(t, { data: { name: 'x', region: 'Oregon' } }, null, owner), 'invalid_value', 'a region name instead of a code is refused');
  await rejects(() => buildRecord(t, { data: { name: 'x', home: { city: 'Portland' } } }, null, owner), 'invalid_value', 'an address needs a country');
  await rejects(() => buildRecord(t, { data: { name: 'x', home: { city: 'Portland', country: 'US', zip: '1' } } }, null, owner), 'invalid_value', 'an address refuses unknown lines');
  await rejects(() => buildRecord(t, { data: { name: 'x', repeat: 'FREQ=WEEKLY;COUNT=3;UNTIL=20270101' } }, null, owner), 'invalid_value', 'a repeat rule can’t have both COUNT and UNTIL');
  await rejects(() => buildRecord(t, { data: { name: 'x', pay: { amount: 10, currency: 'USD' } } }, null, owner), 'invalid_value', 'periodic money must say per what');
  await rejects(() => buildRecord(t, { data: { name: 'x', who: 'con_nobody' } }, null, owner), 'invalid_value', 'a party must exist');
  const party = { _id: newId('pty'), type: 'person', name: 'Ana Ruiz', methods: [], notes: '', affiliations: [], node: null, sharedIn: [], sharedInFetchedAt: null, createdAt: '' };
  await ctx.store.insert('parties', party);
  ok((await buildRecord(t, { data: { name: 'x', who: party._id } }, null, owner)).data.who === party._id, 'a party that exists is linked by id');

  console.log('links between entries');
  const ids = domain('ids', [{ key: 'kind', label: 'Kind', type: 'text' }, { key: 'number', label: 'Number', type: 'text', sensitivity: 'secret' }], { sensitivity: 'secret' });
  const cit = domain('citizenship', [{ key: 'country', label: 'Country', type: 'country' }, { key: 'provenBy', label: 'Proven by', type: 'record', to: ['ids'], many: true }]);
  const other = domain('other', [{ key: 'x', label: 'X', type: 'text' }]);
  const passport = await save(ids, { kind: 'passport', number: 'X1234567' });
  const note = await save(other, { x: 'not an ID' });
  const c = await save(cit, { country: 'US', provenBy: [passport._id] });
  ok(JSON.stringify(c.data.provenBy) === JSON.stringify([passport._id]), 'a citizenship points to the passport that proves it');
  await rejects(() => buildRecord(cit, { data: { country: 'US', provenBy: [note._id] } }, null, owner), 'invalid_value', 'a link only points to the categories it allows');
  await rejects(() => buildRecord(cit, { data: { country: 'US', provenBy: ['rec_missing'] } }, null, owner), 'invalid_value', 'a link must point to an entry that exists');
  await rejects(() => buildRecord(cit, { data: { country: 'US', provenBy: [passport._id, passport._id] } }, null, owner), 'invalid_value', 'the same entry can’t be linked twice');
  const shared = await shapeRecords(cit, [c], false);
  const proof = shared[0].fields.find((f) => f.key === 'provenBy');
  ok(!proof && !JSON.stringify(shared).includes(passport._id) && !JSON.stringify(shared).includes('X1234567'), "sharing a citizenship without the passport leaves the link out entirely: no hint, no passport");
  const both = await shapeRecords(cit, [c], false, new Map([[passport._id, { d: ids, r: passport }]]));
  const linked = both[0].fields.find((f) => f.key === 'provenBy');
  ok(linked?.links?.[0]?.id === passport._id && !JSON.stringify(both).includes('X1234567'), 'shared alongside the passport, the link names it (its secret number still masked)');

  console.log('per-entry sensitivity');
  const names = domain('names', [{ key: 'kind', label: 'Kind', type: 'text', sensitivity: 'sensitive' }, { key: 'full', label: 'Full name', type: 'text' }],
    { sensitivityBy: { part: 'kind', values: { preferred: 'standard', professional: 'standard' } } });
  const pref = await buildRecord(names, { data: { kind: 'preferred', full: 'Bry' } }, null, owner);
  const legal = await buildRecord(names, { data: { kind: 'legal', full: 'Bryan Q. Public' } }, null, owner);
  ok(entrySens(names, pref, { kind: 'preferred' }) === 'standard' && entrySens(names, legal, { kind: 'legal' }) === 'sensitive', 'each kind starts at its own default: preferred standard, legal sensitive');
  const hidden = await buildRecord(names, { data: { kind: 'legal', full: 'Bryan Q. Public' }, sensitivity: 'secret' }, null, owner);
  ok(isEncrypted(hidden.data.full) && isEncrypted(hidden.data.kind), 'an entry set to secret encrypts every part of it');
  const idsD = domain('ids2', [{ key: 'kind', label: 'Kind', type: 'text' }, { key: 'number', label: 'Number', type: 'text', sensitivity: 'secret' }], { sensitivity: 'standard' });
  const card = await buildRecord(idsD, { data: { kind: 'library', number: '12345' } }, null, owner);
  ok(isEncrypted(card.data.number) && card.data.kind === 'library', 'a part declared secret stays secret even in a standard entry: declared sensitivity is a floor');
  const out = recordOut(names, hidden);
  ok(out.sensitivity === 'secret' && !out.sensitivityDefault && out.masked.includes('full') && out.data.full !== 'Bryan Q. Public', 'and its value is masked on the way out');
  const back = await buildRecord(names, { sensitivity: null }, hidden, owner);
  ok(back.data.full === 'Bryan Q. Public' && !back.sensitivity, 'going back to the default decrypts it again');
  ok((await shapeRecords(names, [hidden], false))[0].fields.every((f) => f.key !== 'full'), 'a secret entry’s parts aren’t shared without the secret confirm');
  await rejects(() => buildRecord(names, { data: { kind: 'legal', full: 'x' }, sensitivity: 'top' as never }, null, owner), 'invalid_value', 'sensitivity must be standard, sensitive or secret');

  console.log('parts that apply only in some states');
  const acct = domain('accounts', [
    { key: 'status', label: 'Status', type: 'enum', options: [['current', 'Current'], ['in_collections', 'In collections']] },
    { key: 'collector', label: 'Collector', type: 'text', required: true, when: { part: 'status', in: ['in_collections'] } },
  ]);
  ok(!!(await buildRecord(acct, { data: { status: 'current' } }, null, owner)), 'a part required only in collections isn’t required otherwise');
  await rejects(() => buildRecord(acct, { data: { status: 'in_collections' } }, null, owner), 'required', 'it is required once the account is in collections');
  await rejects(() => buildRecord(acct, { data: { status: 'current', collector: 'Midland' } }, null, owner), 'not_applicable', 'and can’t be set while it doesn’t apply');
  const coll = await buildRecord(acct, { data: { status: 'in_collections', collector: 'Midland' } }, null, owner);
  const paid = await buildRecord(acct, { data: { status: 'current' } }, coll, owner);
  ok(paid.data.collector === 'Midland', 'a value set while it applied is kept when the status moves on: it was true');

  console.log('single-entry categories');
  const birth = domain('birth', [{ key: 'date', label: 'Date of birth', type: 'date' }], { single: true });
  await save(birth, { date: '1984-03-09' });
  await rejects(() => buildRecord(birth, { data: { date: '1990-01-01' } }, null, owner), 'single_entry', 'a single-entry category refuses a second entry');
} finally {
  await ctx.store.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed.` : '\nAll good.');
process.exit(failures ? 1 : 0);
