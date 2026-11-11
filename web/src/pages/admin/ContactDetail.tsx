import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ago, copy, del, displayMethod, firstName, get, initials, patch, post, shortDate, STATUS, type ContactMethod, type PartyDetail as CD, type ProfileLine as Field, type SharedDomain } from '../../api';
import { Confirm, Dialog, ErrorNote, Loading, useAction, useAsync, useToast, type ConfirmCfg } from '../../ui';
import { useAdmin } from './Layout';
import ContactAccess from './ContactAccess';
import { fetchCatalog, fmtRange, money, PartialDate, RecordEditor, Select, useContactsLite, type Rec } from '../../life';
import { CopyList, SendCopy } from './Copies';
import SharedWithYou from './SharedWithYou';
import { giveList, ShareChooser, toShare, useSharing, type Choice, type Relation, type SharingData } from '../../sharing';

export default function ContactDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { tech, refresh } = useAdmin();
  const { run, busy } = useAction();
  const { data: c, error, reload, setData } = useAsync(() => get<CD>(`/api/parties/${id}`), [id]);
  const { data: fieldsResp } = useAsync(() => get<{ items: Field[] }>('/api/profile'), []);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(0);
  const { data: catalog } = useAsync(fetchCatalog, []);
  const [edit, setEdit] = useState<Edit | null>(null);
  const sharing = useSharing();
  const [choice, setChoice] = useState<Choice>({ extras: [] });
  const [relation, setRelation] = useState<Relation | ''>('');
  const [preview, setPreview] = useState(false);

  if (error) return <div><Link className="btn btn-ghost" to="/admin/relationships">← Relationships</Link><ErrorNote error={error} /></div>;
  if (!c || !fieldsResp) return <Loading />;
  const fields = fieldsResp.items;
  const first = firstName(c.name);
  const isNode = !!c.node;
  const s = c.status;
  const sub = c.node ? c.node.url : c.type === 'organisation' ? 'Organisation' : '';

  const accept = async () => {
    if (!c.request) return;
    // What you chose on the connect card: your basic profile plus the extras you kept ticked.
    if (await run(() => post(`/api/federation/requests/${c.request!.id}/accept`, { share: toShare(choice) }), `Connected with ${first}`)) { reload(); refresh(); }
  };
  const decline = async () => {
    if (!c.request) return;
    if (await run(() => post(`/api/federation/requests/${c.request!.id}/decline`), 'Request declined')) { refresh(); nav('/admin/relationships'); }
  };
  const resend = () => c.request && run(() => post(`/api/federation/requests/${c.request!.id}/resend`), 'Request re-sent');
  const rotate = async () => {
    if (await run(() => post(`/api/federation/links/${c.node!.linkId}/rotate`), 'Keys rotated. Their Little Dipper was notified.')) reload();
  };
  const disconnect = () => setConfirm({
    title: `Disconnect ${c.name}?`, body: 'They will no longer see anything you shared. They stay in your relationships.', cta: 'Disconnect',
    onConfirm: async () => {
      const r = await run(() => del<{ peerNotified: boolean }>(`/api/federation/links/${c.node!.linkId}`), (r) => (r.peerNotified ? 'Disconnected' : "Disconnected. Their Little Dipper couldn't be reached; it'll find out next time it asks."));
      setConfirm(null);
      if (r) reload();
    },
  });
  const remove = () => setConfirm({
    title: `Delete ${c.name}?`,
    body: [isNode ? 'This disconnects you and removes them from your relationships.' : 'This removes them and everything you noted about them.',
      c.usedBy.length ? ` ${c.usedBy.length === 1 ? 'One entry points' : `${c.usedBy.length} entries point`} to them (${c.usedBy.map((u) => `${u.title} in ${u.domainLabel}`).join('; ')}); ${c.usedBy.length === 1 ? 'it' : 'they'} will no longer name them.` : ''].join(''),
    cta: 'Delete',
    onConfirm: async () => { if (await run(() => del(`/api/parties/${c.id}${c.usedBy.length ? '?confirm=true' : ''}`), `${c.name} deleted`)) nav('/admin/relationships'); setConfirm(null); },
  });
  const invite = async () => {
    const r = await run(() => post<{ url: string; to: string; subject: string; body: string }>(`/api/parties/${c.id}/invite`));
    if (!r) return;
    await copy(`${r.body}`);
    toast(r.to ? `Invite message copied. Paste it into an email to ${r.to}.` : 'Invite message copied with your invite link');
  };

  return (
    <div data-screen-label="Contact detail" style={{ maxWidth: 760 }}>
      <Link className="btn btn-ghost" to="/admin/relationships" style={{ marginBottom: 14 }}>← Relationships</Link>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ width: 72, height: 72, borderRadius: '50%', background: isNode ? 'var(--color-accent-2-200)' : 'var(--color-accent-200)', display: 'grid', placeItems: 'center', fontSize: 22, fontFamily: 'var(--font-heading)', flex: 'none' }}>{initials(c.name)}</span>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ margin: 0 }}>{c.name}</h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <span className={`tag ${isNode ? 'tag-accent-2' : 'tag-neutral'}`}>{isNode ? 'On Little Dipper' : 'Person'}</span>
            <span className={`tag ${STATUS[s][1]}`}>{STATUS[s][0]}</span>
            <span className="text-muted" style={{ fontFamily: isNode ? 'var(--mono)' : 'inherit', fontSize: 12 }}>{sub}</span>
            {c.node?.nodeId && (
              <span className="text-muted" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                <button type="button" title={`${c.node.nodeId} · click to copy`} onClick={async () => toast((await copy(c.node!.nodeId)) ? 'Their ID copied' : c.node!.nodeId)}
                  style={{ all: 'unset', cursor: 'pointer', opacity: 0.75 }}>· {c.node.nodeId.slice(0, 8)}…{c.node.nodeId.slice(-4)}</button>
              </span>
            )}
          </div>
        </div>
        {!isNode && <button className="btn btn-secondary" onClick={invite}>Invite to Little Dipper</button>}
        {isNode && s === 'active' && <Link className="btn btn-primary" to={`/admin/messages/${c.id}`}>Message</Link>}
      </div>

      {s === 'pending_in' ? (
        sharing ? <ConnectCard c={c} first={first} sub={sub} sharing={sharing} choice={choice} setChoice={setChoice} relation={relation} setRelation={setRelation} busy={busy} onConnect={accept} onDecline={decline} /> : <Loading />
      ) : (
        <>
          {s === 'pending_out' && (
            <div style={{ marginTop: 22, borderRadius: 32, background: 'var(--color-neutral-100)', padding: '18px 22px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-accent)', animation: 'ldpulse 1.6s infinite', flex: 'none' }} />
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ fontWeight: 600 }}>Waiting for {first} to approve</div>
                <div className="text-muted" style={{ fontSize: 13 }}>Request delivered to {sub}.{c.request ? ` Expires in ${Math.max(0, Math.ceil((new Date(c.request.expiresAt).getTime() - Date.now()) / 86400_000))} days.` : ''}</div>
              </div>
              <button className="btn btn-secondary" disabled={busy} onClick={resend}>Resend</button>
            </div>
          )}

          {/* What they see: first, under their name, at any width. One editor; every change a specific one. */}
          {isNode && s === 'active' && <ContactAccess c={c} fields={fields} first={first} onGrants={(g) => setData({ ...c, share: g })} onPreview={() => setPreview(true)} />}
          {preview && catalog && <AsTheySee partyId={c.id} first={first} catalog={catalog} onClose={() => setPreview(false)} />}

          {/* One column, top to bottom, like Home: what they see, how you know them, their details, what they share, then the rest. */}
          <div style={{ display: 'grid', gap: 22, marginTop: 22 }}>
            <div style={{ display: 'grid', gap: 22 }}>
              {catalog && <BetweenYou c={c} />}
              {catalog && <HowYouKnow partyId={c.id} first={first} catalog={catalog} notes={isNode ? { text: c.notes, save: (notes) => run(() => patch(`/api/parties/${c.id}`, { notes }), 'Saved').then(reload) } : undefined} />}
              {/* One contact card: what they share (kept up to date by them), plus anything you added yourself. */}
              <div className="card" style={{ padding: '20px 24px', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div className="card-kicker">Contact info</div>
                  {/* A connected person's card is what they share. Details you added before connecting stay editable. */}
                  {(!isNode || c.methods.length > 0) && <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setEdit({ name: c.name, type: c.type, birthDate: c.birthDate ?? '', notes: c.notes, methods: c.methods.length ? c.methods : [{ kind: 'email', value: '' }] })}>Edit</button>}
                </div>
                {isNode && c.sharedIn.map((m) => (
                  <Row key={m.key} label={m.label} value={m.key === 'little_dipper' ? m.value.split(' · ')[0] : m.value} />
                ))}
                {c.methods.map((m, i) => <Row key={i} label={`${m.label || KIND_LABEL[m.kind]}${m.primary ? ' · main' : ''}`} value={displayMethod(m)} note={isNode ? 'added by you' : undefined} />)}
                {!c.sharedIn.length && !c.methods.length && <div className="text-muted" style={{ fontSize: 13, padding: '6px 0' }}>{isNode ? (s === 'active' ? `${first} isn’t sharing contact details yet.` : 'Details arrive once you’re connected.') : 'No details yet.'}</div>}
                {isNode && c.sharedIn.length > 0 && (
                  <div className="card-meta" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                    {s === 'active'
                      ? (c.syncError ? `Couldn’t reach ${first}’s Little Dipper just now · last fetched ${ago(c.sharedInFetchedAt)}` : `Kept up to date by ${first} · fetched ${ago(c.sharedInFetchedAt)}`)
                      : `Last known · ${first} no longer shares this`}
                    {s === 'active' && <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 6px' }} disabled={busy} onClick={() => run(() => get<CD>(`/api/parties/${c.id}?sync=1`)).then((x) => x && setData(x))}>Refresh</button>}
                  </div>
                )}
                {!isNode && c.notes && <p className="text-muted" style={{ fontSize: 13, margin: '12px 0 0', whiteSpace: 'pre-wrap' }}>{c.notes}</p>}
              </div>

              {isNode && catalog && <SharedWithYou domains={c.sharedDomains || []} catalog={catalog} first={first} />}
            </div>

            <div style={{ display: 'grid', gap: 22 }}>
              <div className="card" style={{ padding: '20px 24px', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div className="card-kicker">Copies you’ve sent</div>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={!catalog} onClick={() => setSending(true)}>Send a copy</button>
                </div>
                <CopyList query={`contactId=${c.id}`} showContact={false} version={sent} />
                <div className="text-muted" style={{ fontSize: 12 }}>{isNode ? `A one-time snapshot as a link or a file, separate from what ${first} sees above.` : `Send ${first} a snapshot of entries from My data as a link, a file or an email.`}</div>
              </div>

              {s === 'active' && c.keys && (
                <div className="card" style={{ padding: '20px 24px', gap: 12 }}>
                  <div className="card-kicker">Secure connection</div>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {c.timeline.map((t, i) => (
                      <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent-2)', flex: 'none' }} /><span style={{ flex: 1 }}>{t.label}</span><span className="text-muted">{shortDate(t.at)}</span></div>
                    ))}
                    {c.keys.tokenIssued?.lastUsedAt && <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent-2)', flex: 'none' }} /><span style={{ flex: 1 }}>Last read of your data</span><span className="text-muted">{ago(c.keys.tokenIssued.lastUsedAt)}</span></div>}
                  </div>
                  {tech && [
                    ['Their signing key', `${c.keys.peerSigningKey}${c.keys.peerVersion ? ` · v${c.keys.peerVersion}` : ''}`],
                    ['Token you issued them', c.keys.tokenIssued ? `${c.keys.tokenIssued.prefix} · scope ${c.keys.tokenIssued.scopes.join(' ')}` : 'none'],
                    ['Token they issued you', c.keys.tokenFromPeer ? `stored encrypted · last used ${ago(c.keys.tokenFromPeer.lastUsedAt)}` : 'none'],
                    ['Their ID', c.node?.nodeId || ''],
                  ].map(([label, value]) => (
                    <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 16px', borderRadius: 18, background: 'var(--color-neutral-100)' }}>
                      <span className="text-muted" style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase' }}>{label}</span>
                      <span className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{value}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn btn-secondary" disabled={busy} onClick={rotate}>Refresh connection</button>
                    <button className="btn btn-ghost" onClick={disconnect} style={{ color: 'var(--color-accent-700)' }}>Disconnect</button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={remove} style={{ marginTop: 18, fontSize: 13, color: 'var(--color-accent-700)' }}>Remove {first}</button>
        </>
      )}

      {edit && (
        <Dialog title={`Edit ${c.name}`} onClose={() => setEdit(null)} width={520} actions={<>
          <button className="btn btn-secondary" onClick={() => setEdit(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run(() => saveContact(c.id, edit), 'Saved'); if (r) { setEdit(null); reload(); } }}>Save</button>
        </>}>
          <div className="field"><label htmlFor="pname">Name</label><input id="pname" className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
          <div className="field"><label>Type</label><Select value={edit.type} onChange={(v) => setEdit({ ...edit, type: (v || 'person') as Edit['type'] })} options={[['person', 'Person'], ['organisation', 'Organisation']]} /></div>
          {edit.type === 'person' && <div className="field"><label htmlFor="pbd">Date of birth</label><PartialDate id="pbd" value={edit.birthDate} onChange={(v) => setEdit({ ...edit, birthDate: v })} /><div className="text-muted" style={{ fontSize: 12 }}>With the full date, their birthday shows on your calendar.</div></div>}
          {edit.methods.map((m, i) => (typeof m.value === 'object' ? (
            <div key={i} className="text-muted" style={{ fontSize: 13 }}>{m.label || 'Postal address'}: {displayMethod(m)}</div>
          ) : (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: 8 }}>
              <Select value={m.kind} onChange={(v) => setEdit({ ...edit, methods: edit.methods.map((x, j) => (j === i ? { ...x, kind: (v || 'email') as ContactMethod['kind'] } : x)) })} options={STRING_KINDS.map((k) => [k, KIND_LABEL[k]])} />
              <input className="input" aria-label={KIND_LABEL[m.kind]} value={m.value} placeholder={m.kind === 'social' || m.kind === 'messaging' ? '@handle' : ''} onChange={(e) => setEdit({ ...edit, methods: edit.methods.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
              {(m.kind === 'social' || m.kind === 'messaging') && <input className="input" style={{ gridColumn: 2 }} aria-label="Service" placeholder="Service, e.g. Signal" value={m.service ?? ''} onChange={(e) => setEdit({ ...edit, methods: edit.methods.map((x, j) => (j === i ? { ...x, service: e.target.value } : x)) })} />}
            </div>
          )))}
          <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 13 }} onClick={() => setEdit({ ...edit, methods: [...edit.methods, { kind: 'phone', value: '' }] })}>Add a detail</button>
          <div className="field"><label htmlFor="notes">Notes</label><textarea id="notes" className="input" value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} style={{ borderRadius: 20 }} /></div>
        </Dialog>
      )}
      {sending && catalog && <SendCopy catalog={catalog} contact={c} onClose={() => setSending(false)} onSent={() => setSent((n) => n + 1)} />}
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

type Edit = { name: string; type: 'person' | 'organisation'; birthDate: string; notes: string; methods: ContactMethod[] };
const KIND_LABEL: Record<ContactMethod['kind'], string> = { email: 'Email', phone: 'Phone', postal: 'Postal address', website: 'Website', social: 'Social', messaging: 'Messaging' };
const STRING_KINDS: ContactMethod['kind'][] = ['email', 'phone', 'website', 'social', 'messaging'];
function saveContact(id: string, e: Edit) {
  const methods = e.methods.filter((m) => typeof m.value === 'object' || m.value.trim());
  return patch(`/api/parties/${id}`, { name: e.name, type: e.type, notes: e.notes, methods, ...(e.type === 'person' ? { birthDate: e.birthDate || null } : {}) });
}

/** Their side of the exchange, in words: "Where they live", not "Their lives in". */
const THEIRS: Record<string, string> = { 'Little Dipper': 'Their Little Dipper address', 'Preferred name': 'Their name', 'Lives in': 'Where they live', 'Home address': 'Their home address', Email: 'Their email', Phone: 'Their phone', Born: 'Their birthday', 'Legal name': 'Their legal name', 'Mailing address': 'Their mailing address' };
const theirs = (label: string) => THEIRS[label] ?? `Their ${label.charAt(0).toLowerCase()}${label.slice(1)}`;

/** One detail in the connect card. A Little Dipper line shows its address with the Node ID beneath, to compare. */
const Given = ({ label, value }: { label: string; value: string }) => {
  if (label !== 'Little Dipper') return <div style={{ fontSize: 14 }}>{value}</div>;
  const [addr, id] = value.split(' · ');
  return <div style={{ fontSize: 14 }}>{addr}{id && <div className="mono text-muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{id}</div>}</div>;
};

/**
 * "See it as Theo does": exactly what Theo's Little Dipper receives from you, from the same code it calls, in the
 * same cards Theo sees. Secret details appear only if you shared them on purpose.
 */
function AsTheySee({ partyId, first, catalog, onClose }: { partyId: string; first: string; catalog: Awaited<ReturnType<typeof fetchCatalog>>; onClose: () => void }) {
  const { data } = useAsync(() => get<{ lines: Field[]; domains: SharedDomain[] }>(`/api/parties/${partyId}/preview`), [partyId]);
  return (
    <Dialog title={`What ${first} sees`} onClose={onClose} width={720} actions={<button className="btn btn-secondary" onClick={onClose}>Done</button>}>
      {!data ? <Loading /> : (
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="card" style={{ padding: '16px 22px', gap: 0 }}>
            <div className="card-kicker">Contact info</div>
            {data.lines.map((l) => <Row key={l.key} label={l.label} value={l.key === 'little_dipper' ? l.value.split(' · ')[0] : l.value} />)}
          </div>
          <SharedWithYou domains={data.domains} catalog={catalog} first={first} heading="Also shared" note={`${first} can read these, not change them. They stay up to date as you change them.`} />
        </div>
      )}
    </Dialog>
  );
}

/**
 * "How you know Theo": your relationships with this person (spouse, reference, landlord…). They're entries in the
 * Relationships category, dated and sensitive like any other, shown here on the person rather than in My data.
 */
function HowYouKnow({ partyId, first, catalog, notes }: { partyId: string; first: string; catalog: Awaited<ReturnType<typeof fetchCatalog>>; notes?: { text: string; save: (t: string) => Promise<unknown> } }) {
  const d = catalog.find((x) => x.id === 'relationships');
  const { data, reload } = useAsync(() => get<{ items: Rec[] }>('/api/data/relationships'), []);
  const contacts = useContactsLite();
  const [editing, setEditing] = useState<{ rec: Rec | null } | null>(null);
  if (!d) return null;
  const mine = (data?.items ?? []).filter((r) => r.data.party === partyId);
  const relation = d.parts.find((p) => p.key === 'relation');
  const label = (r: Rec) => relation?.options?.find(([k]) => k === r.data.relation)?.[1] ?? String(r.data.relation ?? '');
  return (
    <div className="card" style={{ padding: '20px 24px', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="card-kicker">How you know {first}</div>
        <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setEditing({ rec: null })}>Add</button>
      </div>
      {mine.map((r) => (
        <button key={r.id} className="bare" onClick={() => setEditing({ rec: r })} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderBottom: '1px solid var(--color-divider)', textAlign: 'left', cursor: 'pointer', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14 }}>{label(r)}{r.data.emergencyContact === true && <span className="tag tag-accent" style={{ marginLeft: 8 }}>Emergency contact</span>}</span>
          <span className="text-muted" style={{ fontSize: 13 }}>{fmtRange(r.validFrom, r.validTo)}</span>
        </button>
      ))}
      {data && !mine.length && <div className="text-muted" style={{ fontSize: 13, padding: '6px 0' }}>Spouse, family, a reference, a mentor… Add how you know {first} if it helps.</div>}
      {notes && <YourNotes first={first} {...notes} />}
      {editing && <RecordEditor d={d} rec={editing.rec} contacts={contacts} defaults={{ party: partyId }} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

type Money = { amount: number; currency: string };
/** The money part each money category is about, and how to say it: payments received, receipts spent. */
const MONEY: Record<string, { part: string; verb: string }> = { income: { part: 'amount', verb: 'received' }, receipts: { part: 'total', verb: 'spent' } };

/**
 * Everything between you and them, from your own entries: money first (payments received, what you spent), then
 * accounts, jobs, policies and anything else that names them. Each line opens that category, searched for them.
 */
function BetweenYou({ c }: { c: CD }) {
  const refs = c.usedBy.filter((u) => u.domain !== 'relationships');
  const ids = new Set(refs.map((u) => u.recordId));
  const moneyDomains = [...new Set(refs.map((u) => u.domain))].filter((d) => MONEY[d]);
  const { data: recs } = useAsync(async () => Object.fromEntries(await Promise.all(moneyDomains.map(async (d) => [d, (await get<{ items: Rec[] }>(`/api/data/${d}`)).items.filter((r) => ids.has(r.id))] as const))), [c.id, refs.length]);
  if (!refs.length) return null;
  const byDomain = [...refs.reduce((m, u) => m.set(u.domain, [...(m.get(u.domain) ?? []), u]), new Map<string, typeof refs>())]
    .sort(([a], [b]) => Number(!!MONEY[b]) - Number(!!MONEY[a]));
  const total = (d: string) => {
    const by = new Map<string, number>();
    for (const r of recs?.[d] ?? []) { const m = r.data[MONEY[d].part] as Money | undefined; if (m?.currency) by.set(m.currency, (by.get(m.currency) ?? 0) + m.amount); }
    return [...by].map(([currency, amount]) => money({ currency, amount: Math.round(amount * 100) / 100 })).join(' + ');
  };
  return (
    <div className="card" style={{ padding: '20px 24px', gap: 4 }}>
      <div className="card-kicker">Between you</div>
      {byDomain.map(([d, list]) => {
        const unique = [...new Map(list.map((u) => [u.recordId, u])).values()];
        const sum = MONEY[d] ? total(d) : '';
        return (
          <Link key={d} to={`/admin/life/${d}?q=${encodeURIComponent(c.name)}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderBottom: '1px solid var(--color-divider)', textDecoration: 'none', color: 'inherit', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14 }}>{list[0].domainLabel} <span className="text-muted">· {unique.length}</span></span>
            <span className="text-muted" style={{ fontSize: 13, textAlign: 'right' }}>{sum ? `${sum} ${MONEY[d].verb}` : unique.slice(0, 2).map((u) => u.title).join(' · ') + (unique.length > 2 ? ' …' : '')}</span>
          </Link>
        );
      })}
    </div>
  );
}

/** What you remember about someone, in your words. Only you see it; it's never shared. */
function YourNotes({ first, text, save }: { first: string; text: string; save: (t: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) return (
    <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      <textarea className="input" autoFocus aria-label={`Your notes about ${first}`} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Where you met, birthdays, what ${first} likes…`} style={{ borderRadius: 20, minHeight: 90 }} />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setDraft(null)}>Cancel</button>
        <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => save(draft.trim()).then(() => setDraft(null))}>Save</button>
      </div>
    </div>
  );
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span className="text-muted" style={{ fontSize: 12 }}>Your notes · only you see these</span>
        <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setDraft(text)}>{text ? 'Edit' : 'Add a note'}</button>
      </div>
      {text && <p style={{ fontSize: 14, margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{text}</p>}
    </div>
  );
}

const Row = ({ label, value, note }: { label: string; value: string; note?: string }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderBottom: '1px solid var(--color-divider)', flexWrap: 'wrap' }}>
    <span className="text-muted" style={{ fontSize: 13 }}>{label}{note && <span style={{ fontSize: 11 }}> · {note}</span>}</span>
    <span style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{value}</span>
  </div>
);

/**
 * Someone asks to connect: the whole page is this card, in three zones. Who and why (their note in its own box);
 * the exchange side by side (their side as labels, since their details only travel once you both agree; yours as
 * values); your choice (who they are, suggestions, their requests) and Connect / Decline.
 */
function ConnectCard({ c, first, sub, sharing, choice, setChoice, relation, setRelation, busy, onConnect, onDecline }: {
  c: CD; first: string; sub: string; sharing: SharingData; choice: Choice; setChoice: (x: Choice) => void;
  relation: Relation | ''; setRelation: (r: Relation | '') => void; busy: boolean; onConnect: () => void; onDecline: () => void;
}) {
  const give = giveList(sharing, choice);
  // The two sides of the exchange are white cards that stand off the blue; the note is a blue speech bubble, so neither blends.
  const panel = { padding: '14px 18px', borderRadius: 20, background: '#fff', border: '1px solid var(--color-accent-200)', display: 'grid', gap: 6, alignContent: 'start' } as const;
  return (
    <div className="card" style={{ marginTop: 22, padding: '26px 28px', gap: 26, background: 'var(--color-accent-100)', maxWidth: 720 }}>
      <div style={{ display: 'grid', gap: 10 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 24 }}>{c.name} wants to connect</div>
          <div style={{ fontSize: 13, color: 'var(--color-accent-800)' }}><span className="mono">{sub}</span> · Little Dipper ✓ (it’s really them)</div>
        </div>
        {c.request?.note && <div style={{ padding: '12px 18px', borderRadius: '20px 20px 20px 6px', background: 'var(--color-accent-200)', color: 'var(--color-accent-900)', fontSize: 15, justifySelf: 'start', maxWidth: '100%' }}>{c.request.note}</div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,240px),1fr))', gap: 12 }}>
        <div style={panel}>
          <div className="card-kicker">{first} gives you</div>
          {c.request?.offeredDetails.length
            ? c.request.offeredDetails.map((d) => <Given key={d.label} label={d.label} value={d.value} />)
            : (c.request?.offeredLabels ?? []).map((l) => <div key={l} style={{ fontSize: 14 }}>{theirs(l)}</div>)}
        </div>
        <div style={panel}>
          <div className="card-kicker">You give {first}</div>
          {give.map((g) => <Given key={g.key} label={g.label} value={g.value || g.label} />)}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 14 }}>
        <ShareChooser data={sharing} first={first} choice={choice} onChange={setChoice} requested={c.request?.requestedFields ?? []} relation={relation} onRelation={setRelation} showBasic={false} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" disabled={busy} onClick={onConnect}>Connect</button>
          <button className="btn btn-ghost" disabled={busy} onClick={onDecline}>Decline</button>
        </div>
      </div>
    </div>
  );
}
