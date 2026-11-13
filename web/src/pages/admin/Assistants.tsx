/**
 * Why connect an AI assistant, and how: the page Home's banner opens. It tells the story first (what it does for you,
 * the boundaries, how much it does, the honest risks), then how to connect. The technical key dialog stays in Settings.
 */
import { Link } from 'react-router-dom';
import { ConnectAssistant } from './Apps';

const FOR_YOU = [
  'Fills in your Little Dipper from things you already have. Hand it a lease, a pay stub or an insurance card and it files the details in the right places.',
  'Brings over what lives elsewhere, like a list of accounts or past addresses, in one go instead of typing each one.',
  'Keeps things current. Tell it you moved or changed jobs and it updates what that touches.',
  'Answers questions about your own life: when does my passport expire, what’s my car insurance deductible, where did I live in 2019?',
];

const BOUNDARIES = [
  { title: 'It asks here first', text: 'Connecting opens your Little Dipper, and you choose what it may see and do. Nothing is shared until you approve.' },
  { title: 'Only what you pick', text: 'It sees the categories you choose. Secret details, like account numbers, stay hidden unless you allow each one.' },
  { title: 'Who you are waits for you', text: 'Changes to your name, IDs, current address, email and phone always wait for your approval, whatever you let it do.' },
  { title: 'Watch it, undo it', text: 'Everything it changes is in your activity log and can be undone. Disconnect it any time.' },
];

const MODES = [
  { title: 'Answer questions', text: 'It reads what you allow and changes nothing.' },
  { title: 'Suggest changes', text: 'Its changes wait for you to approve them. A good place to start.' },
  { title: 'Make changes', text: 'Its changes are saved straight away, and you can see and undo them.' },
];

const THINGS_TO_KNOW = [
  'What it reads goes to the assistant’s company (Anthropic for Claude, OpenAI for ChatGPT) so it can answer you, under their privacy terms. Your Little Dipper can’t control what happens after that, so start with a few categories.',
  'Assistants make mistakes. With Suggest changes you check each one before it’s saved.',
  'Claude and ChatGPT reach your Little Dipper over the internet, so it has to be online at its own address (a Little Dipper on Railway is).',
  'This is new. Each assistant follows the standard, but not every step has been tried with every one yet. Tell us how it goes.',
];

const Tick = () => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: 2, color: 'var(--color-accent-2-600)' }}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
);

export default function Assistants() {
  return (
    <div data-screen-label="AI assistants" style={{ maxWidth: 880, display: 'grid', gap: 28, paddingBottom: 8 }}>
      <section className="card" style={{ padding: 'clamp(24px, 4vw, 36px)', gap: 14, background: 'var(--color-neutral-900)', color: 'var(--color-neutral-100)', position: 'relative', overflow: 'hidden' }}>
        <div aria-hidden style={{ position: 'absolute', right: -90, bottom: -150, width: 340, height: 340, borderRadius: '50%', background: 'var(--color-accent-800)', opacity: 0.6 }} />
        <div aria-hidden style={{ position: 'absolute', right: 230, bottom: -70, width: 130, height: 130, borderRadius: '50%', background: 'var(--color-accent-2-800)', opacity: 0.5 }} />
        <span className="card-kicker" style={{ position: 'relative', color: 'var(--color-accent-300)' }}>AI assistants · optional</span>
        <h2 style={{ position: 'relative', margin: 0, fontSize: 'clamp(30px, 4vw, 40px)', lineHeight: 1.05, maxWidth: 560 }}>A helper that knows your life, because you let it.</h2>
        <p style={{ position: 'relative', margin: 0, fontSize: 15, color: 'var(--color-neutral-400)', maxWidth: 580, lineHeight: 1.55, textWrap: 'pretty' }}>
          Connect Claude, ChatGPT or another assistant you already use. It does the tedious part of filling in and looking after your Little Dipper, and you decide exactly what it sees.
        </p>
      </section>

      <section aria-labelledby="ai-you">
        <h3 id="ai-you" style={{ margin: '0 0 12px' }}>What it can do for you</h3>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 10 }}>
          {FOR_YOU.map((x) => <li key={x} style={{ display: 'flex', gap: 10, fontSize: 15, lineHeight: 1.5 }}><Tick /><span>{x}</span></li>)}
        </ul>
      </section>

      <section aria-labelledby="ai-bounds">
        <h3 id="ai-bounds" style={{ margin: '0 0 12px' }}>The boundaries</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: 12 }}>
          {BOUNDARIES.map((b) => (
            <div key={b.title} className="card" style={{ padding: '18px 18px 16px', gap: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{b.title}</div>
              <div className="text-muted" style={{ fontSize: 13, lineHeight: 1.5 }}>{b.text}</div>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="ai-modes">
        <h3 id="ai-modes" style={{ margin: 0 }}>You choose how much it does</h3>
        <p className="text-muted" style={{ margin: '4px 0 12px', fontSize: 14 }}>You pick when you connect it, and you can change your mind later.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
          {MODES.map((m) => (
            <div key={m.title} style={{ padding: '14px 16px', borderRadius: 16, border: '1.5px solid var(--color-divider)', display: 'grid', gap: 4 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{m.title}</div>
              <div className="text-muted" style={{ fontSize: 13, lineHeight: 1.5 }}>{m.text}</div>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="ai-know" style={{ borderRadius: 20, background: 'var(--color-neutral-100)', border: '1px solid var(--color-divider)', padding: '18px 22px', display: 'grid', gap: 8 }}>
        <h3 id="ai-know" style={{ margin: 0, fontSize: 18 }}>Things to know</h3>
        {THINGS_TO_KNOW.map((t) => <div key={t} style={{ fontSize: 14, lineHeight: 1.55 }}>{t}</div>)}
      </section>

      <section aria-labelledby="ai-how" style={{ display: 'grid', gap: 4 }}>
        <h3 id="ai-how" style={{ margin: 0 }}>Connect one</h3>
        <p className="text-muted" style={{ margin: 0, fontSize: 14 }}>Pick your assistant for the steps. When it opens your Little Dipper, you’ll choose what it may see and do.</p>
        <ConnectAssistant bare />
        <div className="text-muted" style={{ fontSize: 13, marginTop: 10 }}>
          Connected assistants, their activity and keys for other apps are in <Link to="/admin/settings/apps">Settings › Apps and access</Link>.
        </div>
      </section>
    </div>
  );
}
