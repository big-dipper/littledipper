/**
 * An assistant's page, above "What it sees": what it can change, Everything, until when, its connection, what it
 * did, and ending its access. The same share as anyone you share with; only the controls for changing things and
 * the connection are its own.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ago, copy, del, get, post, put, type PartyDetail } from '../../api';
import { Confirm, Pills, Toggle, useAction, useAsync, useToast, type ConfirmCfg } from '../../ui';
import { AssistantActivity } from './Apps';

type Share = PartyDetail['share'];
type Write = 'none' | 'suggest' | 'make';
type KeyRow = { id: string; name: string; kind: string; contactId: string | null; lastUsedAt: string | null; createdAt: string; prefix: string };

const WRITES: [Write, string][] = [['none', 'Nothing'], ['suggest', 'Suggests changes'], ['make', 'Makes changes']];
const WRITE_TEXT: Record<Write, string> = {
  none: 'It answers questions from what it sees, and changes nothing.',
  suggest: 'Its changes wait for you to approve them. Documents it adds wait in your inbox.',
  make: 'Its changes are saved straight away, and you can see and undo them.',
};

export default function AssistantPanel({ c, onShare }: { c: PartyDetail; onShare: (s: Share) => void }) {
  const { run, busy } = useAction();
  const toast = useToast();
  const { data: keys, reload } = useAsync(() => get<{ items: KeyRow[] }>('/api/keys'), []);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const [activity, setActivity] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const key = keys?.items.find((k) => k.contactId === c.id && k.kind === 'app');
  const s = c.share;
  const write = s.write ?? 'none';

  const send = async (body: object, msg?: string) => {
    const g = await run(() => put<Share>(`/api/parties/${c.id}/share`, body), msg);
    if (g) onShare(g);
  };
  const everything = (on: boolean) => on
    ? setConfirm({ title: `Let ${c.name} see everything?`, body: 'Every category, your profile and every document, including anything you add later. Secret details stay out unless you add them.', cta: 'Let it see everything', onConfirm: async () => { await send({ everything: { includeSecret: false }, confirm: true }); setConfirm(null); } })
    : send({ everything: false });
  const end = () => key && setConfirm({
    title: `End ${c.name}'s access?`, cta: 'End access',
    body: 'It stops working straight away. Anything it suggested stays for you to decide on, and you can still undo what it changed. To use it again, connect it from the assistant.',
    onConfirm: async () => { if (await run(() => del(`/api/keys/${key.id}`), 'Access ended')) reload(); setConfirm(null); },
  });
  const makeKey = async () => {
    const r = await run(() => post<{ secret: string }>('/api/keys', { party: c.id }));
    if (r) { setSecret(r.secret); reload(); }
  };

  return (
    <section className="card" style={{ padding: '20px 22px', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{c.name} and your Little Dipper</h3>
        <span className="text-muted" style={{ fontSize: 13 }}>
          {key ? `Connected ${ago(key.createdAt)} · last used ${key.lastUsedAt ? ago(key.lastUsedAt) : 'never'}` : 'Not connected'}
        </span>
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>What it can change</div>
        <Pills value={write} onChange={(w) => send({ write: w }, 'Saved')} options={WRITES} />
        <div className="text-muted" style={{ fontSize: 13 }}>{WRITE_TEXT[write]} Changes to who you are and secret details always wait for you.</div>
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Toggle on={!!s.everything} onChange={() => everything(!s.everything)} label="Everything" />
          <span style={{ fontWeight: 600, fontSize: 14 }}>Everything</span>
          <span className="text-muted" style={{ fontSize: 13 }}>every category, your profile and every document</span>
        </div>
        {s.everything && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, paddingLeft: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={s.everything.includeSecret} disabled={busy}
              onChange={(e) => send({ everything: { includeSecret: e.target.checked }, confirm: true }, 'Saved')} />
            Include secret details too
          </label>
        )}
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Until</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Pills value={s.until ? 'date' : 'end'} onChange={(v) => send({ until: v === 'date' ? new Date(Date.now() + 30 * 86400_000).toISOString() : null }, 'Saved')} options={[['end', 'Until I end it'], ['date', 'Until a date']]} />
          {s.until && <input className="input" type="date" aria-label="Until" value={s.until.slice(0, 10)} min={new Date().toISOString().slice(0, 10)} style={{ maxWidth: 180 }}
            onChange={(e) => e.target.value && send({ until: new Date(`${e.target.value}T23:59:59`).toISOString() }, 'Saved')} />}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {key && <button className="btn btn-secondary" onClick={() => setActivity(true)}>What it did</button>}
        {key && <button className="btn btn-ghost" style={{ color: 'var(--color-accent-700)' }} onClick={end}>End access</button>}
        {!key && <Link className="btn btn-primary" to="/admin/assistants">How to connect it</Link>}
        {!key && <button className="btn btn-ghost" disabled={busy} onClick={makeKey}>It can’t connect itself? Make a key</button>}
      </div>
      {secret && (
        <div className="card" style={{ padding: '12px 14px', gap: 6, background: 'var(--color-neutral-100)' }}>
          <div style={{ fontSize: 13 }}>Copy this key now. It won’t be shown again. Enter it on the assistant’s own connection page, never in a chat.</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{secret}</span>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => { await copy(secret); toast('Key copied'); }}>Copy</button>
          </div>
        </div>
      )}
      {activity && key && <AssistantActivity k={key as never} onClose={() => setActivity(false)} />}
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </section>
  );
}
