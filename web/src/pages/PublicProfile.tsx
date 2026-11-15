import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { addr, BIG_DIPPER, copy, get } from '../api';
import { Circle, Dialog, ErrorNote, Loading, useAsync, useToast } from '../ui';
import { ProfileView, type ProfileViewData } from '../profile';

type Profile = ProfileViewData & { connectButton: boolean; madeWith?: boolean; address: string; ownerFirstName: string };

export default function PublicProfile() {
  const toast = useToast();
  const { data: p, error } = useAsync(() => get<Profile>('/public/profile'), []);
  const [isOwner, setIsOwner] = useState(false);
  const [connect, setConnect] = useState(false);

  useEffect(() => {
    get('/api/owner').then(() => setIsOwner(true)).catch(() => {});
  }, []);
  useEffect(() => {
    if (p) document.title = p.displayName;
  }, [p]);

  if (error) return <div style={{ padding: 48 }}><ErrorNote error={error} /></div>;
  if (!p) return <div style={{ padding: 48 }}><Loading /></div>;
  const a = addr(p.address);

  return (
    <div data-screen-label="Public profile" style={{ minHeight: '100%', position: 'relative', overflow: 'hidden' }}>
      {isOwner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px clamp(20px,7vw,96px)', background: 'var(--color-accent-2-100)', color: 'var(--color-accent-2-800)', fontSize: 13, flexWrap: 'wrap' }}>
          <span>Visitor view. Nothing here requires a login.</span>
          <Link className="btn btn-ghost" to="/admin/public" style={{ color: 'var(--color-accent-2-800)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>Back to visibility editor</Link>
        </div>
      )}
      <Circle style={{ right: -160, top: 40, width: 560, height: 560, background: 'var(--color-accent-200)', opacity: 0.55 }} />
      <div style={{ position: 'relative', padding: '36px clamp(20px,7vw,96px) 80px', maxWidth: 820 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 36, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--color-accent)' }} /><span className="mono" style={{ fontSize: 13 }}>{a}</span></div>
          <button className="btn btn-secondary" onClick={() => toast('API documentation is coming soon')}>API docs</button>
        </div>
        <ProfileView p={p} actions={p.connectButton && <button className="btn btn-primary" onClick={() => setConnect(true)}>Connect with me</button>} />
        {/* One quiet line: the Little Dipper credit (if the owner keeps it) and the owner's way in. */}
        <p className="text-muted" style={{ fontSize: 12, marginTop: 56 }}>
          {p.madeWith !== false && <MadeWithText />}
          {p.madeWith !== false && !isOwner && ' · '}
          {!isOwner && <Link to="/login" style={{ color: 'inherit' }}>Owner sign in</Link>}
        </p>
      </div>

      {connect && (
        <Dialog title={`Connect with ${p.displayName}`} onClose={() => setConnect(false)} actions={<>
          <button className="btn btn-secondary" onClick={() => setConnect(false)}>Close</button>
          <button className="btn btn-primary" onClick={async () => { await copy(a); setConnect(false); toast('Address copied'); }}>Copy address</button>
        </>}>
          <div className="dialog-body">Open your own Little Dipper, go to Relationships → Add someone → On Little Dipper, and enter this address. {p.ownerFirstName} will see your request and choose what to share.</div>
          <div className="mono" style={{ fontSize: 15, background: 'var(--color-neutral-100)', borderRadius: 999, padding: '10px 18px', overflowWrap: 'anywhere' }}>{a}</div>
          <div className="text-muted" style={{ fontSize: 13 }}>Don't have Little Dipper yet? It's free and open source.</div>
        </Dialog>
      )}
    </div>
  );
}

/** The quiet line at the foot of a public page (on unless the owner turns it off). A plain link: no referral code, nothing that ties a visitor to this page. */
const MadeWithText = () => <>Made with Little Dipper · <a href={`${BIG_DIPPER}/`} rel="noopener" style={{ color: 'inherit' }}>Make your own</a></>;
export function MadeWith({ size = 12 }: { size?: number }) {
  return <p className="text-muted" style={{ fontSize: size, marginTop: 6 }}><MadeWithText /></p>;
}
