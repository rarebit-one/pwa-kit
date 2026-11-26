# @rarebit-one/pwa-kit

Small, dependency-free building blocks for a **private, installable PWA served through a
single serverless function**: the function is the sign-in gate, the API, and a proxy for the
site files kept in a private bucket.

- **build**: inline plain ES modules and CSS into one `index.html`, and emit `sw.js` and
  `manifest.webmanifest` for one `BUILD` stamp.
- **sw**: an offline-first service worker with install guards, plus a kill switch.
- **client**: service worker registration and update checks, a network-first feed cache with a
  self-wipe, and a logout that wipes the device.
- **publish**: upload the built site to object storage, page last.
- **serve**: response, path, content-type and cache helpers for the proxy.
- **session**: HMAC-signed tokens with scopes and epoch revocation, and cookie helpers.
- **oauth**: GitHub OAuth with a signed state cookie and org or allowlist access.
- **state**: last-writer-wins shared state.
- **mcp**: a stateless JSON-RPC-over-POST MCP transport, and scoped keys.
- **push**: Web Push on `node:crypto` (VAPID signing, RFC 8291 encryption, `sendPush`), with
  worker handlers and client subscribe helpers.

Node 18 or later. No runtime dependencies. MIT licensed.

```bash
npm install @rarebit-one/pwa-kit
npm test   # node --test
```

## Shape of an app

```
browser ──► function (gate) ──► bucket: site/index.html, site/sw.js, site/manifest.webmanifest, site/icons/*
                    │
                    └──► /api/* JSON feeds (bucket objects, read verbatim)
```

1. CI runs your build script (`buildSite`) and `publishSite` to put the site in the bucket.
2. The function verifies a session cookie on every request, then serves the site files with
   `serveFile` and the API as JSON. Unauthenticated API calls get a JSON 401, never a
   redirect, so the installed app can keep running from its cache and say "signed out".
3. The page registers the worker (`registerServiceWorker`) and reads feeds through
   `createFeedCache`.

## build

```js
import { buildSite } from '@rarebit-one/pwa-kit/build';

const { build } = buildSite({
  outDir: 'dist',
  title: 'Example Dashboard',
  shortName: 'Dashboard',
  themeColor: '#101014',
  backgroundColor: '#101014',
  colorScheme: 'dark',
  modules: ['src/util.mjs', 'src/app.js'],   // inlined in order, after the kit client
  css: ['src/style.css'],
  body: '<main id="main"></main><nav id="tabs"></nav>',
  iconsDir: 'icons',          // icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png
  cachePrefix: 'dash-shell',  // the worker owns caches named "dash-shell-*"
  apiPrefix: '/api/',         // left to the page
  defines: { API_VERSION: 1 },// extra top-level constants
  killSwitch: false,
});
```

Modules share one script scope: single-line `import` lines are dropped and `export` keywords
stripped. Use single-line imports, unique top-level names, and no `export default` or
`export { … }` lists (the build throws if it finds one). `BUILD` is a constant in scope.

`BUILD` is `YYYY-MM-DD-` plus the first 8 hex characters of a SHA-256 over every source. The
page includes the iOS and Android install meta tags, `<link rel="manifest"
crossorigin="use-credentials">` (the manifest sits behind the same cookie as the page), and a
hidden `#pwa-update` button ("Updated. Tap to reload.") for `showUpdateBanner`.

## sw

`serviceWorkerSource({ build, cachePrefix, apiPrefix, extras, push })` and `killSwitchSource()`.

The worker:

- installs only against a page that is `ok`, same-origin `basic`, not redirected, HTML, and
  contains its own `BUILD`. A sign-in page, an error, or a half-published build is refused, so
  a bad deploy can't become the cached shell;
- serves navigations to the scope root and `index.html` cache-first; other navigations (sign-in,
  sign-out) go to the network;
- serves the manifest and icons from its cache, and leaves `apiPrefix` requests to the page;
- deletes other `<cachePrefix>-*` caches on activate and nothing else, so keep the feed cache
  under a different name;
- answers `"build"` over a `MessageChannel`.

**Kill switch.** Build with `killSwitch: true` and publish. The new `sw.js` deletes every
cache for the origin and unregisters itself; pages load from the network until a normal build
is published again.

## client

Inlined into the page by the build. Every browser global can be injected, for tests.

```js
registerServiceWorker({ build: BUILD });            // update checks on foreground/online, ≤ every 10 min
const feeds = createFeedCache({ cacheName: 'dash-feeds-v1', wipeAfterDays: 14 });
const r = await feeds.get('/api/feed/today');
// r = { data, fetchedAt, stale, status, signedOut?, missing?, offline? }
logoutButton.onclick = () => logoutAndWipe('/logout');
```

`createFeedCache().get(url)` is network-first with a 3 s timeout:

| Response | Result |
|---|---|
| 2xx JSON | fresh data, saved; resets the "last signed-in sync" clock |
| 401 / 403 | `signedOut: true`, the saved copy, `stale: true` |
| 404, or 503 with a JSON body | `missing: true` (not published); the saved copy is dropped |
| timeout, network error, other status | the saved copy, `stale: true` |

**Self-wipe:** if the last successful signed-in fetch is older than `wipeAfterDays`, every saved
feed is deleted before anything is read. Saved feeds with no recorded sync are wiped too.

`logoutAndWipe(url)` deletes every Cache Storage cache, every IndexedDB database, local and
session storage, and the worker registrations, then navigates to `url`.

## publish

```js
import { publishSite } from '@rarebit-one/pwa-kit/publish';
await publishSite({ dir: 'dist', prefix: 'site/', put: (key, body, contentType) => s3Put(key, body, contentType) });
```

`index.html` goes last. Content types come from the file extension. `put` is yours: any client
for S3-compatible storage works. Keep the objects private.

## serve

```js
import { serveFile, json } from '@rarebit-one/pwa-kit/serve';
const res = await serveFile('icons/icon-192.png', { prefix: 'site/', load: (key, { binary }) => bucketGet(key, binary) });
return res ?? json(404, { error: 'not found' });
```

- `safeRelPath` refuses traversal and odd characters.
- `.webmanifest` goes out as `application/json` with a parsed object body. Some function
  gateways reject a string body under a JSON content type.
- `Cache-Control` is `no-cache` for the page, scripts, manifest and worker, and
  `private, max-age=86400` for images. Gated files are never `public`.
- Binary bodies are base64.

## session

```js
import { makeToken, readSessionCookie, cookie, logoutHeaders } from '@rarebit-one/pwa-kit/session';

const secret = () => process.env.SESSION_SECRET;
const token = makeToken('alice', { secret, ttlMs: 12 * 3600e3, epoch });
const setCookie = cookie('app_session', token, { maxAge: 12 * 3600 });
const claims = readSessionCookie(req.headers.cookie, 'app_session', { secret, epoch }); // null if invalid
const device = readSessionCookie(req.headers.cookie, 'app_device', { secret, scope: 'device', epoch });
return { statusCode: 302, headers: { location: '/login', ...logoutHeaders(['app_session', 'app_device']) } };
```

Tokens carry `{ u, e, s?, g? }`:

- **Scope (`s`):** a plain-session check (`scope: null`, the default) rejects every scoped
  token, and a scoped check accepts only its own scope.
- **Epoch (`g`):** pass the current epoch to reject older tokens, which revokes them all
  without rotating the secret. A missing `g` reads as 0.
- Signatures are compared in constant time. Minting with no secret throws, and verifying with
  no secret fails.

`logoutHeaders` clears the named cookies and adds `Clear-Site-Data: "cache", "storage",
"cookies"`. Its `set-cookie` value is an array (one header line per cookie, as OpenWhisk-style
web actions expect).

## oauth

```js
import { createGithubOAuth } from '@rarebit-one/pwa-kit/oauth';
const gh = createGithubOAuth({ secret, stateCookie: 'app_oauth_state', userAgent: 'example-app' });

// GET /api/auth/github
const s = gh.start(req);          // { redirect, setCookie } or { error }
// GET /api/auth/callback
const r = await gh.callback(req); // { ok: true, login, next } or { ok: false, error }
```

Config comes from env: `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
`GITHUB_ALLOWED_ORG`, `GITHUB_ALLOWED_USERS` (comma-separated) and `PUBLIC_ORIGIN`. A value of
`-` reads as unset. Access requires the allowlist or *active* org membership. Every error is a
refusal. `next` survives the round trip only if it is a same-origin absolute path. `fetch` is
injectable.

## state

```js
import { applyOps, emptyState } from '@rarebit-one/pwa-kit/state';
const { state, applied, rejected } = applyOps(current ?? emptyState(), ops, { by: 'alice', validate: (k, v) => (k.startsWith('note:') ? '' : 'unknown kind') });
```

`{ rev, items: { k: { v, at, by, p? } } }`. The newest `at` wins per key. Timestamps are
capped at now + 60 s. `v: null` leaves a tombstone. `p` holds the previous value.

## mcp

```js
import { createMcpServer, verifyMcpKey, ToolError } from '@rarebit-one/pwa-kit/mcp';

const server = createMcpServer({
  name: 'example', version: '1.0.0',
  tools: [{ name: 'summary', description: 'The summary feed', inputSchema: { type: 'object', properties: {} }, handler: async (args, ctx) => ctx.feed }],
});
// POST /mcp
const who = verifyMcpKey(req, { secret, scope: 'example-mcp', epoch, allowQuery: false });
if (!who) return json(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'key required' } });
const { statusCode, body } = await server.handlePost(req.rawBody, { who: who.u });
```

The server supports `initialize`, `ping`, `tools/list`, `tools/call`, and optionally
`resources/list|read|templates/list` and `prompts/list|get` (pass `prompts: [{ name, title?,
description?, arguments?, get(args, ctx) }]`; `get` returns `{ description?, messages }` or the
messages array). It also handles batches and notifications (202).
`mintMcpKey` issues a scoped key; prefer a Bearer header over `?key=`.

## push

Web Push without a dependency: VAPID (RFC 8292) ES256 signing and RFC 8291 `aes128gcm`
payload encryption on `node:crypto`. The encryption is tested against the RFC 8291 Appendix A
vector.

**Server.**

```js
import { generateVapidKeys, validSubscription, sendPush } from '@rarebit-one/pwa-kit/push';

generateVapidKeys(); // once: { publicKey, privateKey } base64url; keep the private key secret

const sub = validSubscription(body.subscription); // null unless https on a known push service
const r = await sendPush(sub, { title: 'Deploy failed', body: 'production', url: '/#estate', id: 'deploy:42' }, {
  vapid: { subject: 'mailto:ops@example.com', publicKey, privateKey },
  ttl: 3600, urgency: 'high', // topic: 'deploy' replaces an undelivered message
});
// r = { ok, status, gone } — drop the subscription when gone (404/410)
```

`validSubscription` only accepts endpoints on the browser push services (FCM, Mozilla, Apple,
WNS) by default, because the server POSTs to whatever endpoint is stored; pass
`{ endpointOk }` to widen it. Payloads are capped at 3993 bytes (one 4096-octet record).
`sendPush` never throws for a delivery failure: a network error comes back as `status: 0`.

**Worker.** Build with `push` to add the handlers:

```js
buildSite({ /* … */ push: { defaultTitle: 'Dashboard', badge: 'icons/badge-96.png', resubscribeUrl: '/api/push/subscribe' } });
```

- `push` shows `{ title, body, url, id | tag, requireInteraction, silent }` as a notification
  (the same `id` replaces an earlier one). A payload that isn't JSON is shown as the body.
- `notificationclick` focuses an open window and navigates it to a same-origin `url`, or opens
  a new window (an external `https:` link opens in the browser). Other schemes open the scope.
- With `resubscribeUrl`, `pushsubscriptionchange` re-subscribes and POSTs
  `{ subscription, replaces }` there with the session cookie.

**Page.** Inlined with the rest of the client:

```js
await pushStatus();   // { state: 'unsupported' | 'denied' | 'off' | 'subscribed', permission, endpoint? }
const r = await subscribePush({ vapidPublicKey }); // from a tap; { ok, subscription } or { ok: false, reason }
if (r.ok) await fetch('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: r.subscription }) });
const endpoint = await unsubscribePush();          // tell the server to forget it
```

`logoutAndWipe` unregisters the worker, which also ends its push subscription; the server
should forget the device's subscription at logout too.

## Releasing

Bump `version` in `package.json` on `main` (by PR), then push a matching tag:

```sh
git tag v0.2.1 && git push origin v0.2.1
```

`release.yml` checks the tag matches `package.json`, runs the tests and publishes to npm through
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, GitHub-hosted runner),
so no npm token is stored and every release carries a provenance attestation.

## Licence

MIT © Rarebit One
