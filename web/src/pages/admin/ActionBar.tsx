/**
 * The action bar: the right-hand side is for doing, as the left is for going. Two views, one at a time:
 *  + Add: an event, a task or a note, typed as you'd say it, with your tasks underneath (requests waiting on top).
 *  🔔 Notifications: only that.
 * "Needs you" stays on Home; all tasks have their own page. Closed, it's a quiet rail; on a phone, a sheet.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ago, get, post, type Party } from '../../api';
import { Pills, useAction, useAsync, useToast } from '../../ui';
import { Select } from '../../life';
import { Icon } from '../../icons';
import { readWhen, sayWhen } from '../../quickAdd';
import { useUpdates } from '../../needsYou';
import { useAdmin } from './Layout';
import { AppearanceButton } from './Appearance';

export type Notice = { id: string; kind: string; title: string; text: string; href: string; at: string };
export type Ask = { messageId: string; party: { id: string; name: string }; title: string; due: string | null; at: string };
export type Task = {
  id: string; title: string; due: string | null; done: boolean; doneAt: string | null;
  who: { id: string; name: string } | null; from: { id: string; name: string } | null; answer: 'asked' | 'accepted' | 'not_now' | null;
};

type View = 'add' | 'notices';
const VIEW_KEY = 'ld.actions.view';
const readView = (): View | null => { try { const v = localStorage.getItem(VIEW_KEY); return v === 'add' || v === 'notices' ? v : null; } catch { return null; } };
const first = (name: string) => name.split(' ')[0];
const today = () => new Date().toISOString().slice(0, 10);
/** How many open tasks the bar shows before "See all tasks". */
const BAR_TASKS = 6;

/** Your tasks and what people have asked of you, reloading with everything else. */
export function useTasks() {
  const { version } = useAdmin();
  const { data: tasks } = useAsync(() => get<{ open: Task[]; done: Task[] }>('/api/tasks'), [version]);
  const { data: asks } = useAsync(() => get<{ items: Ask[] }>('/api/tasks/requests'), [version]);
  return { tasks: tasks ?? null, asks: asks?.items ?? [] };
}

export default function ActionBar({ notices, onDismiss, onGo }: { notices: Notice[]; onDismiss: (id: string) => void; onGo: (href: string) => void }) {
  const [view, setViewState] = useState<View | null>(readView);
  const { tasks, asks } = useTasks();
  const addRef = useRef<HTMLTextAreaElement>(null);
  const setView = (v: View | null) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v ?? ''); } catch { /* just not remembered */ } };
  const show = (v: View) => { setView(v); if (v === 'add') setTimeout(() => addRef.current?.focus(), 60); };
  useEffect(() => {
    if (!view) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && window.matchMedia('(max-width: 760px)').matches && setView(null);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [view]);

  const waiting = asks.length;
  const unseen = notices.length;
  // The two doors: + for adding (and your tasks), the bell for notifications. Shown on the rail and atop the panel.
  const doors = (
    <>
      <button type="button" className="bare ab-rail-btn ab-main" data-on={view === 'add' ? '1' : '0'} onClick={() => (view === 'add' ? setView(null) : show('add'))}
        title="Add an event, task or note" aria-label={`Add an event, task or note${waiting ? ` (${waiting} waiting for your answer)` : ''}`} aria-pressed={view === 'add'}>
        <Icon name="plus" size={22} />
        {waiting > 0 && <span className="nav-badge ab-count">{waiting}</span>}
      </button>
      <button type="button" className="bare ab-rail-btn" data-on={view === 'notices' ? '1' : '0'} onClick={() => (view === 'notices' ? setView(null) : show('notices'))}
        title="Notifications" aria-label={`Notifications${unseen ? ` (${unseen})` : ''}`} aria-pressed={view === 'notices'}>
        <Icon name="bell" size={20} />
        {unseen > 0 && <span className="nav-badge ab-count ab-count-soft">{unseen}</span>}
      </button>
    </>
  );

  if (!view) return <aside className="actionbar" data-open="0" aria-label="Actions">{doors}<AppearanceButton /></aside>;

  return (
    <>
      <div className="ab-scrim" onClick={() => setView(null)} aria-hidden />
      <aside className="actionbar" data-open="1" aria-label={view === 'add' ? 'Add' : 'Notifications'}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {doors}
          <button type="button" className="bare side-toggle" onClick={() => setView(null)} aria-label="Close" title="Close" style={{ transform: 'scaleX(-1)', marginLeft: 'auto' }}>
            <Icon name="collapse" size={18} />
          </button>
        </div>

        {view === 'add' ? (
          <>
            <QuickAdd inputRef={addRef} />
            <Tasks tasks={tasks} asks={asks} limit={BAR_TASKS} />
          </>
        ) : (
          <Notifications notices={notices} onDismiss={onDismiss} onGo={onGo} />
        )}
      </aside>
    </>
  );
}

/** What happened without you, and nothing else. */
function Notifications({ notices, onDismiss, onGo }: { notices: Notice[]; onDismiss: (id: string) => void; onGo: (href: string) => void }) {
  const updates = useUpdates(20);
  return (
    <section className="ab-section">
      <div className="card-kicker">Notifications</div>
      {updates && !updates.length && <div className="text-muted" style={{ fontSize: 13 }}>Nothing new from anyone.</div>}
      {updates?.map((u) => {
        const n = u.notice ? notices.find((x) => x.id === u.id) : null;
        return (
          <div key={u.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <button type="button" className="bare" onClick={u.href ? () => onGo(u.href!) : undefined} style={{ all: 'unset', cursor: u.href ? 'pointer' : 'default', flex: 1, display: 'grid', gap: 2 }}>
              <span style={{ fontSize: 13.5 }}>{u.text}</span>
              <span className="text-muted" style={{ fontSize: 11.5 }}>{n ? `${n.text} · ` : ''}{ago(u.at)}</span>
            </button>
            {n && <button type="button" className="btn btn-ghost" onClick={() => onDismiss(n.id)} aria-label="Mark as seen" title="Mark as seen" style={{ fontSize: 14, padding: '0 8px' }}>×</button>}
          </div>
        );
      })}
      <Link to="/admin/activity" className="text-muted" style={{ fontSize: 12 }}>Activity log</Link>
    </section>
  );
}

type Kind = 'event' | 'task' | 'note';
const PLACEHOLDER: Record<Kind, string> = { event: 'Pick up kids at 3 on Saturday', task: 'Test software on Saturday', note: 'Anything you want to remember' };

/**
 * Add, the way you'd say it: "Pick up kids at 3 on Saturday". For events and tasks, what it understood shows
 * underneath, ready to fix; a note is kept just as written. Nothing is saved until you press Add.
 * (A message will be the fourth kind.)
 */
export function QuickAdd({ inputRef, only }: { inputRef?: React.RefObject<HTMLTextAreaElement | null>; only?: Kind }) {
  const { refresh } = useAdmin();
  const toast = useToast();
  const { run, busy } = useAction();
  const [kind, setKind] = useState<Kind>(only ?? 'event');
  const [text, setText] = useState('');
  const [fix, setFix] = useState<{ date?: string | null; time?: string | null }>({});
  const [who, setWho] = useState('');
  const { data: people } = useAsync(() => get<{ items: Party[] }>('/api/parties'), []);
  const read = useMemo(() => readWhen(text), [text]);
  const date = fix.date !== undefined ? fix.date : read.date;
  const time = kind !== 'event' ? null : fix.time !== undefined ? fix.time : read.time;
  const person = people?.items.find((p) => p.id === who);
  const asks = !!person?.node && person.status === 'active';
  const ready = kind === 'note' ? !!text.trim() : !!read.title && (kind === 'task' || !!date);

  const reset = () => { setText(''); setFix({}); setWho(''); };
  const add = async () => {
    if (!ready || busy) return;
    if (kind === 'event') {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const end = time && read.endTime && fix.time === undefined ? { at: `${date}T${read.endTime}`, tz } : undefined;
      const ok = await run(() => post('/api/data/events', { data: { title: read.title, start: { at: `${date}T${time ?? '00:00'}`, tz }, ...(end ? { end } : {}), allDay: !time } }));
      if (ok) { toast(`${read.title} · ${sayWhen(date, time)}`); reset(); refresh(); }
    } else if (kind === 'note') {
      if (await run(() => post('/api/data/notes', { data: { text: text.trim() } }))) { toast('Note saved in My data'); reset(); refresh(); }
    } else {
      const r = await run(() => post<{ asked: boolean }>('/api/tasks', { title: read.title, due: date, who: who || null }));
      if (r) { toast(r.asked ? `Asked ${first(person!.name)}. Their answer shows here and in your messages.` : 'Added to your tasks'); reset(); refresh(); }
    }
  };

  return (
    <section className="ab-section">
      {!only && <Pills value={kind} size={13} options={[['event', 'Event'], ['task', 'Task'], ['note', 'Note']]} onChange={(v) => { setKind(v); setFix({}); }} />}
      <textarea ref={inputRef} className="input ab-input" value={text} rows={kind === 'note' ? 5 : 2} onChange={(e) => { setText(e.target.value); setFix({}); }}
        // Enter adds an event or task; in a note it starts a new line (⌘/Ctrl+Enter saves).
        onKeyDown={(e) => { if (e.key === 'Enter' && (kind !== 'note' ? !e.shiftKey : e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } }}
        placeholder={PLACEHOLDER[kind]} aria-label={`New ${kind}`} />
      {kind === 'note' && text.trim() && <button className="btn btn-primary" disabled={busy} onClick={add} style={{ justifySelf: 'start', fontSize: 13 }}>Save note</button>}
      {kind !== 'note' && text.trim() && (
        <div className="ab-preview">
          <div style={{ fontWeight: 600, fontSize: 14 }}>{read.title || '…'}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="date" className="input ab-mini" value={date ?? ''} onChange={(e) => setFix({ ...fix, date: e.target.value || null })} aria-label={kind === 'event' ? 'Day' : 'When (optional)'} />
            {kind === 'event' && <input type="time" className="input ab-mini" value={time ?? ''} onChange={(e) => setFix({ ...fix, time: e.target.value || null })} aria-label="Time (empty for all day)" />}
            <span className="text-muted" style={{ fontSize: 12 }}>{kind === 'event' ? (date ? (time ? (read.endTime && fix.time === undefined ? `until ${sayWhen(date, read.endTime).split(' · ')[1]}` : '') : 'All day') : 'Which day?') : (date ? '' : 'No date')}</span>
          </div>
          {kind === 'task' && people && people.items.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              <Select value={who} onChange={setWho} options={[['', 'Just me'], ...people.items.filter((p) => p.type === 'person').sort((a, b) => Number(!!b.node && b.status === 'active') - Number(!!a.node && a.status === 'active') || a.name.localeCompare(b.name)).map((p) => [p.id, p.node && p.status === 'active' ? `${p.name} · on Little Dipper` : p.name] as [string, string])]} />
              {person && <div className="text-muted" style={{ fontSize: 12 }}>{asks ? `${first(person.name)} is asked, and can accept or say not now. It shows in your messages with them.` : `A note for you: ${first(person.name)} isn’t on Little Dipper, so they aren’t asked.`}</div>}
            </div>
          )}
          <button className="btn btn-primary" disabled={!ready || busy} onClick={add} style={{ justifySelf: 'start', fontSize: 13 }}>{kind === 'task' && asks ? `Ask ${first(person!.name)}` : 'Add'}</button>
        </div>
      )}
    </section>
  );
}

const ANSWER: Record<NonNullable<Task['answer']>, string> = { asked: 'asked', accepted: 'taking care of it', not_now: 'can’t take this one' };

/** Your tasks: tick to finish. Ones you asked of someone show their answer; ones asked of you say by whom. */
export function Tasks({ tasks, asks, limit }: { tasks: { open: Task[]; done: Task[] } | null; asks: Ask[]; limit?: number }) {
  const { refresh } = useAdmin();
  const { run, busy } = useAction();
  const [showDone, setShowDone] = useState(false);
  if (!tasks) return null;
  const answer = (a: Ask, ans: 'accepted' | 'not_now') => run(() => post(`/api/tasks/requests/${a.messageId}`, { answer: ans }), ans === 'accepted' ? 'Added to your tasks' : `${first(a.party.name)} will see you can’t take this one`).then(refresh);
  const toggle = (t: Task) => run(() => post(`/api/tasks/${t.id}/done`, { done: !t.done }), t.done ? undefined : t.from ? `Done. ${first(t.from.name)} will see it.` : 'Done').then(refresh);
  const row = (t: Task) => {
    const late = !t.done && t.due && t.due < today();
    // Someone else's to do: only they tick it off, and you see it when they do.
    const theirs = !!t.who && t.answer !== null;
    const meta = [
      t.due ? `${late ? 'Was due ' : ''}${sayWhen(t.due, null)}` : null,
      t.who ? `${t.who.name.split(' ')[0]}${t.answer ? ` · ${t.done ? 'done' : ANSWER[t.answer]}` : ''}` : null,
      t.from ? `from ${first(t.from.name)}` : null,
    ].filter(Boolean).join(' · ');
    return (
      <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', opacity: t.done ? 0.6 : 1 }}>
        <button type="button" className="ab-check" data-on={t.done ? '1' : '0'} disabled={theirs} onClick={() => toggle(t)}
          aria-label={theirs ? `${t.title}: ${t.who!.name.split(' ')[0]} ticks this off` : t.done ? `Mark ${t.title} not done` : `Mark ${t.title} done`}
          title={theirs ? `${first(t.who!.name)} ticks this off` : undefined}>{t.done ? '✓' : ''}</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, textDecoration: t.done ? 'line-through' : 'none' }}>{t.title}</div>
          {meta && <div className="text-muted" style={{ fontSize: 12, color: late ? 'var(--color-accent-700)' : undefined }}>{meta}</div>}
        </div>
      </div>
    );
  };
  return (
    <section className="ab-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="card-kicker">Your tasks</div>
        {limit !== undefined && <Link to="/admin/tasks" style={{ fontSize: 12 }}>See all tasks</Link>}
      </div>
      {/* Asked of you and not answered yet: on top, answered right here (or in your conversation). */}
      {asks.map((a) => (
        <div key={a.messageId} className="ab-ask">
          <div style={{ fontSize: 12 }} className="text-muted">{first(a.party.name)} asked you</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{a.title}</div>
          {a.due && <div className="text-muted" style={{ fontSize: 12 }}>{sayWhen(a.due, null)}</div>}
          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
            <button className="btn btn-primary" disabled={busy} onClick={() => answer(a, 'accepted')} style={{ fontSize: 12, padding: '5px 12px' }}>Accept</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => answer(a, 'not_now')} style={{ fontSize: 12 }}>Not now</button>
          </div>
        </div>
      ))}
      {tasks.open.length ? tasks.open.slice(0, limit).map(row) : !asks.length && <div className="text-muted" style={{ fontSize: 13 }}>Nothing to do. Add one above.</div>}
      {limit !== undefined && tasks.open.length > limit && <Link to="/admin/tasks" className="text-muted" style={{ fontSize: 12 }}>{tasks.open.length - limit} more</Link>}
      {/* Done ones live on the Tasks page; the bar stays about what's next. */}
      {limit === undefined && tasks.done.length > 0 && (
        <>
          <button type="button" className="btn btn-ghost" onClick={() => setShowDone(!showDone)} style={{ fontSize: 12, justifySelf: 'start', padding: '2px 0' }}>{showDone ? 'Hide done' : `Done this week (${tasks.done.length})`}</button>
          {showDone && tasks.done.map(row)}
        </>
      )}
    </section>
  );
}
