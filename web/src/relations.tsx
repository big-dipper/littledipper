/**
 * "How you know them" inside a person's own forms (add, edit). How you know someone is a Relationships entry that
 * points to them, not a field of the person: this edits those entries alongside the person, so the owner never has
 * to think about where it's kept. Dates, emergency contact and the rest stay on the entry's own panel.
 */
import { del, get, post } from './api';
import { Select, type Rec } from './life';

export type RelOption = [string, string];
/** One relation in the form: an entry already saved (id), or one to add on save. */
export type RelDraft = { id?: string; relation: string };

/** The relation choices, from the catalog, and this person's current relations. */
export async function loadRelations(partyId: string | null): Promise<{ options: RelOption[]; current: RelDraft[] }> {
  const [{ domains }, recs] = await Promise.all([
    get<{ domains: { id: string; parts: { key: string; options?: RelOption[] }[] }[] }>('/api/catalog'),
    partyId ? get<{ items: Rec[] }>('/api/data/relationships').then((r) => r.items) : Promise.resolve([] as Rec[]),
  ]);
  const options = domains.find((d) => d.id === 'relationships')?.parts.find((p) => p.key === 'relation')?.options ?? [];
  const current = recs.filter((r) => r.data.party === partyId && r.current).map((r) => ({ id: r.id, relation: String(r.data.relation) }));
  return { options, current };
}

/** Save what changed: new relations become entries; ones taken off are deleted (restorable for 30 days). */
export async function saveRelations(partyId: string, before: RelDraft[], after: RelDraft[]) {
  for (const r of before) if (r.id && !after.some((a) => a.id === r.id)) await del(`/api/data/relationships/${r.id}`);
  for (const r of after) if (!r.id) await post('/api/data/relationships', { data: { party: partyId, relation: r.relation } });
}

export function RelationsField({ options, value, onChange, first }: { options: RelOption[]; value: RelDraft[]; onChange: (v: RelDraft[]) => void; first?: string }) {
  const label = (k: string) => options.find(([x]) => x === k)?.[1] ?? k;
  const left = options.filter(([k]) => !value.some((v) => v.relation === k));
  return (
    <div className="field">
      <label>How you know {first || 'them'}</label>
      {value.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {value.map((v, i) => (
            <span key={v.id ?? `new-${v.relation}`} className="tag tag-accent" style={{ gap: 6 }}>
              {label(v.relation)}
              <button type="button" className="bare" aria-label={`Remove ${label(v.relation)}`} onClick={() => onChange(value.filter((_, j) => j !== i))} style={{ cursor: 'pointer', lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
      )}
      <Select value="" placeholder={value.length ? 'Add another…' : 'Choose: friend, sibling, colleague…'} options={left} onChange={(k) => { if (k) onChange([...value, { relation: k }]); }} />
    </div>
  );
}
