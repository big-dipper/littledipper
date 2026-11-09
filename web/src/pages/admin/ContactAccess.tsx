/**
 * "What {name} sees": the one editor for a connected person's access, laid out as optional attributes.
 * Profile first (basic profile + extra fields), then every life category with Off / Current / All.
 * Relationship presets belong to the connect moment only; here every change is a specific one.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, put, type PartyDetail as ContactDetail, type ProfileLine as Field, type SharedRecord } from '../../api';
import { Confirm, Pills, Toggle, useAction, useAsync, type ConfirmCfg } from '../../ui';
import { EntryCard, fetchCatalog, fmtRange, GROUPS, Lock, Mono, Select, type CardField, type Domain, type Rec } from '../../life';

type Grants = ContactDetail['share'];
type DomainGrant = { scope: 'all' | 'current'; includeSecret: boolean };
type Level = 'off' | 'current' | 'all';

export default function ContactAccess({ c, fields, first, onGrants, onPreview }: { c: ContactDetail; fields: Field[]; first: string; onGrants: (g: Grants) => void; onPreview: () => void }) {
  const { run, busy } = useAction();
  const { data: catalog } = useAsync(fetchCatalog, []);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const [extraOpen, setExtraOpen] = useState<boolean | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [peek, setPeek] = useState<string | null>(null);
  const grants = c.share;
  const dg = grants.categories || {};

  const send = async (body: object, msg?: string) => {
    const g = await run(() => put<Grants>(`/api/parties/${c.id}/share`, body), msg);
    if (g) onGrants(g);
    return g;
  };

  // ── profile fields ──
  // The basic profile is the owner's list (Profile basics); extras are lines added for this person.
  const standard = fields.filter((f) => f.inBasic);
  // Secret lines never leave, so they aren't offered.
  const extraRows = fields.filter((f) => (!f.inBasic || !grants.basic) && f.sensitivity !== 'secret' && f.key !== 'little_dipper');
  const extraOn = grants.lines.length;
  const requested = c.request?.requestedFields ?? [];
  const requestedSensitive = requested.some((k) => fields.find((f) => f.key === k)?.sensitivity !== 'standard');
  const showExtra = extraOpen ?? (extraOn > 0 || requestedSensitive);
  const toggleField = (f: Field) => {
    const on = grants.lines.includes(f.key);
    if (!on && f.sensitivity === 'secret') {
      return setConfirm({
        title: `Share ${f.label} with ${first}?`,
        body: `This is a secret field. ${first} will see the full value until you turn this off. Each read is logged in your activity.`,
        cta: 'Share it',
        onConfirm: async () => { await send({ lines: { [f.key]: true }, confirm: true }, `${f.label} shared with ${first}`); setConfirm(null); },
      });
    }
    send({ lines: { [f.key]: !on } });
  };

  // ── categories ──
  const levelOf = (d: Domain): Level => (dg[d.id] ? (d.dated ? dg[d.id].scope : 'all') : 'off');
  const hasSecretParts = (d: Domain) => d.parts.some((p) => p.sensitivity === 'secret');
  const setLevel = (d: Domain, level: Level, includeSecret = dg[d.id]?.includeSecret ?? false) => {
    if (level === 'off') return send({ categories: { [d.id]: false } }, `${d.label} hidden from ${first}`);
    const grant: DomainGrant = { scope: level === 'current' ? 'current' : 'all', includeSecret };
    if ((d.confirmShare && !dg[d.id]) || (includeSecret && !dg[d.id]?.includeSecret)) {
      const secretParts = d.parts.filter((p) => p.sensitivity === 'secret').map((p) => p.label.toLowerCase());
      return setConfirm({
        title: `Share ${d.label} with ${first}?`,
        body: includeSecret
          ? `${first} will also see the secret details: ${secretParts.join(', ')}. Each read is logged in your activity.`
          : `${d.label} holds sensitive records. ${first} will see it${d.dated ? (grant.scope === 'current' ? ' (current entries)' : ' (all entries)') : ''} until you turn this off.${secretParts.length ? ` Secret details (${secretParts.join(', ')}) stay hidden unless you include them.` : ''} Each read is logged.`,
        cta: 'Share it',
        onConfirm: async () => { await send({ categories: { [d.id]: grant }, confirm: true }, `${d.label} shared with ${first}`); setConfirm(null); },
      });
    }
    return send({ categories: { [d.id]: grant } });
  };

  const sharedDomains = catalog?.filter((d) => dg[d.id]) ?? [];
  const summary = [grants.basic ? 'Basic profile' : null, extraOn ? `${extraOn} extra field${extraOn === 1 ? '' : 's'}` : null, sharedDomains.length ? `${sharedDomains.length} categor${sharedDomains.length === 1 ? 'y' : 'ies'}` : null].filter(Boolean).join(' + ') || 'Nothing';

  return (
    <div className="card" style={{ padding: '22px 24px', gap: 14, marginTop: 22 }}>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div className="card-kicker">What {first} sees</div>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={onPreview}>See it as {first} does</button>
        </div>
        <div className="card-title" style={{ fontSize: 22, marginTop: 4 }}>{summary}</div>
        <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>Changes apply right away. {first}’s Little Dipper picks them up on its next sync, and every read is logged in your activity.</div>
      </div>

      {/* Profile */}
      <div style={{ display: 'grid', gap: 8 }}>
        <SubHead>Profile</SubHead>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderRadius: 24, background: 'var(--color-accent-2-100)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-accent-2-900)' }}>Your basic profile <Link to="/admin/life/profile" style={{ fontWeight: 400, fontSize: 12, marginLeft: 6 }}>Change what everyone gets</Link></div>
            <div style={{ fontSize: 13, color: 'var(--color-accent-2-800)' }}>{grants.basic ? standard.map((f) => f.label).join(' · ') : `Off. ${first} only sees what you switch on below.`}</div>
          </div>
          <Toggle on={grants.basic} label="Share basic profile" onChange={() => { send({ basic: !grants.basic }); if (grants.basic) setExtraOpen(true); }} />
        </div>
        <button className="btn btn-ghost" onClick={() => setExtraOpen(!showExtra)} style={{ justifySelf: 'start', fontSize: 13 }}>
          {showExtra ? 'Hide' : extraOn ? `Also for ${first} · ${extraOn}` : `Add something just for ${first}…`}
        </button>
        {showExtra && (
          <div style={{ display: 'grid' }}>
            {extraRows.map((f) => (
              <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--color-divider)' }}>
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 14 }}>{f.label}</div><div className="text-muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.value || 'Not added'}</div></div>
                {requested.includes(f.key) && <span className="tag tag-accent">Requested</span>}
                <Toggle on={grants.lines.includes(f.key)} label={`Share ${f.label}`} onChange={() => toggleField(f)} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Life categories */}
      <div style={{ display: 'grid', gap: 8 }}>
        <SubHead>Single entries</SubHead>
        <SingleEntries c={c} catalog={catalog ?? []} first={first} send={send} ask={setConfirm} />
        <SubHead>Whole categories</SubHead>
        {!catalog ? <div className="text-muted" style={{ fontSize: 13 }}>Loading…</div> : GROUPS.map((g) => {
          const list = catalog.filter((d) => d.group === g.id && !d.oneAtATime);
          if (!list.length) return null;
          const on = list.filter((d) => dg[d.id]).length;
          const open = openGroups[g.id] ?? on > 0;
          return (
            <div key={g.id} style={{ borderRadius: 22, background: open ? 'var(--color-neutral-100)' : 'transparent', border: open ? 'none' : '1px solid var(--color-divider)' }}>
              <button className="bare" aria-expanded={open} onClick={() => setOpenGroups({ ...openGroups, [g.id]: !open })} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 16px' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: g.ink, flex: 'none' }} />
                <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{g.label}</span>
                <span className={on ? 'tag tag-accent-2' : 'text-muted'} style={{ fontSize: on ? 11 : 12 }}>{on ? `${on} of ${list.length} shared` : `${list.length} categories`}</span>
                <span aria-hidden style={{ transform: `rotate(${open ? 90 : 0}deg)`, transition: 'transform .15s', fontSize: 12 }}>›</span>
              </button>
              {open && (
                <div style={{ padding: '0 16px 8px' }}>
                  {list.map((d) => {
                    const lvl = levelOf(d);
                    return (
                      <div key={d.id} style={{ padding: '10px 0', borderTop: '1px solid var(--color-divider)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <Mono d={d} size={30} />
                          <div style={{ flex: 1, minWidth: 120 }}>
                            <div style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>{d.label}{d.sensitivity === 'secret' && <Lock style={{ color: 'var(--color-accent-700)' }} />}</div>
                            {d.count ? (
                              <button type="button" className="bare text-muted" aria-expanded={peek === d.id} onClick={() => setPeek(peek === d.id ? null : d.id)} style={{ fontSize: 12, cursor: 'pointer', padding: 0, textAlign: 'left' }}>
                                {`${d.count} entr${d.count === 1 ? 'y' : 'ies'}${d.dated && d.currentCount ? ` · ${d.currentCount} current` : ''}`} <span style={{ textDecoration: 'underline' }}>{peek === d.id ? 'Hide' : 'See them'}</span>
                              </button>
                            ) : <div className="text-muted" style={{ fontSize: 12 }}>Nothing added yet</div>}
                          </div>
                          <Pills value={lvl} size={12} onChange={(v) => setLevel(d, v)}
                            options={d.dated ? [['off', 'Off'], ['current', 'Current'], ['all', 'All']] : [['off', 'Off'], ['all', 'Shared']]} />
                        </div>
                        {peek === d.id && <WhatGoes d={d} partyId={c.id} level={lvl} secret={!!dg[d.id]?.includeSecret} first={first} />}
                        {lvl !== 'off' && hasSecretParts(d) && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0 0 40px', fontSize: 12 }}>
                            <Lock style={{ color: 'var(--color-accent-700)' }} />
                            <span style={{ flex: 1 }} className="text-muted">Include secret details ({d.parts.filter((p) => p.sensitivity === 'secret').map((p) => p.label.toLowerCase()).join(', ')})</span>
                            <Toggle on={!!dg[d.id]?.includeSecret} label={`Include secret details of ${d.label}`} onChange={() => setLevel(d, lvl, !dg[d.id]?.includeSecret)} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

/**
 * What a category would send, before you choose: each entry as the person will see it, built by the same code as the
 * real share, so secret details appear only once you include them. Entries the chosen level leaves out are faded;
 * long categories show the first few and say how many more.
 */
function WhatGoes({ d, partyId, level, secret, first }: { d: Domain; partyId: string; level: Level; secret: boolean; first: string }) {
  const { data } = useAsync(() => get<{ records: SharedRecord[] }>(`/api/parties/${partyId}/preview/${d.id}${secret ? '?secret=1' : ''}`), [d.id, secret]);
  if (!data) return <div className="text-muted" style={{ fontSize: 12, margin: '8px 0 0 40px' }}>Loading…</div>;
  const goes = (r: SharedRecord) => level === 'all' || (level === 'current' && r.current);
  // What would be sent first, then the rest.
  const recs = level === 'off' ? data.records : [...data.records.filter(goes), ...data.records.filter((r) => !goes(r))];
  const hint = level === 'off' ? (d.dated ? 'Current sends the current ones; All sends past ones too.' : 'Shared sends all of these.')
    : level === 'current' ? `${first} sees the current ones. Past ones stay with you.` : `${first} sees all of these.`;
  return (
    <div style={{ margin: '10px 0 0 40px', display: 'grid', gap: 8 }}>
      <div className="text-muted" style={{ fontSize: 12 }}>{hint}</div>
      {recs.slice(0, PEEK).map((r) => (
        <div key={r.id} style={{ opacity: level === 'off' || goes(r) ? 1 : 0.45 }}>
          <EntryCard theirs title={r.title} range={[fmtRange(r.validFrom, r.validTo), d.dated ? (r.current ? 'Current' : 'Past') : ''].filter(Boolean).join(' · ') || undefined}
            fields={r.fields.map((f): CardField => ({ key: f.key, label: f.label, text: f.value, type: f.type, rows: f.rows, links: f.links }))} />
        </div>
      ))}
      {recs.length > PEEK && <div className="text-muted" style={{ fontSize: 12 }}>and {recs.length - PEEK} more</div>}
    </div>
  );
}
const PEEK = 4;

/** Entries shared one by one (just this residence, just this job), with a picker to add one. */
function SingleEntries({ c, catalog, first, send, ask }: { c: ContactDetail; catalog: Domain[]; first: string; send: (body: object, msg?: string) => Promise<unknown>; ask: (cfg: ConfirmCfg | null) => void }) {
  const [domain, setDomain] = useState('');
  const [recs, setRecs] = useState<Rec[]>([]);
  const pick = async (d: string) => { setDomain(d); setRecs(d ? (await get<{ items: Rec[] }>(`/api/data/${d}`)).items : []); };
  const shared = c.share.entries;
  // IDs, health, money and secret entries ask first, like whole categories do.
  const share = async (id: string) => {
    const d = catalog.find((x) => x.id === domain);
    const title = recs.find((r) => r.id === id)?.title ?? 'this entry';
    const secret = recs.find((r) => r.id === id)?.sensitivity === 'secret';
    if (d?.confirmShare || secret) {
      return ask({
        title: `Share ${title} with ${first}?`, body: `${first} will see it until you stop sharing it. Each read is logged in your activity.`, cta: 'Share it',
        onConfirm: async () => { await send({ entries: { [id]: true }, confirm: true }, `Shared with ${first}`); ask(null); pick(''); },
      });
    }
    await send({ entries: { [id]: true } }, `Shared with ${first}`);
    pick('');
  };
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {shared.map((e) => (
        <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--color-divider)' }}>
          <span style={{ flex: 1, fontSize: 14 }}>{e.title ?? 'An entry'} <span className="text-muted" style={{ fontSize: 12 }}>· {e.domainLabel}</span></span>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => send({ entries: { [e.id]: false } }, `No longer shared with ${first}`)}>Stop sharing</button>
        </div>
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <Select value={domain} onChange={pick} placeholder="Share one entry from…" options={catalog.filter((d) => d.count > 0).map((d) => [d.id, d.label])} />
        {domain && <Select value="" onChange={(id) => id && share(id)} placeholder="Choose the entry"
          options={recs.filter((r) => !shared.some((e) => e.id === r.id)).map((r) => [r.id, r.title])} />}
      </div>
    </div>
  );
}

const SubHead = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--color-neutral-600)', marginTop: 4 }}>{children}</div>
);
