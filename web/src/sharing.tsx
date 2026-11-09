/**
 * The sharing pieces people actually see: what you'll share with someone, in plain words, with an optional
 * "Who is Theo to you?" that only pre-ticks suggestions. Used when you connect (either direction) and on a contact's
 * page. No tags, no categories-and-scopes at first sight: those live behind "More options" on the contact page.
 */
import { useEffect, useState } from 'react';
import { get, type ProfileResp } from './api';
import { fetchCatalog, type Domain } from './life';
import { Pills } from './ui';

export type Relation = 'friend' | 'colleague' | 'family' | 'business' | 'other';
export const RELATION_LABEL: Record<Relation, string> = { friend: 'A friend', colleague: 'A colleague', family: 'Family', business: 'A business', other: 'Someone else' };

/** What you'll share: the basic profile always, plus ticked extras (profile lines, or `category:<domain>:<scope>`). */
export type Choice = { extras: string[] };

export type SharingData = { profile: ProfileResp; suggestions: Record<Relation, string[]>; catalog: Domain[] };

export async function loadSharing(): Promise<SharingData> {
  const [profile, s, catalog] = await Promise.all([
    get<ProfileResp>('/api/profile'), get<{ suggestions: Record<Relation, string[]> }>('/api/profile/suggestions'), fetchCatalog(),
  ]);
  return { profile, suggestions: s.suggestions, catalog };
}

/** An item in words: "Your mobile", "Your current job", "All your education". */
export function itemLabel(item: string, data: SharingData) {
  const cat = item.match(/^category:([a-z0-9_]+):(all|current)$/);
  if (cat) {
    const d = data.catalog.find((x) => x.id === cat[1]);
    if (!d) return item;
    return cat[2] === 'current' ? `Your current ${d.noun}` : `All your ${d.label.toLowerCase()}`;
  }
  const l = data.profile.lines.find((x) => x.key === item)?.label ?? item;
  return `Your ${l.charAt(0).toLowerCase()}${l.slice(1)}`;
}

/** The value a line would share, so it's concrete ("(503) 555-0148"), or nothing if you haven't added it. */
const valueOf = (item: string, data: SharingData) => data.profile.items.find((l) => l.key === item)?.value;
/** Lines you have, not secret, not already in your basic profile: what you can add for one person. */
export const extraLines = (data: SharingData) =>
  data.profile.items.filter((l) => l.sensitivity !== 'secret' && !data.profile.basic.includes(l.key)).map((l) => l.key);

/** The share body the server takes, from a choice. */
export function toShare(choice: Choice) {
  const lines = choice.extras.filter((x) => !x.startsWith('category:'));
  const categories = Object.fromEntries(choice.extras.filter((x) => x.startsWith('category:')).map((x) => { const [, d, scope] = x.split(':'); return [d, { scope }]; }));
  return { basic: true, lines, categories };
}

/**
 * "You'll share with Theo": the basic profile in words, "Who is Theo to you?" (optional; it only pre-ticks), the extras
 * as a short checklist, and any requests they made as their own called-out, unticked lines.
 */
export function ShareChooser({ data, first, choice, onChange, requested = [], relation, onRelation, showBasic = true }: {
  data: SharingData; first: string; choice: Choice; onChange: (c: Choice) => void; requested?: string[];
  relation: Relation | ''; onRelation: (r: Relation | '') => void; showBasic?: boolean;
}) {
  const basic = data.profile.basic.filter((k) => data.profile.items.some((l) => l.key === k));
  const has = (item: string) => item.startsWith('category:') ? data.catalog.some((d) => d.id === item.split(':')[1] && d.count > 0) : !!valueOf(item, data);
  const suggested = relation ? data.suggestions[relation].filter(has) : [];
  const asked = requested.filter((k) => !basic.includes(k) && has(k));
  // The list shows what's suggested and what's already ticked; requests get their own lines below.
  const shown = [...new Set([...suggested, ...choice.extras])].filter((x) => !asked.includes(x));
  const toggle = (item: string) => onChange({ extras: choice.extras.includes(item) ? choice.extras.filter((x) => x !== item) : [...choice.extras, item] });
  const pickRelation = (r: Relation | '') => {
    onRelation(r);
    // A relationship pre-ticks its suggestions; it never unticks what you chose yourself or a request you ticked.
    const add = r ? data.suggestions[r].filter(has) : [];
    onChange({ extras: [...new Set([...choice.extras.filter((x) => asked.includes(x)), ...add])] });
  };
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {showBasic && (
        <div>
          <div style={{ fontWeight: 600 }}>You’ll share with {first}</div>
          <div className="text-muted" style={{ fontSize: 14 }}>{giveList(data, { extras: [] }).map((g) => (g.key === 'little_dipper' ? g.value.split(' · ')[0] : g.value || g.label)).join(' · ')}</div>
        </div>
      )}
      <div>
        <div style={{ fontSize: 14, marginBottom: 6 }}>Who is {first} to you? <span className="text-muted" style={{ fontSize: 12 }}>(optional)</span></div>
        <Pills value={relation} size={12} onChange={(v) => pickRelation(v === relation ? '' : (v as Relation))} options={Object.entries(RELATION_LABEL) as [string, string][]} />
      </div>
      {shown.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {shown.map((item) => <Tick key={item} on={choice.extras.includes(item)} label={itemLabel(item, data)} value={valueOf(item, data)} onChange={() => toggle(item)} />)}
        </div>
      )}
      {asked.length > 0 && (
        <div style={{ display: 'grid', gap: 6, padding: '12px 14px', borderRadius: 18, background: 'var(--color-accent-100)' }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{first} also asks for</div>
          {asked.map((item) => <Tick key={item} on={choice.extras.includes(item)} label={itemLabel(item, data)} value={valueOf(item, data)} onChange={() => toggle(item)} />)}
        </div>
      )}
      <div className="text-muted" style={{ fontSize: 13 }}>Once you’re connected, you can add or remove anything here, one thing at a time.</div>
    </div>
  );
}

function Tick({ on, label, value, onChange }: { on: boolean; label: string; value?: string; onChange: () => void }) {
  return (
    <label style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 14, cursor: 'pointer' }}>
      <input type="checkbox" checked={on} onChange={onChange} style={{ transform: 'translateY(2px)' }} />
      <span>{label}{value && <span className="text-muted" style={{ fontSize: 12 }}> · {value}</span>}</span>
    </label>
  );
}

/** What you'd give, in values ("Maya Lindqvist", "Portland, OR"): the basic profile plus ticked extras. */
export function giveList(data: SharingData, choice: Choice): { key: string; label: string; value: string }[] {
  const val = (k: string) => {
    const v = data.profile.items.find((l) => l.key === k)?.value ?? '';
    return v;
  };
  const basic = data.profile.basic.filter((k) => data.profile.items.some((l) => l.key === k));
  const extras = choice.extras.filter((x) => !basic.includes(x));
  return [...basic, ...extras].map((k) => ({ key: k, label: k.startsWith('category:') ? itemLabel(k, data) : (k === 'little_dipper' ? 'Little Dipper' : data.profile.lines.find((l) => l.key === k)?.label ?? k), value: k.startsWith('category:') ? '' : val(k) }));
}

/** "Ask Theo for anything else?": things on a person's card only. No reasons between people. */
export function AskChooser({ data, first, asks, onChange }: { data: SharingData; first: string; asks: string[]; onChange: (a: string[]) => void }) {
  const options = data.profile.lines.filter((l) => !['little_dipper', 'preferred_name', 'marital_status', 'nationality', 'birth_name', 'residency', 'citizenship'].includes(l.key));
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ fontSize: 14 }}>Ask {first} for anything else? <span className="text-muted" style={{ fontSize: 12 }}>(optional)</span></div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {options.map((l) => (
          <label key={l.key} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
            <input type="checkbox" checked={asks.includes(l.key)} onChange={() => onChange(asks.includes(l.key) ? asks.filter((x) => x !== l.key) : [...asks, l.key])} />
            Their {l.label.charAt(0).toLowerCase()}{l.label.slice(1)}
          </label>
        ))}
      </div>
    </div>
  );
}

/** Load the sharing data once for a screen. */
export function useSharing() {
  const [data, setData] = useState<SharingData | null>(null);
  useEffect(() => { loadSharing().then(setData).catch(() => {}); }, []);
  return data;
}

