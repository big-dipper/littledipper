/**
 * Big Dipper, the optional companion service. One connection, separate opt-in services.
 * Big Dipper doesn't exist yet: this is the owner's experience (benefits, risks, options) and a saved choice.
 * How each service works is decided when Big Dipper is built (OPEN-QUESTIONS 6, 15, 16).
 * Until LD_BIG_DIPPER_URL is set, owners can choose and we keep the choice.
 */
import type { FastifyInstance } from 'fastify';
import { ctx } from '../ctx.js';
import { config } from '../config.js';
import { audit, ownerActor } from '../audit.js';
import { bad, HttpError, requireOwner, requireSession } from '../auth.js';
import { canonicalUrl, displayAddr, getNode } from '../node.js';
import { sendSigned } from '../federation.js';
import type { LinkDoc, PartyDoc } from '../federation.js';
import { requestConnection } from './contacts.js';

type Option = { key: string; title: string; text: string; requires?: { setting: string; values: string[] } };
type Setting = { key: string; label: string; help?: string; options: Option[]; default: string; showWhen?: { setting: string; values: string[] } };

const HOSTING: (Option & { note: string })[] = [
  { key: 'platform', title: 'A cloud platform', text: 'Render, Railway, Fly.io or similar.', note: 'Updating is a redeploy. If you add a deploy hook (a link that can redeploy your server and nothing else), Big Dipper can start it for you.' },
  { key: 'oneclick', title: 'Big Dipper’s one-click install', text: 'You set up through Big Dipper.', note: 'Big Dipper already knows how your server was set up, so every option is open.' },
  { key: 'docker', title: 'Docker on my own server', text: 'A VPS or machine you manage.', note: 'Automatic updates need a small updater running beside Little Dipper. Big Dipper tells it when a tested release is ready.' },
  { key: 'manual', title: 'My own server, set up by hand', text: 'Installed from source.', note: 'Big Dipper tells you when a release is ready and gives you step-by-step instructions for your setup.' },
  { key: 'home', title: 'A device at home', text: 'Raspberry Pi, NAS, home server.', note: 'A small updater can install security fixes for you. Bigger releases wait for you, in case the device needs attention.' },
  { key: 'unsure', title: 'I’m not sure', text: 'Someone set it up for me.', note: 'Start with notices. After you connect, Big Dipper can help you work out your setup.' },
];
const ALL = HOSTING.map((h) => h.key);

const SERVICES: {
  key: string; title: string; tagline: string; forYou: string[]; forOthers: string[]; thingsToKnow: string[]; price?: string; settings: Setting[];
}[] = [
  {
    key: 'feedback', title: 'Feedback', tagline: 'Report a problem or share an idea, with a picture of what you see',
    forYou: ['A feedback button in your Little Dipper: say what happened, point at it on a screenshot, send', 'A reply in Messages when it’s been filed, and later when there’s news'],
    forOthers: ['Problems you hit get fixed for everyone', 'Your ideas shape what Little Dipper does next'],
    thingsToKnow: [
      'Nothing is sent until you press Send, and you see exactly what goes first.',
      'Screenshots blur what’s on the page (names, numbers, dates) unless you choose to show it. Labels and layout stay clear.',
      'Big Dipper files it in Linear, the tool the Little Dipper team tracks work in, with your Little Dipper’s address and Node ID so it can reply in Messages. Not your name. Linear keeps it.',
    ],
    settings: [],
  },
  {
    key: 'interface', title: 'Interface checks', tagline: 'Proof your Little Dipper speaks the standard',
    forYou: ['Problems are caught before contacts or apps run into them', 'A short report in Messages after each check'],
    forOthers: ['Apps, assistants and other nodes can see an “Interface checked” mark with the date', 'They can rely on your node without testing it themselves'],
    thingsToKnow: [
      'Big Dipper visits your node on a schedule, the way any visitor can, and learns which version you run and whether it’s healthy.',
      'If you show the mark, people can also see when it lapses.',
    ],
    settings: [
      { key: 'interface.frequency', label: 'How often', options: [{ key: 'weekly', title: 'Weekly', text: 'A steady check-in.' }, { key: 'daily', title: 'Daily', text: 'Catch problems sooner.' }, { key: 'updates', title: 'After updates only', text: 'The fewest visits.' }], default: 'weekly' },
      { key: 'interface.mark', label: 'The “Interface checked” mark', options: [{ key: 'show', title: 'Show it', text: 'Apps and contacts can see it.' }, { key: 'private', title: 'Keep it private', text: 'Only you see the results.' }], default: 'show' },
    ],
  },
  {
    key: 'upgrades', title: 'Managed upgrades', tagline: 'Stay current and secure, at the pace you choose',
    forYou: ['Each release is tested against the standard before it reaches you', 'You decide how much happens automatically, and see what changed'],
    forOthers: ['Your contacts are talking to a current, patched node', 'Fewer broken connections after releases'],
    thingsToKnow: [
      'Any update can occasionally change how something works. Big Dipper tests first, and your node takes a backup before each update.',
      'With automatic updates, changes can happen while you’re away. You get a note in Messages every time.',
      'What’s possible depends on how your Little Dipper is hosted. Your node pulls updates itself; Big Dipper never gets admin access.',
    ],
    settings: [
      { key: 'upgrades.hosting', label: 'How is your Little Dipper hosted?', help: 'This decides which update options work for you.', options: HOSTING.map(({ key, title, text }) => ({ key, title, text })), default: 'unsure' },
      {
        key: 'upgrades.mode', label: 'How updates install', options: [
          { key: 'notify', title: 'Tell me', text: 'You decide when to install each release.' },
          { key: 'security', title: 'Security fixes on their own', text: 'You decide on everything else.', requires: { setting: 'upgrades.hosting', values: ['platform', 'oneclick', 'docker', 'home'] } },
          { key: 'all', title: 'Everything on its own', text: 'Every tested release installs itself.', requires: { setting: 'upgrades.hosting', values: ['platform', 'oneclick', 'docker'] } },
        ], default: 'notify',
      },
      { key: 'upgrades.window', label: 'When automatic updates may run', showWhen: { setting: 'upgrades.mode', values: ['security', 'all'] }, options: [{ key: 'overnight', title: 'Overnight', text: 'Between 2 and 5 am your time.' }, { key: 'anytime', title: 'Any time', text: 'As soon as a release is ready.' }], default: 'overnight' },
    ],
  },
  {
    key: 'identity', title: 'ID verification', tagline: 'Prove who you are once, without handing over documents again',
    forYou: ['Verify once, then reuse it whenever someone needs to know it’s really you', 'Every request to see your result comes to you first; nothing is shared without your yes'],
    forOthers: ['Landlords, employers and businesses get a trusted answer: verified, and the current profile matches', 'They see only the claims they need, and never have to collect or store your ID documents'],
    thingsToKnow: [
      'You’ll show an ID document and a live selfie during the check. They’re deleted afterwards; Big Dipper keeps only the result and a fingerprint (a salted hash) of each checked value.',
      'A result is only as fresh as its last re-check.',
      'If someone took over your Little Dipper they could misuse your result. Tell Big Dipper and it can withdraw the result quickly.',
    ],
    price: 'You pay once to verify, plus a smaller fee for each re-check. Prices are set when Big Dipper opens.',
    settings: [
      { key: 'identity.recheck', label: 'Re-checks', help: 'Keeps your result fresh, so people can rely on it.', options: [{ key: 'yearly', title: 'Every year', text: 'Recommended.' }, { key: 'biennial', title: 'Every two years', text: 'Fewer re-checks.' }, { key: 'manual', title: 'Only when I ask', text: 'Your result shows its age.' }], default: 'yearly' },
    ],
  },
];

const BOUNDARIES = [
  { key: 'nothing', title: 'Nothing until you connect', text: 'Big Dipper doesn’t learn your address or node ID until you send a connection request.' },
  { key: 'keys', title: 'You keep the keys', text: 'No admin access, ever. Big Dipper reaches your node only the way any contact can.' },
  { key: 'ask', title: 'It asks, every time', text: 'Once connected, anything more it needs comes to you as a request, with a reason.' },
  { key: 'leave', title: 'Leave whenever', text: 'Turn off any service, or disconnect to end them all. Little Dipper works fully without it.' },
];
const JOURNEY = [
  { title: 'Choose', text: 'Pick services and options here. Nothing is sent.' },
  { title: 'Connect', text: 'You send a request. Big Dipper learns your address and node ID, nothing else.' },
  { title: 'As needed', text: 'Each service asks for what it needs, when it needs it. You approve each time.' },
  { title: 'Your call', text: 'Change options, pause a service or disconnect at any time.' },
];

const SETTINGS = SERVICES.flatMap((s) => s.settings);
const DETECTED: Record<string, string> = { render: 'platform', railway: 'platform', fly: 'platform', docker: 'docker' };
const detectedHosting = () => DETECTED[config.hosting.provider] ?? 'unsure';
const norm = (u: string) => u.replace(/\/+$/, '');

function defaults(): Record<string, string> {
  const d = Object.fromEntries(SETTINGS.map((s) => [s.key, s.default]));
  d['upgrades.hosting'] = detectedHosting();
  return d;
}
const allowed = (o: Option, v: Record<string, string>) => !o.requires || o.requires.values.includes(v[o.requires.setting]);

async function bigDipperLink() {
  const url = config.bigDipperUrl;
  if (!url) return undefined;
  return (await ctx.store.find<LinkDoc>('nodeLinks', {})).find((l) => norm(l.peerUrl) === url);
}

function checkChoices(b: { services?: unknown; settings?: unknown }) {
  const services = Array.isArray(b.services) ? [...new Set(b.services.map(String))] : [];
  const unknown = services.find((k) => !SERVICES.some((s) => s.key === k));
  if (unknown) throw bad('invalid_value', `Unknown Big Dipper service ${unknown}`);
  const settings = defaults();
  for (const [k, v] of Object.entries((b.settings ?? {}) as Record<string, unknown>)) {
    const s = SETTINGS.find((x) => x.key === k);
    if (!s) throw bad('invalid_value', `Unknown Big Dipper setting ${k}`);
    if (!s.options.some((o) => o.key === String(v))) throw bad('invalid_value', `${s.label}: unknown option ${String(v)}`);
    settings[k] = String(v);
  }
  for (const s of SETTINGS) {
    const o = s.options.find((x) => x.key === settings[s.key])!;
    if (!allowed(o, settings)) throw bad('invalid_value', `${o.title} isn’t available with ${HOSTING.find((h) => h.key === settings['upgrades.hosting'])!.title.toLowerCase()}`);
  }
  return { services, settings };
}

type Choice = ReturnType<typeof checkChoices>;

function summary(c: Choice) {
  return c.services.map((k) => {
    const s = SERVICES.find((x) => x.key === k)!;
    const opts = s.settings.map((st) => st.options.find((o) => o.key === c.settings[st.key])!.title.toLowerCase());
    return `${s.title} (${opts.join(', ')})`;
  });
}

async function saveChoices(keyId: string, c: Choice) {
  const n = await getNode();
  await ctx.store.update('nodes', n._id, { bigDipper: { ...c, updatedAt: new Date().toISOString() } });
  const names = c.services.map((k) => SERVICES.find((s) => s.key === k)!.title);
  await audit({ actor: ownerActor(keyId), action: 'bigdipper.services', resource: 'big-dipper', text: names.length ? `You chose Big Dipper services: ${names.join(', ')}` : 'You turned off all Big Dipper services', tone: 'owner' });
}

const FEEDBACK_TYPES = ['bug', 'idea', 'question', 'other'];
const SHOT_MAX = 6 * 1024 * 1024; // a data URL; about 4.5 MB of PNG

async function feedbackReady(link: LinkDoc | undefined, n: Awaited<ReturnType<typeof getNode>>) {
  return !!link && link.status === 'active' && (n.bigDipper?.services ?? []).includes('feedback') && (link.peerCapabilities ?? []).includes('feedback');
}

/** One annotation on the screenshot: a numbered pin, a lettered box or an arrow, in screenshot pixels. */
function cleanMarks(v: unknown) {
  if (!Array.isArray(v)) return [];
  const num = (x: unknown) => (Number.isFinite(Number(x)) ? Math.round(Number(x)) : 0);
  return v.slice(0, 64).filter((m) => m && ['pin', 'box', 'arrow'].includes(m.kind)).map((m) => ({
    kind: m.kind as string, x: num(m.x), y: num(m.y), w: num(m.w), h: num(m.h), x2: num(m.x2), y2: num(m.y2), comment: String(m.comment ?? '').slice(0, 500),
  }));
}

export default async function bigDipperRoutes(app: FastifyInstance) {
  app.get('/api/big-dipper', async (req) => {
    await requireOwner(req, 'parties:read');
    const n = await getNode();
    const link = await bigDipperLink();
    const url = config.bigDipperUrl;
    return {
      available: !!url,
      url: url || null,
      address: url ? displayAddr(url) : null,
      contact: link ? { contactId: link.contactId, status: link.status } : null,
      /** The feedback button shows when you're connected, you chose Feedback, and Big Dipper offers it. */
      feedback: await feedbackReady(link, n),
      chosen: n.bigDipper?.services ?? [],
      settings: { ...defaults(), ...(n.bigDipper?.settings ?? {}) },
      choseAt: n.bigDipper?.updatedAt ?? null,
      detectedHosting: { key: detectedHosting(), label: config.hosting.label },
      hostingNotes: Object.fromEntries(HOSTING.map((h) => [h.key, h.note])),
      services: SERVICES,
      boundaries: BOUNDARIES,
      journey: JOURNEY,
    };
  });

  /** Save which services and options the owner wants. A consent choice, so only the owner's own session. */
  app.put('/api/big-dipper', async (req) => {
    const p = await requireSession(req);
    if (!p.isSession) throw bad('session_required');
    const choice = checkChoices((req.body || {}) as object);
    await saveChoices(p.key._id, choice);
    return { ok: true, ...choice };
  });

  /** Save the choice and send Big Dipper a connection request that names it. Big Dipper gets no profile or fields. */
  app.post('/api/big-dipper/connect', async (req, reply) => {
    const p = await requireSession(req);
    if (!p.isSession) throw bad('session_required');
    const choice = checkChoices((req.body || {}) as object);
    if (!choice.services.length) throw bad('invalid_value', 'Choose at least one service');
    if (!config.bigDipperUrl) throw new HttpError(409, 'big_dipper_unavailable', 'Big Dipper isn’t open yet. Your choices are saved.');
    await saveChoices(p.key._id, choice);
    const out = await requestConnection(p.key._id, config.bigDipperUrl, { basic: false }, `Services: ${summary(choice).join('; ')}`.slice(0, 500));
    reply.code(202);
    return out;
  });

  /**
   * Send feedback to Big Dipper: the owner's words, an optional screenshot (already blurred in the browser unless
   * they chose otherwise) and where in the app it happened. Signed by this node; Big Dipper answers with a reference.
   */
  app.post('/api/big-dipper/feedback', { bodyLimit: SHOT_MAX + 256 * 1024 }, async (req) => {
    const p = await requireSession(req);
    if (!p.isSession) throw bad('session_required');
    const n = await getNode();
    const link = await bigDipperLink();
    if (!(await feedbackReady(link, n))) throw new HttpError(409, 'feedback_off', 'Connect to Big Dipper and turn on Feedback first.');
    const b = (req.body || {}) as { type?: string; comment?: string; screenshot?: string | null; marks?: unknown; context?: Record<string, unknown> };
    const type = String(b.type || '');
    if (!FEEDBACK_TYPES.includes(type)) throw bad('invalid_value', 'Choose bug, idea, question or other');
    const comment = String(b.comment || '').trim().slice(0, 5000);
    if (!comment) throw bad('invalid_value', 'Say what’s going on first');
    const shot = b.screenshot ? String(b.screenshot) : null;
    if (shot && (!shot.startsWith('data:image/png;base64,') || shot.length > SHOT_MAX)) throw bad('invalid_value', 'The screenshot must be a PNG under about 4 MB');
    const c = b.context || {};
    const vp = c.viewport as { w?: unknown; h?: unknown } | undefined;
    // Where it happened, and on what: never the owner's name or data (Big Dipper knows the node from the connection).
    const context = {
      route: String(c.route || '').slice(0, 200),
      viewport: vp && Number.isFinite(Number(vp.w)) && Number.isFinite(Number(vp.h)) ? { w: Number(vp.w), h: Number(vp.h) } : null,
      blurred: c.blurred !== false,
      appearance: String(c.appearance || '').slice(0, 80),
      version: n.version,
      hosting: config.hosting.label,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    };
    const out = await sendSigned<object, { type: string; result?: { reference?: string } }>(link!.peerUrl, '/peer/services/feedback', {
      type: 'service.call', to: link!.peerNodeId, capability: 'feedback', address: canonicalUrl(n),
      data: { type, comment, screenshot: shot, marks: cleanMarks(b.marks), context },
    }, link!.peerSigningKey);
    const reference = String(out.result?.reference || '').slice(0, 40) || null;
    const bd = await ctx.store.get<PartyDoc>('parties', link!.contactId);
    await audit({ actor: ownerActor(p.key._id), action: 'bigdipper.feedback', resource: `parties/${link!.contactId}`, text: `You sent ${bd?.name || 'Big Dipper'} feedback${reference ? ` (${reference})` : ''}${shot ? ', with a screenshot' : ''}`, tone: 'owner' });
    return { sent: true, reference };
  });
}
