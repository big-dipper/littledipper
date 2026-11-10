/**
 * Notifications: updates worth knowing, not actions. Anything waiting for you (an assistant's change to approve, a
 * connection request) is in "Needs you" instead. Background work by an assistant has somewhere to report, without email. They're worked out from what's already stored (Review, keys, the activity
 * log), so there's nothing to keep in sync. Dismissing one hides it; a new event with a new id shows again.
 */
import type { FastifyInstance } from 'fastify';
import { ctx } from '../ctx.js';
import { requireSession, type ApiKeyDoc } from '../auth.js';
import type { AuditDoc } from '../audit.js';
import type { Doc } from '../store/index.js';

type Notice = { id: string; kind: 'ended' | 'safety' | 'digest'; title: string; text: string; href: string; at: string };
type Seen = Doc & { dismissedAt: string };

const WEEK = 7 * 86400_000;

async function notices(): Promise<Notice[]> {
  const out: Notice[] = [];
  const now = Date.now();
  const month = new Date().toISOString().slice(0, 7);

  const keys = await ctx.store.find<ApiKeyDoc>('apiKeys', { kind: 'app' });
  for (const k of keys.filter((x) => x.assistant)) {
    // A connection that reached the length the owner chose, in the last week.
    if (k.expiresAt && !k.revokedAt && Date.parse(k.expiresAt) < now && now - Date.parse(k.expiresAt) < WEEK) {
      out.push({ id: `ended:${k._id}`, kind: 'ended', at: k.expiresAt, href: '/admin/settings/apps', title: `${k.name}'s connection ended`, text: 'It reached the length you chose. Reconnect from the assistant if you still want it.' });
    }
    // This month so far, for assistants still connected.
    if (!k.revokedAt && k.usage?.month === month && (k.usage.reads || k.usage.writes)) {
      const { reads, writes } = k.usage;
      out.push({
        id: `digest:${k._id}:${month}`, kind: 'digest', at: k.lastUsedAt ?? new Date().toISOString(), href: `/admin/settings/apps?assistant=${k._id}`,
        title: `This month ${k.name} looked things up ${reads} ${reads === 1 ? 'time' : 'times'} and made ${writes} ${writes === 1 ? 'change' : 'changes'}`,
        text: 'See what it did, undo anything, or disconnect it.',
      });
    }
  }

  // Connections ended for safety (a sign-in token reused after it was swapped).
  for (const e of (await ctx.store.find<AuditDoc>('audit', { action: 'oauth.reuse' })).filter((x) => now - Date.parse(x.at) < WEEK)) {
    out.push({ id: `safety:${e._id}`, kind: 'safety', at: e.at, href: '/admin/settings/apps', title: 'An assistant was disconnected for safety', text: e.text });
  }

  const seen = new Set((await ctx.store.find<Seen>('notices', {})).map((s) => s._id));
  return out.filter((n) => !seen.has(n.id)).sort((a, b) => b.at.localeCompare(a.at));
}

export default async function notificationRoutes(app: FastifyInstance) {
  app.get('/api/notifications', async (req) => {
    await requireSession(req);
    return { items: await notices() };
  });

  app.post('/api/notifications/:id/dismiss', async (req) => {
    await requireSession(req);
    const id = String((req.params as { id: string }).id).slice(0, 120);
    if (!(await ctx.store.get('notices', id))) await ctx.store.insert<Seen>('notices', { _id: id, dismissedAt: new Date().toISOString() });
    return { dismissed: true };
  });
}
