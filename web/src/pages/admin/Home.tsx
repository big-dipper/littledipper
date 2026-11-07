import { Link, useNavigate } from 'react-router-dom';
import { addr, ago, firstName, get, initials, whenLabel, type AuditEvent } from '../../api';
import { useAction, useAsync } from '../../ui';
import { fetchCatalog, fmtDate } from '../../life';
import { useAdmin } from './Layout';
import { useDeviceBackup } from '../../deviceBackup';
import { addDays, daysOf, lookOf, timeOf, ymd, type CalItem } from './Calendar';

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};
const TONE = { peer: 'var(--color-accent-2)', request: 'var(--color-accent)', owner: 'var(--color-neutral-500)', system: 'var(--color-neutral-500)' };

export default function Home() {
  const { owner, node, refresh } = useAdmin();
  const nav = useNavigate();
  const { run } = useAction();
  const device = useDeviceBackup(refresh);
  const { data: reqs } = useAsync(() => get('/api/federation/requests?status=pending&direction=in'), []);
  const { data: audit } = useAsync(() => get<{ items: AuditEvent[] }>('/api/audit?limit=6'), []);
  const { data: catalog } = useAsync(fetchCatalog, []);
  const { data: attention } = useAsync(() => get<{ items: { domain: string; id: string; title: string; part: string; kind?: 'expiry' | 'deadline'; date: string; expired: boolean }[] }>('/api/attention?days=90'), []);

  const inbox = [
    ...(reqs?.items || []).filter((r: { quiet: boolean }) => !r.quiet).map((r: { _id: string; contactId: string; fromNode: string; peerName: string }) => ({
      key: r._id, initials: initials(r.peerName), title: `${r.peerName} wants to connect`, sub: r.fromNode, cta: 'Review', go: () => nav(`/admin/contacts/${r.contactId}`),
    })),
    ...(attention?.items || []).slice(0, 3).map((a) => ({
      key: a.id + a.part, initials: initials(catalog?.find((d) => d.id === a.domain)?.label.replace('&', '') || a.domain), title: a.kind === 'deadline' ? `${a.part}: ${a.title}` : `${a.title} ${a.expired ? 'has expired' : 'expires soon'}`, sub: a.kind === 'deadline' && a.expired ? `Passed ${fmtDate(a.date)}` : `${a.part} ${fmtDate(a.date)}`, cta: 'Open', go: () => nav(`/admin/life/${a.domain}`),
    })),
    // The recovery kit first: without it, no backup can be restored anywhere else.
    ...(node.recoveryKit.due ? [{ key: 'recovery-kit', initials: 'K', title: 'Save your recovery kit', sub: node.recoveryKit.reason === 'key-changed' ? 'Your key changed since you saved one' : 'Without it, no backup can be restored', cta: 'Save', go: () => nav('/admin/settings/address?kit=1') }] : []),
    // A backup on this device: asked for weekly, or when the browser paused saving to the chosen folder.
    ...(device.needsPermission ? [{ key: 'device-allow', initials: '⤓', title: `Allow saving backups to ${device.folderName}`, sub: 'Your browser paused it after a restart', cta: 'Allow', go: () => run(device.allow, 'Saving backups again') }]
      : node.deviceBackup.due ? [{ key: 'device-backup', initials: '⤓', title: node.deviceBackup.lastAt ? 'Save a fresh backup to this device' : 'Keep a backup on this device', sub: node.deviceBackup.lastAt ? `Last saved here ${whenLabel(node.deviceBackup.lastAt)}` : 'So far your backups are only on your Little Dipper', cta: 'Save', go: () => run(device.download, 'Backup saved to this device') }] : []),
    ...(node.update.available ? [{ key: 'update', initials: '↑', title: `Update ${node.update.latest} is ready`, sub: 'Release notes in Settings', cta: 'View', go: () => nav('/admin/settings/hosting') }] : []),
  ];
  return (
    <div data-screen-label="Dashboard" style={{ maxWidth: 760, display: 'grid', gap: 18 }}>
      <div>
        <h1 style={{ marginBottom: 6 }}>{greeting()}, {firstName(owner.name)}.</h1>
        <div style={{ fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <a href={node.address} target="_blank" rel="noreferrer">{addr(node.address)}</a>
          <span className="mono text-muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{node.id}</span>
        </div>
      </div>

      <div className="card" style={{ padding: '22px 24px', gap: 12, background: 'var(--color-accent-100)' }}>
        <div className="card-kicker">Needs you</div>
        {inbox.map((ib) => <InboxRow key={ib.key} {...ib} />)}
        {reqs && inbox.length === 0 && <div className="text-muted" style={{ fontSize: 14 }}>Nothing waiting.</div>}
      </div>

      <ThisWeek />

      <div className="card" style={{ padding: '22px 26px', flexDirection: 'row', alignItems: 'center', gap: 22, flexWrap: 'wrap', background: 'var(--color-neutral-900)', color: 'var(--color-neutral-100)', position: 'relative', overflow: 'hidden' }}>
        <div aria-hidden style={{ position: 'absolute', right: -70, top: -90, width: 260, height: 260, borderRadius: '50%', background: 'var(--color-accent-700)', opacity: 0.5 }} />
        <div aria-hidden style={{ position: 'absolute', right: 150, bottom: -60, width: 120, height: 120, borderRadius: '50%', background: 'var(--color-accent-2-700)', opacity: 0.5 }} />
        <div style={{ flex: 1, minWidth: 260, position: 'relative' }}>
          <div className="card-kicker" style={{ color: 'var(--color-accent-300)' }}>AI assistants</div>
          <div className="card-title" style={{ fontSize: 22, marginTop: 4 }}>Give an assistant access to what you choose</div>
          <div style={{ fontSize: 13, color: 'var(--color-neutral-400)', marginTop: 4, maxWidth: 560 }}>It gets its own key. You pick which categories it can read, and you can revoke it at any time.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', position: 'relative' }}>
          <Link className="btn btn-primary" to="/admin/apps?preset=assistant" style={{ background: 'var(--color-accent-2-600)' }}>Connect an assistant</Link>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <h4>Recent activity</h4>
        {audit?.items.map((a) => (
          <div key={a._id} style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--color-divider)', alignItems: 'flex-start' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 7, flex: 'none', background: TONE[a.tone] }} />
            <div style={{ flex: 1, fontSize: 14 }}>{a.text}</div>
            <span className="text-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{ago(a.at)}</span>
          </div>
        ))}
        {node.publicViewsToday > 0 && (
          <div style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--color-divider)', alignItems: 'flex-start' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 7, flex: 'none', background: TONE.system }} />
            <div style={{ flex: 1, fontSize: 14 }}>Public profile viewed {node.publicViewsToday} time{node.publicViewsToday === 1 ? '' : 's'}</div>
            <span className="text-muted" style={{ fontSize: 12 }}>today</span>
          </div>
        )}
        {audit && audit.items.length === 0 && <p className="text-muted" style={{ fontSize: 14 }}>Nothing yet.</p>}
      </div>
    </div>
  );
}

/** The next seven days from the calendar, at a glance. */
function ThisWeek() {
  const today = ymd(new Date());
  const { data } = useAsync(() => get<{ items: CalItem[] }>(`/api/calendar?from=${today}&to=${addDays(today, 6)}`), [today]);
  const next = (data?.items ?? []).filter((i) => daysOf(i)[1] >= today).slice(0, 4);
  const dayLabel = (d: string) => (d <= today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : new Date(`${d}T12:00`).toLocaleDateString(undefined, { weekday: 'short' }));
  return (
    <div className="card" style={{ padding: '22px 24px', gap: 12 }}>
      <div className="card-kicker">This week</div>
      {next.map((i) => {
        const day = daysOf(i)[0];
        return (
          <div key={i.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ width: 46, flex: 'none', textAlign: 'center', padding: '4px 0', borderRadius: 14, background: lookOf(i).bg === 'transparent' ? 'var(--color-neutral-100)' : lookOf(i).bg, color: lookOf(i).ink, border: lookOf(i).border }}>
              <span style={{ display: 'block', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase' }}>{dayLabel(day)}</span>
              <span style={{ display: 'block', fontFamily: 'var(--font-heading)', fontSize: 18, lineHeight: 1.1 }}>{+day.slice(8)}</span>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</div>
              <div className="text-muted" style={{ fontSize: 12 }}>{!i.allDay && i.start ? timeOf(i.start.at) : 'All day'}{i.contact ? ` · ${i.contact.name}` : i.detail ? ` · ${i.detail}` : ''}</div>
            </div>
          </div>
        );
      })}
      {data && !next.length && <div className="text-muted" style={{ fontSize: 14 }}>A clear week.</div>}
      <Link className="btn btn-secondary" to="/admin/calendar" style={{ alignSelf: 'flex-start' }}>Open calendar</Link>
    </div>
  );
}

function InboxRow({ initials: ini, title, sub, cta, go }: { initials: string; title: string; sub: string; cta: string; go: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <span style={{ width: 38, height: 38, borderRadius: '50%', background: 'var(--color-accent-300)', display: 'grid', placeItems: 'center', fontSize: 13, flex: 'none' }}>{ini}</span>
      <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div><div className="text-muted" style={{ fontSize: 12 }}>{sub}</div></div>
      <button className="btn btn-primary" onClick={go} style={{ fontSize: 13 }}>{cta}</button>
    </div>
  );
}
