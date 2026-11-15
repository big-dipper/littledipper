/**
 * Feedback, the first service Big Dipper offers. The button only exists once the owner has connected to Big Dipper
 * and turned Feedback on (GET /api/big-dipper says `feedback: true`), so nothing here runs otherwise.
 *
 * The owner says what's going on, can add a picture of the screen (blurred by default, see capture.ts) and mark it
 * up, sees exactly what will be sent, then sends. Their Little Dipper signs it and sends it to Big Dipper, which files
 * it and replies in Messages. Adapted from Smith's feedback widget.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { get, post } from '../api';
import { Toggle } from '../ui';
import { Icon } from '../icons';
import { useAdmin } from '../pages/admin/Layout';
import { THEMES } from '../appearance';
import { captureScreen, dataUrlBytes } from './capture';
import { AnnotateOverlay, labels, type Mark } from './Annotate';

type Kind = 'bug' | 'idea' | 'question' | 'other';
const KINDS: [Kind, string][] = [['bug', 'Something’s wrong'], ['idea', 'An idea'], ['question', 'A question'], ['other', 'Something else']];
const PROMPT: Record<Kind, string> = {
  bug: 'What happened, and what did you expect?',
  idea: 'What would make Little Dipper better for you?',
  question: 'What are you trying to work out?',
  other: 'Tell us anything.',
};
const MAX_SHOT = 4 * 1024 * 1024;

/** The rail button. Renders nothing unless Big Dipper's feedback service is on. */
export function FeedbackButton() {
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const { version } = useAdmin();
  useEffect(() => { get<{ feedback?: boolean }>('/api/big-dipper').then((b) => setReady(!!b.feedback)).catch(() => setReady(false)); }, [version]);
  if (!ready) return null;
  return (
    <>
      <button type="button" className="bare ab-rail-btn" data-on={open ? '1' : '0'} onClick={() => setOpen(!open)} title="Send feedback" aria-label="Send feedback" aria-expanded={open}>
        <Icon name="feedback" size={20} />
      </button>
      {open && <FeedbackPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function FeedbackPanel({ onClose }: { onClose: () => void }) {
  const loc = useLocation();
  const { appearance, refresh } = useAdmin();
  const [kind, setKind] = useState<Kind>('bug');
  const [comment, setComment] = useState('');
  const [blur, setBlur] = useState(true);
  const [shot, setShot] = useState<string | null>(null);       // as captured (blurred or not)
  const [marked, setMarked] = useState<string | null>(null);   // with the marks drawn in: what's sent
  const [marks, setMarks] = useState<Mark[]>([]);
  const [busy, setBusy] = useState<'' | 'capture' | 'send'>('');
  const [annotating, setAnnotating] = useState(false);
  const [step, setStep] = useState<'write' | 'check' | 'sent'>('write');
  const [error, setError] = useState('');
  const [reference, setReference] = useState<string | null>(null);
  const route = useRef(loc.pathname);

  const capture = async (b = blur) => {
    setBusy('capture'); setError('');
    try {
      let png = await captureScreen({ blur: b });
      if (dataUrlBytes(png) > MAX_SHOT) setError('That screen made a very large picture. Try a smaller window, or send without it.');
      else { setShot(png); setMarked(png); setMarks([]); }
    } catch {
      setError('Couldn’t take a picture of this screen. You can still send your words.');
    } finally { setBusy(''); }
  };
  const remove = () => { setShot(null); setMarked(null); setMarks([]); };

  const send = async () => {
    setBusy('send'); setError('');
    try {
      const theme = THEMES.find((t) => t.id === appearance.theme)?.label ?? appearance.theme;
      const r = await post<{ reference: string | null }>('/api/big-dipper/feedback', {
        type: kind, comment, screenshot: marked, marks,
        context: { route: route.current, viewport: { w: window.innerWidth, h: window.innerHeight }, blurred: blur, appearance: `${theme}, ${appearance.mode}, ${appearance.textSize} text, ${appearance.font}` },
      });
      setReference(r.reference); setStep('sent');
      setTimeout(refresh, 4000); // Big Dipper's reply lands in Messages shortly after
    } catch (e) {
      setError((e as Error).message || 'Couldn’t send it. Try again in a moment.');
    } finally { setBusy(''); }
  };

  const pinNotes = marks.map((m, i) => ({ m, tag: labels(marks)[i] })).filter(({ m }) => m.kind !== 'arrow');

  return (
    <div data-feedback-widget className="fb-layer">
      {annotating && shot && (
        <AnnotateOverlay screenshot={shot} initial={marks} onCancel={() => setAnnotating(false)}
          onDone={(png, ms) => { setMarked(png); setMarks(ms); setAnnotating(false); }} />
      )}
      <div className="fb-scrim" onClick={onClose} />
      <aside className="fb-panel" role="dialog" aria-label="Send feedback">
        <header className="fb-head">
          <div>
            <div className="kicker" style={{ marginBottom: 2 }}>To Big Dipper</div>
            <h2 style={{ margin: 0, fontSize: 22 }}>{step === 'sent' ? 'Thank you' : step === 'check' ? 'Check what’s sent' : 'Send feedback'}</h2>
          </div>
          <button type="button" className="bare fb-plain" onClick={onClose} aria-label="Close">Close</button>
        </header>

        {step === 'sent' && (
          <div className="fb-body">
            <p>It’s on its way{reference ? <>, filed as <strong>{reference}</strong></> : ''}. Big Dipper will reply in Messages, and write again if there’s news.</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button type="button" className="btn btn-secondary" onClick={() => { setStep('write'); setComment(''); remove(); setReference(null); }}>Send more</button>
              <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {step === 'write' && (
          <>
            <div className="fb-body">
              <div className="fb-label">What is it?</div>
              <div className="fb-kinds" role="radiogroup" aria-label="What is it?">
                {KINDS.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={kind === k} data-on={kind === k ? '1' : '0'} onClick={() => setKind(k)}>{l}</button>)}
              </div>

              <div className="fb-label">What’s going on?</div>
              <textarea className="input" rows={5} value={comment} onChange={(e) => setComment(e.target.value.slice(0, 5000))} placeholder={PROMPT[kind]} style={{ width: '100%', borderRadius: 16 }} />

              <div className="fb-label">A picture of this screen <span className="text-muted" style={{ fontWeight: 400 }}>(optional)</span></div>
              {!shot ? (
                <button type="button" className="fb-capture" onClick={() => capture()} disabled={busy === 'capture'}>
                  {busy === 'capture' ? 'Taking the picture…' : 'Take a picture of this screen'}
                </button>
              ) : (
                <div className="fb-shot">
                  <img src={marked ?? shot} alt="The picture that will be sent" />
                  <div className="fb-shot-actions">
                    <span className="text-muted" style={{ fontSize: 12.5 }}>{pinNotes.length ? `${pinNotes.length} note${pinNotes.length === 1 ? '' : 's'} on it` : 'Point at something with pins or boxes'}</span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button type="button" className="bare fb-plain" onClick={remove}>Remove</button>
                      <button type="button" className="btn btn-secondary" style={{ fontSize: 13 }} onClick={() => setAnnotating(true)}>Mark it up</button>
                    </span>
                  </div>
                </div>
              )}
              <div className="fb-blur">
                <Toggle on={blur} label="Blur what’s on the page" onChange={() => { const b = !blur; setBlur(b); if (shot) capture(b); }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Blur what’s on the page</div>
                  <div className="text-muted" style={{ fontSize: 12.5 }}>{blur ? 'Names, numbers and dates are blurred. Headings, buttons and labels stay clear.' : 'The picture shows everything on screen, exactly as you see it.'}</div>
                </div>
              </div>
              {error && <p className="fb-error">{error}</p>}
            </div>
            <footer className="fb-foot">
              <button type="button" className="btn btn-primary" disabled={!comment.trim() || !!busy} onClick={() => setStep('check')}>Next: check what’s sent</button>
            </footer>
          </>
        )}

        {step === 'check' && (
          <>
            <div className="fb-body">
              <p style={{ marginTop: 0 }}>Your Little Dipper sends this to Big Dipper, which files it in Linear, where the Little Dipper team tracks its work.</p>
              <ul className="fb-sent">
                <li><strong>What you wrote</strong>, as {KINDS.find(([k]) => k === kind)![1].toLowerCase()}</li>
                <li>{marked ? <><strong>The picture</strong>{blur ? ', with what’s on the page blurred' : <>, <strong>unblurred</strong></>}{pinNotes.length ? `, and your ${pinNotes.length} note${pinNotes.length === 1 ? '' : 's'}` : ''}</> : 'No picture'}</li>
                <li><strong>Where you were</strong>: this page ({route.current}), your screen size, browser and look</li>
                <li><strong>Your Little Dipper’s address and Node ID</strong>, so Big Dipper can reply in Messages</li>
              </ul>
              <p className="text-muted" style={{ fontSize: 13 }}>Not your name, and nothing else from your Little Dipper.</p>
              {marked && <img src={marked} alt="" className="fb-preview" />}
              {error && <p className="fb-error">{error}</p>}
            </div>
            <footer className="fb-foot">
              <button type="button" className="btn btn-secondary" onClick={() => setStep('write')} disabled={busy === 'send'}>Back</button>
              <button type="button" className="btn btn-primary" onClick={send} disabled={busy === 'send'}>{busy === 'send' ? 'Sending…' : 'Send'}</button>
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}
