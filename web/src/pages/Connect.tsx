import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { addr, BIG_DIPPER, get, longDate } from '../api';
import { Brand, Circle, Loading, useAsync } from '../ui';

/** Remembered in this browser, so the next invite opens in the same Little Dipper without asking again. */
const MINE = 'ld.myAddress';

/** "theo.example" → https://theo.example; local addresses stay on http. Null if it isn't an address. */
function originOf(input: string): string | null {
  const t = input.trim().replace(/\/+$/, '');
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `${/^(localhost|127\.0\.0\.1)(:|$)/.test(t) ? 'http' : 'https'}://${t}`);
    return u.hostname.includes('.') || u.hostname === 'localhost' ? u.origin : null;
  } catch { return null; }
}

/**
 * Where an invite link lands. Two ways on: get your own Little Dipper (Big Dipper sets it up and brings the invite
 * along), or open the one you have, with the invite ready to send.
 */
export default function Connect() {
  const [params] = useSearchParams();
  const token = params.get('invite') || '';
  const { data } = useAsync(() => get<{ valid: boolean; displayName: string | null; address: string; expiresAt: string | null }>(`/public/invites/${encodeURIComponent(token)}`), [token]);
  const [mine, setMine] = useState(() => localStorage.getItem(MINE) || '');
  const [bad, setBad] = useState(false);
  if (!data) return <div style={{ padding: 48 }}><Loading /></div>;
  const link = window.location.href;
  const name = data.displayName || 'Someone';
  const first = name.split(' ')[0];

  const openMine = () => {
    const origin = originOf(mine);
    if (!origin) return setBad(true);
    localStorage.setItem(MINE, mine.trim());
    window.location.href = `${origin}/admin/relationships?connect=${encodeURIComponent(link)}`;
  };

  return (
    <div style={{ minHeight: '100%', position: 'relative', overflow: 'hidden', padding: '48px clamp(20px,7vw,96px) 64px' }}>
      <Circle style={{ right: -160, top: -120, width: 480, height: 480, background: 'var(--color-accent-2-200)', opacity: 0.7 }} />
      <div style={{ position: 'relative', maxWidth: 600, margin: '0 auto' }}>
        <div style={{ marginBottom: 40 }}><Brand name={data.displayName || 'Little Dipper'} /></div>
        {data.valid ? (
          <>
            <span className="tag tag-accent-2">Invite</span>
            <h1 style={{ marginTop: 14, textWrap: 'pretty' }}>{name} invited you to connect.</h1>
            <p style={{ fontSize: 17, textWrap: 'pretty' }}>Little Dipper is a private place for your own information, and you decide what each person sees. Once you’re connected, you and {first} always have each other’s current details.</p>

            <div style={{ display: 'grid', gap: 14, margin: '28px 0 18px' }}>
              <div className="card" style={{ padding: '20px 24px', gap: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 16 }}>New to Little Dipper?</div>
                <div style={{ fontSize: 14 }}>Get your own. It takes about ten minutes, and this invite comes with you: when you’re set up, you can connect with {first} straight away.</div>
                <a className="btn btn-primary" style={{ alignSelf: 'flex-start' }} href={`${BIG_DIPPER}/get-started?invite=${encodeURIComponent(link)}`}>Get my Little Dipper</a>
              </div>
              <div className="card" style={{ padding: '20px 24px', gap: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 16 }}>Already have one?</div>
                <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); openMine(); }}>
                  <input className="input mono" aria-label="Your Little Dipper’s address" placeholder="your address, like sam.example" value={mine} onChange={(e) => { setMine(e.target.value); setBad(false); }} style={{ flex: 1, minWidth: 200 }} />
                  <button className="btn btn-secondary" type="submit">Open mine</button>
                </form>
                <div className="text-muted" style={{ fontSize: 13 }}>{bad ? 'That doesn’t look like an address. It’s the one you open your Little Dipper at.' : `Your Little Dipper opens with ${first}’s invite ready. You choose what to share, then send it.`}</div>
              </div>
            </div>
            <div className="text-muted" style={{ fontSize: 13 }}>This invite works once and expires {data.expiresAt ? longDate(data.expiresAt) : 'soon'}.</div>
          </>
        ) : (
          <>
            <span className="tag tag-accent">Invite link</span>
            <h1 style={{ marginTop: 14 }}>This invite has expired or was already used.</h1>
            <p style={{ fontSize: 17 }}>Ask {data.displayName || 'the owner'} for a new one, or visit <a href="/">{addr(data.address)}</a>.</p>
          </>
        )}
      </div>
    </div>
  );
}
