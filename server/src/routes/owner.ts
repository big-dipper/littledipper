import type { FastifyInstance } from 'fastify';
import { ctx } from '../ctx.js';
import { bad, HttpError, requireOwner } from '../auth.js';
import { mask } from '../fields.js';
import { checkAppearance, getOwner } from '../owner.js';
import { ownerEmail, ownerName, profileLines, PROFILE_LINES } from '../profile.js';
import { type LinkDoc, type PublicProfileDoc } from '../federation.js';
import { ALWAYS_SHARED, basicLines, RELATIONS, suggestions, whatTheyGet, type Relation } from '../shares.js';
import { getDomain } from '../domains/records.js';
import { nudgePeers } from '../contacts.js';

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
    const body = (req.body || {}) as { name?: string; email?: string; prefs?: { showTechnical?: boolean; appearance?: unknown } };
    if (body.name !== undefined || body.email !== undefined) throw bad('computed', 'Your name comes from Names and your email from Contact methods. Change them there.');
    const o = (await getOwner())!;
    if (body.prefs) {
      if (!p.isSession) throw bad('session_required');
      // Only what's sent changes: saving a theme leaves "Show technical details" as it was.
      const prefs = { ...o.prefs };
      if (body.prefs.showTechnical !== undefined) prefs.showTechnical = !!body.prefs.showTechnical;
      if (body.prefs.appearance !== undefined) prefs.appearance = checkAppearance(body.prefs.appearance);
      await ctx.store.update('owners', o._id, { prefs });
    }
    const out = (await getOwner())!;
    return { id: out._id, name: await ownerName(), email: await ownerEmail(), prefs: out.prefs };
  });

  /**
   * Your profile: your current facts, worked out from your categories. Each line says where it comes from (edit it
   * there), how sensitive it is, whether it's on your public page and how many connections can read it.
   * Secret lines are masked except in your own browser.
   */
  /** Your basic profile: the lines every connection gets unless you choose otherwise. Your Little Dipper is always on it. */
  app.get('/api/profile/basic', async (req) => {
    await requireOwner(req, 'owner:read');
    return { lines: await basicLines(), always: [ALWAYS_SHARED] };
  });

  app.put('/api/profile/basic', async (req) => {
    const p = await requireOwner(req, 'owner:write');
    if (p.key.assistant) throw new HttpError(403, 'owner_only', 'What every connection sees is the owner’s call.');
    const { lines } = (req.body || {}) as { lines?: unknown };
    if (!Array.isArray(lines)) throw bad('invalid_value', 'lines: a list of profile lines');
    const keys = [...new Set(lines.map(String))].filter((k) => k !== ALWAYS_SHARED);
    const unknown = keys.filter((k) => !PROFILE_LINES.some(([x]) => x === k));
    if (unknown.length) throw bad('unknown_field', `Your profile has no ${unknown.join(', ')}`);
    const secret = (await profileLines()).filter((l) => keys.includes(l.key) && l.sensitivity === 'secret');
    if (secret.length) throw bad('secret_line', `${secret.map((l) => l.label).join(', ')} is secret, so it can't be in your basic profile.`);
    const o = (await getOwner())!;
    await ctx.store.update('owners', o._id, { basicProfile: keys });
    nudgePeers(null);
    return { lines: await basicLines(), always: [ALWAYS_SHARED] };
  });

  /** What each relationship (friend, colleague…) pre-ticks when you connect. Suggestions only, never applied silently. */
  app.get('/api/profile/suggestions', async (req) => {
    await requireOwner(req, 'owner:read');
    return { suggestions: await suggestions(), relations: RELATIONS };
  });

  app.put('/api/profile/suggestions', async (req) => {
    const p = await requireOwner(req, 'owner:write');
    if (p.key.assistant) throw new HttpError(403, 'owner_only', 'What you suggest sharing is the owner’s call.');
    const b = (req.body || {}) as { relation?: string; items?: unknown };
    if (!RELATIONS.includes(b.relation as Relation)) throw bad('invalid_value', `relation: ${RELATIONS.join(', ')}`);
    if (!Array.isArray(b.items)) throw bad('invalid_value', 'items: a list');
    const items = [...new Set(b.items.map(String))];
    for (const it of items) {
      const cat = it.match(/^category:([a-z0-9_]+):(all|current)$/);
      if (cat ? !(await getDomain(cat[1])) : !PROFILE_LINES.some(([k]) => k === it)) throw bad('invalid_value', `Unknown suggestion ${it}`);
    }
    const o = (await getOwner())!;
    const all = await suggestions();
    await ctx.store.update('owners', o._id, { suggestions: { ...all, [b.relation as Relation]: items } });
    return { suggestions: await suggestions(), relations: RELATIONS };
  });

  app.get('/api/profile', async (req) => {
    const p = await requireOwner(req, ['owner:read', 'profile:read']);
    const lines = await profileLines();
    // A party (an assistant) reads the lines its share includes, nothing about who else sees what.
    if (p.key.access) {
      const allowed = new Set(p.key.access.lines);
      return { items: lines.filter((l) => allowed.has(l.key) && l.sensitivity !== 'secret').map(({ key, label, value }) => ({ key, label, value })) };
    }
    const pp = await ctx.store.get<PublicProfileDoc>('publicProfile', 'public');
    const links = await ctx.store.find<LinkDoc>('nodeLinks', { status: 'active' });
    const shares = await Promise.all(links.map((l) => whatTheyGet(l.contactId)));
    const basic = await basicLines();
    const basicN = shares.filter((g) => g.basic).length;
    const reading = (key: string) => shares.filter((g) => (g.basic && basic.includes(key)) || g.lines.includes(key)).length;
    return {
      items: lines.map((l) => ({
        ...l,
        value: l.sensitivity === 'secret' && !p.isSession ? mask(l.value) : l.value,
        public: l.sensitivity !== 'secret' && !!pp?.fieldKeys.includes(l.key),
        inBasic: basic.includes(l.key),
        sharedWith: l.sensitivity === 'secret' ? 0 : reading(l.key),
      })),
      /** Every line the profile can have, for screens that offer them before they have a value. */
      lines: PROFILE_LINES.map(([key, label]) => ({ key, label })),
      /** The basic profile list, including lines that have no value yet. */
      basic,
      basicProfileContacts: basicN,
    };
  });
}
