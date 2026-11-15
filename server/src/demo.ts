/**
 * The hosted demo: one sample Little Dipper (Maya's) that anyone can sign in to and try, refilled with fresh sample
 * data every hour by `scripts/demo.ts --hosted`. LD_DEMO=shared turns it on; it is never set on a real node.
 *
 * Everyone shares the same Maya, so a few things are switched off: whatever would lock the next visitor out,
 * publish to the open internet, keep uploaded files, reach a real Little Dipper or AI outside the demo, or change
 * how the node runs. Everything else (adding, editing, deleting, sharing with Theo, messages, review) works.
 *
 * The demo script fills the node through the same API, so requests carrying LD_DEMO_SEED_KEY skip the guard.
 */
import type { FastifyInstance } from 'fastify';
import { HttpError } from './auth.js';

export const DEMO = process.env.LD_DEMO === 'shared';
const SEED_KEY = process.env.LD_DEMO_SEED_KEY || '';

const LOCKED_SIGNIN = 'Sign-in settings are locked in the demo, so the next person can get in too.';
const RUNNING = 'Running the node (backups, updates, addresses) is switched off in the demo.';
const PUBLIC = 'Maya’s public page stays as it is in the demo, because anyone on the internet can see it.';
const UPLOADS = 'Uploading files is off in the shared demo. On your own Little Dipper, your documents live with your records.';
const OUTSIDE = 'The demo can’t connect to Little Dippers outside it. Theo is here to try sharing with.';
const AI = 'Connecting a real AI assistant is off in the shared demo. Muse shows how an assistant looks.';
const ACCOUNT = 'Maya’s account settings are locked in the demo.';

/** [method ('*' any, 'write' anything but GET/HEAD), path, why]. Paths are matched without the query string. */
const OFF: [string, RegExp, string][] = [
  ['POST', /^\/api\/auth\/(passkeys\/register(\/options)?|recovery-codes|totp\/(setup|enable)|fallback\/disable)$/, LOCKED_SIGNIN],
  ['PUT', /^\/api\/auth\/password$/, LOCKED_SIGNIN],
  ['DELETE', /^\/api\/auth\/passkeys\//, LOCKED_SIGNIN],
  ['DELETE', /^\/api\/keys\//, LOCKED_SIGNIN],
  ['POST', /^\/api\/keys\/[^/]+\/sessions\/undo$/, LOCKED_SIGNIN],
  ['write', /^\/api\/node(\/|$)/, RUNNING],
  ['write', /^\/api\/public-profile/, PUBLIC],
  ['POST', /^\/api\/documents(\/[^/]+\/pages)?$/, UPLOADS],
  ['POST', /^\/api\/federation\/(lookup|requests|invites)$/, OUTSIDE],
  ['POST', /^\/api\/parties\/[^/]+\/invite$/, OUTSIDE],
  ['POST', /^\/api\/big-dipper\/connect$/, OUTSIDE],
  ['POST', /^\/api\/keys$/, AI],
  ['POST', /^\/(api\/oauth\/authorize|oauth\/register|oauth\/token)$/, AI],
  ['write', /^\/api\/owner$/, ACCOUNT],
];

export function demoGuard(app: FastifyInstance) {
  if (!DEMO) return;
  app.addHook('onRequest', async (req) => {
    if (SEED_KEY && req.headers['x-ld-demo-seed'] === SEED_KEY) return;
    const path = req.url.split('?')[0];
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    for (const [m, re, why] of OFF) {
      if ((m === req.method || (m === 'write' && write) || m === '*') && re.test(path)) throw new HttpError(403, 'off_in_demo', why);
    }
  });
}
