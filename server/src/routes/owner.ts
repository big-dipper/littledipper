import type { FastifyInstance } from 'fastify';
import { ctx } from '../ctx.js';
import { bad, HttpError, requireOwner } from '../auth.js';
import { mask } from '../fields.js';
import { getOwner } from '../owner.js';
import { ownerEmail, ownerName, profileLines, PROFILE_LINES } from '../profile.js';
import { grantsFor, type LinkDoc, type PublicProfileDoc } from '../federation.js';

export default async function ownerRoutes(app: FastifyInstance) {
  // The account: who signs in. The name and email are worked out from Names and Contact methods, never stored twice.
  app.get('/api/owner', async (req) => {
    const p = await requireOwner(req, 'owner:read');
    const o = (await getOwner())!;
    return {
      id: o._id, name: await ownerName(), email: await ownerEmail(), prefs: o.prefs,
      role: p.key.scopes.includes('admin:*') ? 'admin:*' : p.key.scopes.join(' '),
    };
  });

  /** Only preferences live on the account. */
  app.patch('/api/owner', async (req) => {
    const p = await requireOwner(req, 'owner:write');
    if (p.key.assistant) throw new HttpError(403, 'owner_only', 'Only the owner changes their account settings.');
    const body = (req.body || {}) as { name?: string; email?: string; prefs?: { showTechnical?: boolean } };
    if (body.name !== undefined || body.email !== undefined) throw bad('computed', 'Your name comes from Names and your email from Contact methods. Change them there.');
    const o = (await getOwner())!;
    if (body.prefs) {
      if (!p.isSession) throw bad('session_required');
      await ctx.store.update('owners', o._id, { prefs: { ...o.prefs, showTechnical: !!body.prefs.showTechnical } });
    }
    const out = (await getOwner())!;
    return { id: out._id, name: await ownerName(), email: await ownerEmail(), prefs: out.prefs };
  });

  /**
   * Your profile: your current facts, worked out from your categories. Each line says where it comes from (edit it
   * there), how sensitive it is, whether it's on your public page and how many connections can read it.
   * Secret lines are masked except in your own browser.
   */
  app.get('/api/profile', async (req) => {
    const p = await requireOwner(req, 'owner:read');
    const lines = await profileLines();
    const pp = await ctx.store.get<PublicProfileDoc>('publicProfile', 'public');
    const links = await ctx.store.find<LinkDoc>('nodeLinks', { status: 'active' });
    const grants = await Promise.all(links.map((l) => grantsFor(l.contactId)));
    const basicN = grants.filter((g) => g.profile).length;
    const reading = (key: string, standard: boolean) => grants.filter((g) => (standard && g.profile) || g.fields.includes(key)).length;
    return {
      items: lines.map((l) => ({
        ...l,
        value: l.sensitivity === 'secret' && !p.isSession ? mask(l.value) : l.value,
        public: l.sensitivity !== 'secret' && !!pp?.fieldKeys.includes(l.key),
        sharedWith: l.sensitivity === 'secret' ? 0 : reading(l.key, l.sensitivity === 'standard'),
      })),
      /** Every line the profile can have, for screens that offer them before they have a value. */
      lines: PROFILE_LINES.map(([key, label]) => ({ key, label })),
      basicProfileContacts: basicN,
    };
  });
}
