/**
 * "Needs you": everything waiting for the owner to act, from wherever it comes. One list, shown on Home and in the
 * action bar, so dealing with something in one place clears it in both (they reload together through `version`).
 */
import { useNavigate } from 'react-router-dom';
import { get, initials, post, whenLabel, type AuditEvent } from './api';
import { useAction, useAsync } from './ui';
import { fetchCatalog, fmtDate } from './life';
import { useAdmin } from './pages/admin/Layout';
import { useDeviceBackup } from './deviceBackup';
import { sayWhen } from './quickAdd';

export type Action = { label: string; go: () => void; quiet?: boolean };
export type NeedsYouItem = { key: string; initials: string; title: string; sub: string; actions: Action[] };

type TaskAsk = { messageId: string; party: { id: string; name: string }; title: string; due: string | null; at: string };
type Attention = { domain: string; id: string; title: string; part: string; kind?: 'expiry' | 'deadline'; date: string; expired: boolean };

export function useNeedsYou(): { items: NeedsYouItem[] | null } {
  const { node, refresh, version } = useAdmin();
  const nav = useNavigate();
  const { run } = useAction();
  const device = useDeviceBackup(refresh);
  const { data } = useAsync(() => Promise.all([
    get<{ items: { _id: string; contactId: string; fromNode: string; peerName: string; quiet: boolean }[] }>('/api/federation/requests?status=pending&direction=in'),
    get<{ items: TaskAsk[] }>('/api/tasks/requests'),
    get<{ items: { id: string; by: string; keyId: string }[] }>('/api/reviews'),
    get<{ items: Attention[] }>('/api/attention?days=90'),
    fetchCatalog(),
  ]), [version]);
  if (!data) return { items: null };
  const [reqs, asks, reviews, attention, catalog] = data;
  const answer = (a: TaskAsk, ans: 'accepted' | 'not_now') => run(() => post(`/api/tasks/requests/${a.messageId}`, { answer: ans }), ans === 'accepted' ? 'Added to your tasks' : `${a.party.name.split(' ')[0]} will see you can’t take this one`).then(refresh);

  const items: NeedsYouItem[] = [
    ...reqs.items.filter((r) => !r.quiet).map((r) => ({
      key: r._id, initials: initials(r.peerName), title: `${r.peerName} wants to connect`, sub: r.fromNode, actions: [{ label: 'Review', go: () => nav(`/admin/relationships/${r.contactId}`) }],
    })),
    // Someone asked you to do something: answer here; it shows in your conversation with them either way.
    ...asks.items.map((a) => ({
      key: `ask-${a.messageId}`, initials: initials(a.party.name), title: `${a.party.name.split(' ')[0]} asked you to: ${a.title}`, sub: a.due ? sayWhen(a.due, null) : `Asked ${whenLabel(a.at)}`,
      actions: [{ label: 'Accept', go: () => answer(a, 'accepted') }, { label: 'Not now', quiet: true, go: () => answer(a, 'not_now') }],
    })),
    // Changes an assistant proposed, waiting for your approval: one line per assistant.
    ...[...new Map(reviews.items.map((r) => [r.keyId, r])).values()].map((r) => {
      const n = reviews.items.filter((x) => x.keyId === r.keyId).length;
      return { key: `review-${r.keyId}`, initials: initials(r.by), title: `${r.by} suggested ${n === 1 ? 'a change' : `${n} changes`}`, sub: 'Nothing is saved until you approve it', actions: [{ label: 'Review', go: () => nav('/admin/review') }] };
    }),
    ...attention.items.slice(0, 3).map((a) => ({
      key: a.id + a.part, initials: initials(catalog.find((d) => d.id === a.domain)?.label.replace('&', '') || a.domain),
      title: a.kind === 'deadline' ? `${a.part}: ${a.title}` : `${a.title} ${a.expired ? 'has expired' : 'expires soon'}`,
      sub: a.kind === 'deadline' && a.expired ? `Passed ${fmtDate(a.date)}` : `${a.part} ${fmtDate(a.date)}`, actions: [{ label: 'Open', go: () => nav(`/admin/life/${a.domain}`) }],
    })),
    // The recovery kit first: without it, no backup can be restored anywhere else.
    ...(node.recoveryKit.due ? [{ key: 'recovery-kit', initials: 'K', title: 'Save your recovery kit', sub: node.recoveryKit.reason === 'key-changed' ? 'Your key changed since you saved one' : 'Without it, no backup can be restored', actions: [{ label: 'Save', go: () => nav('/admin/settings/address?kit=1') }] }] : []),
    // A backup on this device: asked for weekly, or when the browser paused saving to the chosen folder.
    ...(device.needsPermission ? [{ key: 'device-allow', initials: '⤓', title: `Allow saving backups to ${device.folderName}`, sub: 'Your browser paused it after a restart', actions: [{ label: 'Allow', go: () => run(device.allow, 'Saving backups again') }] }]
      : node.deviceBackup.due ? [{ key: 'device-backup', initials: '⤓', title: node.deviceBackup.lastAt ? 'Save a fresh backup to this device' : 'Keep a backup on this device', sub: node.deviceBackup.lastAt ? `Last saved here ${whenLabel(node.deviceBackup.lastAt)}` : 'So far your backups are only on your Little Dipper', actions: [{ label: 'Save', go: () => run(device.download, 'Backup saved to this device') }] }] : []),
    ...(node.update.available ? [{ key: 'update', initials: '↑', title: `Update ${node.update.latest} is ready`, sub: 'Release notes in Settings', actions: [{ label: 'View', go: () => nav('/admin/settings/hosting') }] }] : []),
  ];
  return { items };
}

/** One thing waiting: who or what, a line of context, and its action(s). `compact` (action bar) puts actions underneath. */
export function NeedsYouRow({ item, compact = false }: { item: NeedsYouItem; compact?: boolean }) {
  const size = compact ? 32 : 38;
  const actions = (
    <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
      {item.actions.map((a) => (
        <button key={a.label} className={`btn ${a.quiet ? 'btn-ghost' : 'btn-primary'}`} onClick={a.go} style={{ fontSize: compact ? 12 : 13, padding: compact ? '5px 12px' : undefined }}>{a.label}</button>
      ))}
    </div>
  );
  return (
    <div style={{ display: 'flex', gap: compact ? 10 : 12, alignItems: compact ? 'flex-start' : 'center' }}>
      <span style={{ width: size, height: size, borderRadius: '50%', background: 'var(--color-accent-300)', display: 'grid', placeItems: 'center', fontSize: compact ? 12 : 13, flex: 'none' }}>{item.initials}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: compact ? 6 : 0 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: compact ? 13.5 : 14 }}>{item.title}</div>
          <div className="text-muted" style={{ fontSize: 12 }}>{item.sub}</div>
        </div>
        {compact && actions}
      </div>
      {!compact && actions}
    </div>
  );
}

export type Update = { id: string; at: string; text: string; tone: AuditEvent['tone']; href?: string; notice?: boolean };

/**
 * "Updates": what happened without you, newest first. Notices (an assistant's month, an ended connection) and what
 * people and assistants did. Your own actions aren't here; they're in the activity log. Shown on Home and in the bar.
 */
export function useUpdates(limit = 6): Update[] | null {
  const { version, notices } = useAdmin();
  const { data } = useAsync(() => get<{ items: AuditEvent[] }>('/api/audit?limit=60'), [version]);
  if (!data) return null;
  return [
    ...notices.map((n) => ({ id: n.id, at: n.at, text: n.title, tone: 'system' as const, href: n.href, notice: true })),
    ...data.items.filter((a) => a.actor?.type !== 'owner' && (a.tone === 'peer' || a.tone === 'request')).map((a) => ({ id: a._id, at: a.at, text: a.text, tone: a.tone })),
  ].sort((x, y) => y.at.localeCompare(x.at)).slice(0, limit);
}
