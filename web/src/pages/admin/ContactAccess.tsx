/**
 * "What Theo sees": the one place to change what a connected person gets. A plain list of what they get now, each
 * line removable, and "Add something" to share one more thing on purpose: a line from your card, a whole category
 * (seen entry by entry before you choose) or a single entry. Presets belong to the connect moment only; here every
 * change is a specific one, so nothing is ever overwritten.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, put, type PartyDetail as ContactDetail, type ProfileLine as Field, type SharedRecord } from '../../api';
import { Confirm, useAction, useAsync, type ConfirmCfg } from '../../ui';
import { EntryCard, fetchCatalog, fmtRange, GROUPS, Lock, Mono, Select, type CardField, type Domain, type Rec } from '../../life';

type Grants = ContactDetail['share'];
type DomainGrant = { scope: 'all' | 'current'; includeSecret: boolean };

const entries = (n: number) => `${n} entr${n === 1 ? 'y' : 'ies'}`;
const secretPartsOf = (d: Domain) => d.parts.filter((p) => p.sensitivity === 'secret').map((p) => p.label.toLowerCase());

export default function ContactAccess({ c, fields, first, onGrants, onPreview }: { c: ContactDetail; fields: Field[]; first: string; onGrants: (g: Grants) => void; onPreview: () => void }) {
  const { run, busy } = useAction();
  const { data: catalog } = useAsync(fetchCatalog, []);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const [adding, setAdding] = useState(false);
  const [peek, setPeek] = useState<string | null>(null);
  const grants = c.share;
  const dg = grants.categories || {};

  const send = async (body: object, msg?: string) => {
    const g = await run(() => put<Grants>(`/api/parties/${c.id}/share`, body), msg);
    if (g) onGrants(g);
    return g;
  };

  // Secret lines never leave, so they're never offered.
  const basicLines = fields.filter((f) => f.inBasic);
  const lineOf = (k: string) => fields.find((f) => f.key === k);
  const offeredLines = fields.filter((f) => f.sensitivity !== 'secret' && f.key !== 'little_dipper' && f.value && !grants.lines.includes(f.key) && !(grants.basic && f.inBasic));
  const sharedCats = catalog?.filter((d) => dg[d.id]) ?? [];
  const nothing = !grants.basic && !grants.lines.length && !sharedCats.length && !grants.entries.length;

  const shareCategory = (d: Domain, grant: DomainGrant) => {
    if ((d.confirmShare && !dg[d.id]) || (grant.includeSecret && !dg[d.id]?.includeSecret)) {
      const secret = secretPartsOf(d);
      return setConfirm({
        title: `Share ${d.label} with ${first}?`,
        body: grant.includeSecret
          ? `${first} will also see the secret details: ${secret.join(', ')}. Each read is logged in your activity.`
          : `${d.label} holds sensitive records. ${first} will see them until you remove them here.${secret.length ? ` Secret details (${secret.join(', ')}) stay hidden.` : ''} Each read is logged.`,
        cta: 'Share it',
        onConfirm: async () => { await send({ categories: { [d.id]: grant }, confirm: true }, `${d.label} shared with ${first}`); setConfirm(null); setAdding(false); },
      });
    }
    return send({ categories: { [d.id]: grant } }, `${d.label} shared with ${first}`).then(() => setAdding(false));
  };

  return (
    <div className="card" style={{ padding: '20px 24px', gap: 12, marginTop: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div className="card-kicker">What {first} sees</div>
        {!nothing && <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={onPreview}>See it as {first} does</button>}
      </div>

      <div style={{ display: 'grid' }}>
        {nothing && <div className="text-muted" style={{ fontSize: 14, padding: '6px 0' }}>Nothing yet. {first} only sees what you add here.</div>}
        {grants.basic && (
          <Line title="Your basic profile" sub={basicLines.map((f) => f.label).join(' · ')} remove={() => send({ basic: false }, `${first} no longer sees your basic profile`)}
            extra={<Link to="/admin/life/profile" className="text-muted" style={{ fontSize: 12 }}>What’s in it</Link>} />
        )}
        {grants.lines.map((k) => {
          const f = lineOf(k);
          return <Line key={k} title={f?.label ?? k} sub={f?.value || 'Not added yet'} remove={() => send({ lines: { [k]: false } }, `${first} no longer sees your ${(f?.label ?? k).toLowerCase()}`)} />;
        })}
        {sharedCats.map((d) => {
          const g = dg[d.id];
          const n = d.dated && g.scope === 'current' ? d.currentCount ?? 0 : d.count;
          return (
            <div key={d.id}>
              <Line mono={d} title={d.label}
                sub={<>{d.dated ? (g.scope === 'current' ? `What’s current · ${entries(n)}` : `Past and present · ${entries(n)}`) : entries(n)}{g.includeSecret ? ', with secret details' : ''}</>}
                extra={<>
                  {!!d.count && <button className="bare text-muted" style={{ fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }} aria-expanded={peek === d.id} onClick={() => setPeek(peek === d.id ? null : d.id)}>{peek === d.id ? 'Hide' : 'See them'}</button>}
                  {d.dated && (d.currentCount ?? 0) < d.count && (
                    <button className="bare text-muted" style={{ fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }} disabled={busy}
                      onClick={() => send({ categories: { [d.id]: { ...g, scope: g.scope === 'current' ? 'all' : 'current' } } }, g.scope === 'current' ? `${first} now sees past ones too` : `${first} now sees only what’s current`)}>
                      {g.scope === 'current' ? 'Add past ones' : 'Only what’s current'}
                    </button>
                  )}
                  {secretPartsOf(d).length > 0 && (
                    <button className="bare text-muted" style={{ fontSize: 12, cursor: 'pointer', textDecoration: 'underline', display: 'inline-flex', gap: 4, alignItems: 'center' }} disabled={busy}
                      onClick={() => (g.includeSecret ? send({ categories: { [d.id]: { ...g, includeSecret: false } } }, 'Secret details hidden again') : shareCategory(d, { ...g, includeSecret: true }))}>
                      <Lock />{g.includeSecret ? 'Hide secret details' : 'Include secret details'}
                    </button>
                  )}
                </>}
                remove={() => send({ categories: { [d.id]: false } }, `${first} no longer sees ${d.label}`)} />
              {peek === d.id && <WhatGoes d={d} partyId={c.id} scope={g.scope} secret={g.includeSecret} first={first} />}
            </div>
          );
        })}
        {grants.entries.map((e) => (
          <Line key={e.id} title={e.title ?? 'An entry'} sub={e.domainLabel} remove={() => send({ entries: { [e.id]: false } }, `${first} no longer sees ${e.title ?? 'it'}`)} />
        ))}
      </div>

      {c.asked.length > 0 && <div className="text-muted" style={{ fontSize: 13 }}>You asked {first} for {c.asked.map((x) => `${x.label.toLowerCase()} (${x.shared ? 'shared' : 'not shared'})`).join(', ')}.</div>}

      {!adding ? (
        <button className="btn btn-secondary" style={{ justifySelf: 'start' }} onClick={() => setAdding(true)}>+ Add something</button>
      ) : catalog && (
        <AddSomething c={c} first={first} catalog={catalog} basicOff={!grants.basic} basicLines={basicLines} lines={offeredLines} busy={busy}
          addBasic={() => send({ basic: true }, `${first} sees your basic profile`).then(() => setAdding(false))}
          addLine={(f) => send({ lines: { [f.key]: true } }, `${f.label} shared with ${first}`).then(() => setAdding(false))}
          addCategory={shareCategory} send={send} ask={setConfirm} onDone={() => setAdding(false)} />
      )}
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

/** One thing they see: what it is, a word on what's in it, and the way to stop sharing it. */
function Line({ title, sub, mono, extra, remove }: { title: string; sub?: React.ReactNode; mono?: Domain; extra?: React.ReactNode; remove: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--color-divider)' }}>
      {mono && <Mono d={mono} size={30} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14 }}>{title}</div>
        {sub && <div className="text-muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{sub}</div>}
        {extra && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 2 }}>{extra}</div>}
      </div>
      <button className="btn btn-ghost" aria-label={`Stop sharing ${title}`} title="Stop sharing" onClick={remove} style={{ padding: '4px 10px', fontSize: 16 }}>×</button>
    </div>
  );
}

/** The picker: your card first, then whole categories (look before you share), then one entry at a time. */
function AddSomething({ c, first, catalog, basicOff, basicLines, lines, busy, addBasic, addLine, addCategory, send, ask, onDone }: {
  c: ContactDetail; first: string; catalog: Domain[]; basicOff: boolean; basicLines: Field[]; lines: Field[]; busy: boolean;
  addBasic: () => void; addLine: (f: Field) => void; addCategory: (d: Domain, g: DomainGrant) => void;
  send: (body: object, msg?: string) => Promise<unknown>; ask: (cfg: ConfirmCfg | null) => void; onDone: () => void;
}) {
  const [look, setLook] = useState<string | null>(null);
  const cats = catalog.filter((d) => !d.oneAtATime && d.count > 0 && !c.share.categories[d.id]);
  const pickRow = { display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '8px 10px', borderRadius: 14, textAlign: 'left' as const, cursor: 'pointer' };
  return (
    <div style={{ borderRadius: 22, background: 'var(--color-neutral-100)', padding: '14px 16px', display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Share something with {first}</div>
        <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={onDone}>Done</button>
      </div>

      {(basicOff || lines.length > 0) && (
        <div style={{ display: 'grid', gap: 2 }}>
          <SubHead>From your card</SubHead>
          {basicOff && <button className="bare pick" disabled={busy} style={pickRow} onClick={addBasic}><span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 14 }}>Your basic profile</span><span className="text-muted" style={{ fontSize: 12 }}>{basicLines.map((f) => f.label).join(' · ')}</span></span><span aria-hidden>+</span></button>}
          {lines.map((f) => (
            <button key={f.key} className="bare pick" disabled={busy} style={pickRow} onClick={() => addLine(f)}>
              <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 14 }}>{f.label}</span><span className="text-muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{f.value}</span></span><span aria-hidden>+</span>
            </button>
          ))}
        </div>
      )}

      {cats.length > 0 && (
        <div style={{ display: 'grid', gap: 2 }}>
          <SubHead>A whole category</SubHead>
          <div className="text-muted" style={{ fontSize: 12, margin: '0 10px 4px' }}>{first} sees new entries as you add them.</div>
          {GROUPS.flatMap((g) => cats.filter((d) => d.group === g.id)).map((d) => (
            <div key={d.id}>
              <button className="bare pick" style={pickRow} aria-expanded={look === d.id} onClick={() => setLook(look === d.id ? null : d.id)}>
                <Mono d={d} size={28} />
                <span style={{ flex: 1, fontSize: 14, display: 'flex', gap: 6, alignItems: 'center' }}>{d.label}{d.sensitivity === 'secret' && <Lock style={{ color: 'var(--color-accent-700)' }} />}</span>
                <span className="text-muted" style={{ fontSize: 12 }}>{entries(d.count)} {look === d.id ? '▾' : '▸'}</span>
              </button>
              {look === d.id && (
                <div style={{ padding: '0 10px 10px' }}>
                  <WhatGoes d={d} partyId={c.id} scope="all" secret={false} first={first} preview />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0 0 40px' }}>
                    {d.dated && (d.currentCount ?? 0) > 0 && (d.currentCount ?? 0) < d.count && <button className="btn btn-secondary" disabled={busy} onClick={() => addCategory(d, { scope: 'current', includeSecret: false })}>Share what’s current ({d.currentCount})</button>}
                    <button className="btn btn-primary" disabled={busy} onClick={() => addCategory(d, { scope: 'all', includeSecret: false })}>{d.count === 1 ? 'Share it' : `Share all ${d.count}`}</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gap: 6 }}>
        <SubHead>One entry</SubHead>
        <OneEntry c={c} catalog={catalog} first={first} send={send} ask={ask} onDone={onDone} />
      </div>
    </div>
  );
}

/**
 * What a category sends, entry by entry, as the person will see it, built by the same code as the real share, so
 * secret details appear only once you include them. Long categories show the first few and say how many more.
 */
function WhatGoes({ d, partyId, scope, secret, first, preview }: { d: Domain; partyId: string; scope: 'all' | 'current'; secret: boolean; first: string; preview?: boolean }) {
  const { data } = useAsync(() => get<{ records: SharedRecord[] }>(`/api/parties/${partyId}/preview/${d.id}${secret ? '?secret=1' : ''}`), [d.id, secret]);
  if (!data) return <div className="text-muted" style={{ fontSize: 12, margin: '8px 0 0 40px' }}>Loading…</div>;
  const goes = (r: SharedRecord) => scope === 'all' || r.current;
  const recs = [...data.records.filter(goes), ...data.records.filter((r) => !goes(r))];
  const secretParts = secretPartsOf(d);
  return (
    <div style={{ margin: '8px 0 6px 40px', display: 'grid', gap: 8 }}>
      {!preview && scope === 'current' && <div className="text-muted" style={{ fontSize: 12 }}>{first} sees the current ones. Past ones stay with you.</div>}
      {preview && secretParts.length > 0 && <div className="text-muted" style={{ fontSize: 12 }}>Secret details ({secretParts.join(', ')}) stay hidden unless you include them later.</div>}
      {recs.slice(0, PEEK).map((r) => (
        <div key={r.id} style={{ opacity: goes(r) ? 1 : 0.45 }}>
          <EntryCard theirs title={r.title} range={[fmtRange(r.validFrom, r.validTo), d.dated ? (r.current ? 'Current' : 'Past') : ''].filter(Boolean).join(' · ') || undefined}
            fields={r.fields.map((f): CardField => ({ key: f.key, label: f.label, text: f.value, type: f.type, rows: f.rows, links: f.links }))} />
        </div>
      ))}
      {recs.length > PEEK && <div className="text-muted" style={{ fontSize: 12 }}>and {recs.length - PEEK} more</div>}
    </div>
  );
}
const PEEK = 4;

/** Share one entry (just this residence, just this job). IDs, health, money and secret entries ask first. */
function OneEntry({ c, catalog, first, send, ask, onDone }: { c: ContactDetail; catalog: Domain[]; first: string; send: (body: object, msg?: string) => Promise<unknown>; ask: (cfg: ConfirmCfg | null) => void; onDone: () => void }) {
  const [domain, setDomain] = useState('');
  const [recs, setRecs] = useState<Rec[]>([]);
  const pick = async (d: string) => { setDomain(d); setRecs(d ? (await get<{ items: Rec[] }>(`/api/data/${d}`)).items : []); };
  const share = async (id: string) => {
    const d = catalog.find((x) => x.id === domain);
    const r = recs.find((x) => x.id === id);
    const title = r?.title ?? 'this entry';
    if (d?.confirmShare || r?.sensitivity === 'secret') {
      return ask({
        title: `Share ${title} with ${first}?`, body: `${first} will see it until you remove it here. Each read is logged in your activity.`, cta: 'Share it',
        onConfirm: async () => { await send({ entries: { [id]: true }, confirm: true }, `Shared with ${first}`); ask(null); onDone(); },
      });
    }
    await send({ entries: { [id]: true } }, `Shared with ${first}`);
    onDone();
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 6, padding: '0 10px' }}>
      <Select value={domain} onChange={pick} placeholder="From…" options={catalog.filter((d) => d.count > 0).map((d) => [d.id, d.label])} />
      {domain && <Select value="" onChange={(id) => id && share(id)} placeholder="Choose the entry"
        options={recs.filter((r) => !c.share.entries.some((e) => e.id === r.id)).map((r) => [r.id, r.title])} />}
    </div>
  );
}

const SubHead = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--color-neutral-600)', margin: '4px 10px 2px' }}>{children}</div>
);
