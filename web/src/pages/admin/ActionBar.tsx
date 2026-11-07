/**
 * The action bar: the right-hand side is for doing, as the left is for going. Closed, it's a quiet rail with counts;
 * open, it holds Add (an event or a task, typed as you'd say it), Needs you, your tasks and updates. On a phone
 * it's a button that opens a sheet from the bottom.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ago, get, post, type Party } from '../../api';
import { Pills, useAction, useAsync, useToast } from '../../ui';
import { Select } from '../../life';
import { Icon } from '../../icons';
import { readWhen, sayWhen } from '../../quickAdd';
import { NeedsYouRow, useNeedsYou, useUpdates } from '../../needsYou';
import { useAdmin } from './Layout';

export type Notice = { id: string; kind: string; title: string; text: string; href: string; at: string };
type Task = {
  id: string; title: string; due: string | null; done: boolean; doneAt: string | null;
  who: { id: string; name: string } | null; from: { id: string; name: string } | null; answer: 'asked' | 'accepted' | 'not_now' | null;
};

const OPEN_KEY = 'ld.actions.open';
const readOpen = () => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } };
const first = (name: string) => name.split(' ')[0];
const today = () => new Date().toISOString().slice(0, 10);

export default function ActionBar({ notices, onDismiss, onGo }: { notices: Notice[]; onDismiss: (id: string) => void; onGo: (href: string) => void }) {
  const { version } = useAdmin();
  const [open, setOpen] = useState(readOpen);
  const { items: needs } = useNeedsYou();
  const updates = useUpdates(8);
  const { data: tasks } = useAsync(() => get<{ open: Task[]; done: Task[] }>('/api/tasks'), [version]);
  const addRef = useRef<HTMLInputElement>(null);
  const set = (v: boolean) => { setOpen(v); try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* just not remembered */ } };
  const openTo = (focusAdd: boolean) => { set(true); if (focusAdd) setTimeout(() => addRef.current?.focus(), 60); };
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && window.matchMedia('(max-width: 760px)').matches && set(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);

  const waiting = needs?.length ?? 0;
  const openTasks = tasks?.open.length ?? 0;

  if (!open) {
    return (
      <aside className="actionbar" data-open="0" aria-label="Actions">
        <button type="button" className="bare ab-rail-btn ab-main" onClick={() => openTo(true)} title="Add an event or task" aria-label="Add an event or task">
          <Icon name="plus" size={22} />
          {waiting > 0 && <span className="nav-badge ab-count">{waiting}</span>}
        </button>
        <button type="button" className="bare ab-rail-btn" onClick={() => openTo(false)} title={`Needs you${waiting ? ` (${waiting})` : ''}`} aria-label={`Needs you${waiting ? ` (${waiting})` : ''}`}>
          <Icon name="bell" size={20} />
          {waiting > 0 && <span className="nav-badge ab-count">{waiting}</span>}
        </button>
        <button type="button" className="bare ab-rail-btn" onClick={() => openTo(false)} title={`Your tasks${openTasks ? ` (${openTasks})` : ''}`} aria-label={`Your tasks${openTasks ? ` (${openTasks})` : ''}`}>
          <Icon name="tasks" size={20} />
          {openTasks > 0 && <span className="nav-badge ab-count ab-count-soft">{openTasks}</span>}
        </button>
      </aside>
    );
  }

  return (
    <>
      <div className="ab-scrim" onClick={() => set(false)} aria-hidden />
      <aside className="actionbar" data-open="1" aria-label="Actions">
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="bare side-toggle" onClick={() => set(false)} aria-label="Close" title="Close" style={{ transform: 'scaleX(-1)' }}>
            <Icon name="collapse" size={18} />
          </button>
        </div>

        <QuickAdd inputRef={addRef} />

        {needs && needs.length > 0 && (
          <section className="ab-section">
            <div className="card-kicker">Needs you</div>
            {needs.map((it) => <NeedsYouRow key={it.key} item={it} compact />)}
          </section>
        )}

        <Tasks tasks={tasks ?? null} />

        <section className="ab-section">
          <div className="card-kicker">Updates</div>
          {updates && !updates.length && <div className="text-muted" style={{ fontSize: 13 }}>Nothing new from anyone.</div>}
          {updates?.map((u) => {
            const n = u.notice ? notices.find((x) => x.id === u.id) : null;
            return (
              <div key={u.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <button type="button" className="bare" onClick={u.href ? () => onGo(u.href!) : undefined} style={{ all: 'unset', cursor: u.href ? 'pointer' : 'default', flex: 1, display: 'grid', gap: 2 }}>
                  <span style={{ fontSize: 13 }}>{u.text}</span>
                  <span className="text-muted" style={{ fontSize: 11.5 }}>{n ? `${n.text} · ` : ''}{ago(u.at)}</span>
                </button>
                {n && <button type="button" className="btn btn-ghost" onClick={() => onDismiss(n.id)} aria-label="Mark as seen" title="Mark as seen" style={{ fontSize: 14, padding: '0 8px' }}>×</button>}
              </div>
            );
          })}
          <Link to="/admin/activity" className="text-muted" style={{ fontSize: 12 }}>Activity log</Link>
        </section>
      </aside>
    </>
  );
}

/**
 * Add, the way you'd say it: "Pick up kids at 3 on Saturday". What it understood shows underneath, ready to fix,
 * and nothing is saved until you press Add.
 */
function QuickAdd({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const { refresh } = useAdmin();
  const toast = useToast();
  const { run, busy } = useAction();
  const [kind, setKind] = useState<'event' | 'task'>('event');
  const [text, setText] = useState('');
  const [fix, setFix] = useState<{ date?: string | null; time?: string | null }>({});
  const [who, setWho] = useState('');
  const { data: people } = useAsync(() => get<{ items: Party[] }>('/api/parties'), []);
  const read = useMemo(() => readWhen(text), [text]);
  const date = fix.date !== undefined ? fix.date : read.date;
  const time = kind === 'task' ? null : fix.time !== undefined ? fix.time : read.time;
  const person = people?.items.find((p) => p.id === who);
  const asks = !!person?.node && person.status === 'active';
  const ready = !!read.title && (kind === 'task' || !!date);

  const reset = () => { setText(''); setFix({}); setWho(''); };
  const add = async () => {
    if (!ready || busy) return;
    if (kind === 'event') {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const end = time && read.endTime && fix.time === undefined ? { at: `${date}T${read.endTime}`, tz } : undefined;
      const ok = await run(() => post('/api/data/events', { data: { title: read.title, start: { at: `${date}T${time ?? '00:00'}`, tz }, ...(end ? { end } : {}), allDay: !time } }));
      if (ok) { toast(`${read.title} · ${sayWhen(date, time)}`); reset(); refresh(); }
    } else {
      const r = await run(() => post<{ asked: boolean }>('/api/tasks', { title: read.title, due: date, who: who || null }));
      if (r) { toast(r.asked ? `Asked ${first(person!.name)}. Their answer shows here and in your messages.` : 'Added to your tasks'); reset(); refresh(); }
    }
  };

  return (
    <section className="ab-section">
      <Pills value={kind} size={12} options={[['event', 'Event'], ['task', 'Task']]} onChange={(v) => { setKind(v as 'event' | 'task'); setFix({}); }} />
      <input ref={inputRef} className="input" value={text} onChange={(e) => { setText(e.target.value); setFix({}); }} onKeyDown={(e) => e.key === 'Enter' && add()}
        placeholder={kind === 'event' ? 'Pick up kids at 3 on Saturday' : 'Test software on Saturday'} aria-label={kind === 'event' ? 'New event' : 'New task'} />
      {text.trim() && (
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
function Tasks({ tasks }: { tasks: { open: Task[]; done: Task[] } | null }) {
  const { refresh } = useAdmin();
  const { run } = useAction();
  const [showDone, setShowDone] = useState(false);
  if (!tasks) return null;
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
      <div className="card-kicker">Your tasks</div>
      {tasks.open.length ? tasks.open.map(row) : <div className="text-muted" style={{ fontSize: 13 }}>Nothing to do. Add one above.</div>}
      {tasks.done.length > 0 && (
        <>
          <button type="button" className="btn btn-ghost" onClick={() => setShowDone(!showDone)} style={{ fontSize: 12, justifySelf: 'start', padding: '2px 0' }}>{showDone ? 'Hide done' : `Done this week (${tasks.done.length})`}</button>
          {showDone && tasks.done.map(row)}
        </>
      )}
    </section>
  );
}
