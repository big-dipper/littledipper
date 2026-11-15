# Little Dipper service kit

Lets an organisation take part in the Little Dipper network **without running a node**. A service has an identity,
offers capabilities (feedback, support, verification…), accepts connection requests from people's Little Dippers
and answers their signed calls. It holds no one's life and asks for no profile. Big Dipper is the first service.

- `protocol.ts`: identity, canonical JSON, Ed25519 signatures, signed envelopes, descriptors. Only `node:crypto`.
- `service.ts`: `createService({ identity, address, displayName, version, capabilities })` returns a framework-free
  `handle(method, path, body)`; `fastifyAdapter(app, service)` mounts it on Fastify.

Stateless by design: callers are checked by signature and by the key their own address publishes.

Licence: **Apache-2.0** (see LICENSE here), so businesses can build on it. The rest of Little Dipper is AGPL-3.0.
It must stay compatible with `server/src/crypto.ts` and `server/src/federation.ts`. (An automated check against a
real node is still to do; so far it has been tested end to end by hand, with Big Dipper.)
