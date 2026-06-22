# 0016 — API bearer-auth + localhost-default bind (security P0+P1)

- **Status:** open
- **Phase:** cross-cutting (security hardening between Phase 5 slice 1 and slice 2)
- **Opened:** 2026-06-22
- **Closed:** —
- **Branch:** none (direct-to-`develop`, per the Phase 4/5 slice pattern)
- **Depends on:** [`0003`](./0003-nestjs-http-surface.md) (the NestJS HTTP surface this slice gates), [`0009`](./0009-web-history-schema-mirror.md) (the NDJSON history egress that is the worst-blast-radius unauthenticated endpoint), [`0011`](./0011-frontend-connection-list.md) / [`0012`](./0012-frontend-sql-editor.md) / [`0015`](./0015-frontend-history-sidebar.md) (the three composables whose `apiBase` flips from `http://localhost:4000` to `/api/proxy`).
- **Blocks:** any deployment outside `localhost` (no LAN exposure, no PWA install over Wi-Fi, no reverse-proxy in front) is unsafe until this lands. Phase 5 slice 2 (schema browser) lands on top of this proxy path.

## Goal

Close the two CRITICAL findings from the 2026-06-22 device-loss security audit:

1. **Every API route is unauthenticated.** Any caller that can reach TCP port 4000 — including a LAN-adjacent attacker on a stolen-and-locked laptop that still has the API process alive — can `POST /connections` to register an attacker-controlled DB (SSRF/proxy), or `GET /history/export.jsonl` to siphon every executed SQL statement (which may carry inline PII / passwords / tokens).
2. **The API binds to `0.0.0.0` by default** (NestJS's `app.listen(port)` default), so LAN exposure is the default rather than opt-in.

After this slice, a fresh `pnpm dev` checkout behaves as follows:

- API listens on `127.0.0.1:4000` only — no LAN reachability without explicit opt-in.
- When `DBBOARD_BIND_HOST` is set to anything other than `127.0.0.1` / `localhost` (e.g. `0.0.0.0` for a self-hosted deployment), the API **refuses to start** unless `DBBOARD_API_SECRET` is also set. Auth and network exposure are linked: you cannot expose without authenticating.
- When `DBBOARD_API_SECRET` is set, every API request (except `GET /health`) must carry `Authorization: Bearer <secret>` or receive `401`.
- The Nuxt frontend reaches the API through a server-side proxy at `/api/proxy/*`. The secret lives in server-only runtime config (`NUXT_API_SECRET`), is injected at proxy time, and **never reaches the browser bundle**. Composables stay 1:1 with their previous shape — only the `apiBaseUrl` runtime default changes from `http://localhost:4000` to `/api/proxy`.

## What this is — and what it isn't

**Is:**

- A new `apps/api/src/presentation/middleware/bearer-auth.middleware.ts` — Express-style middleware. Reads `DBBOARD_API_SECRET` from env at module load (via `config.ts`), exempts `GET /health` unconditionally (so liveness probes do not need the secret), and otherwise compares `Authorization: Bearer <token>` against the configured secret with a constant-time comparison (`timingSafeEqual` on equal-length buffers). Missing or wrong token → `401 text/plain "Unauthorized"`. When the secret is unset, the middleware is a no-op (dev convenience) — but the bootstrap refuses to start if no-secret is combined with non-loopback bind.
- A small extension of `apps/api/src/bootstrap/config.ts` — adds two named exports:
  - `API_SECRET: string | undefined` (`process.env.DBBOARD_API_SECRET`, empty-string normalised to `undefined`).
  - `BIND_HOST: string` (`process.env.DBBOARD_BIND_HOST ?? "127.0.0.1"`).
  - `assertSafeBindConfig({ bindHost, apiSecret })` — throws if `bindHost` is non-loopback and `apiSecret` is undefined. Called from `main.ts` before `app.listen`.
- A `main.ts` change: `app.use(bearerAuth)` after `contentTypeGuard`; `app.listen(port, BIND_HOST)` instead of `app.listen(port)`; `assertSafeBindConfig` invoked first.
- A new `apps/web/server/api/proxy/[...path].ts` — Nitro event handler. Reconstructs the upstream URL from `event.context.params.path` + the original querystring, forwards method/body/headers (minus `host`/`connection`), injects `Authorization: Bearer <NUXT_API_SECRET>` when configured, returns the upstream response verbatim (status + body + content-type — including `application/x-ndjson` for the history export). Streams the body through unmodified.
- A `nuxt.config.ts` update — `runtimeConfig.apiSecret` (server-only, defaults to empty string, overridden by `NUXT_API_SECRET`), `runtimeConfig.apiUpstream` (server-only, defaults to `http://localhost:4000`, overridden by `NUXT_API_UPSTREAM`), and the public `apiBaseUrl` default flipped from `http://localhost:4000` to `/api/proxy`. Browser code only sees the relative path.
- A `.env.example` update — adds `DBBOARD_API_SECRET=`, `DBBOARD_BIND_HOST=127.0.0.1`, `NUXT_API_SECRET=`, `NUXT_API_UPSTREAM=http://localhost:4000`; flips `NUXT_PUBLIC_API_BASE_URL=/api/proxy`.
- A new `docs/deployment.md` — documents the threat model (device-loss / LAN-adjacent attacker), the loopback-default + auth-required-when-exposed posture, a worked Caddy reverse-proxy example with auto-HTTPS, the secret-rotation procedure (regenerate, update both env vars, restart both processes), and the device-level controls (FileVault / BitLocker / screen-lock + auto-wipe via MDM) that this codebase cannot replace.

**Isn't:**

- Per-user auth, sessions, JWTs, or OAuth. A single shared secret matches the self-hosted single-maintainer threat model. Multi-user auth is a separate decision that should wait until the project has more than one user.
- Encryption-at-rest for the in-memory `ConnectionRegistry`. The registry remains in process memory; the protection against a stolen-locked-device attacker dumping it requires OS full-disk encryption (called out in `docs/deployment.md`).
- CORS configuration. The Nuxt proxy means the browser only ever talks to its own origin, so CORS no longer matters for the production path. The existing `.env.example` `CORS_ORIGINS` comment is removed (it was never wired up in code anyway — see audit finding 1-A).
- TLS termination inside the API process. That stays an operator concern documented in `docs/deployment.md` (Caddy / nginx in front).
- Capability-gated history endpoint. `GET /history/export.jsonl` continues to be operator-only by virtue of the bearer secret. A future slice may add per-user history scoping when the multi-user auth question is opened.
- A change to `docs/api-contract.md`. The wire contract is unchanged — every existing route stays at its existing path / method / status. Only the transport-level auth header is added, which the contract already permits (it's silent on auth, and `401` is a generic HTTP response, not a contract-level envelope).
- A change to the desktop client. Web-only.

## Scope

1. **`apps/api/src/bootstrap/config.ts`** _(extended)_ — add `API_SECRET`, `BIND_HOST`, `assertSafeBindConfig` exports. Keep `MAX_BODY_BYTES` untouched.
2. **`apps/api/src/presentation/middleware/bearer-auth.middleware.ts`** _(new)_ — Express middleware factory `createBearerAuthMiddleware(secret: string | undefined)`. When `secret === undefined` the returned middleware is the identity `next()`. Otherwise:
   - `GET /health` → `next()` unconditionally (liveness exemption).
   - Otherwise, parse `Authorization` header. Must match `^Bearer (.+)$` (case-insensitive scheme). The provided token's length must equal the secret's length **before** running `crypto.timingSafeEqual` (which throws on unequal lengths) — if lengths differ, short-circuit to `401` without calling `timingSafeEqual`.
   - On any failure: `res.status(401).type("text/plain").send("Unauthorized")` and **do not** call `next()`.
3. **`apps/api/src/main.ts`** _(modified)_ — import `API_SECRET`, `BIND_HOST`, `assertSafeBindConfig`, `createBearerAuthMiddleware`. Call `assertSafeBindConfig` at the top of `bootstrap()`. Register `app.use(createBearerAuthMiddleware(API_SECRET))` after `contentTypeGuard`. Change `app.listen(port)` to `app.listen(port, BIND_HOST)`.
4. **`apps/web/server/api/proxy/[...path].ts`** _(new, Nitro)_ — `defineEventHandler` that:
   - Reads `useRuntimeConfig(event).apiSecret` and `.apiUpstream`.
   - Reconstructs the upstream path from `event.context.params!.path` (a string for `[...path]` per Nitro convention; join if it's an array) plus `event.node.req.url`'s query string.
   - Uses `$fetch.raw` to forward — passes method, body (`getRequestBody(event)` for non-GET), and a filtered header set (drops `host`, `connection`, `content-length`, but keeps `content-type` and `accept`). Adds `Authorization: Bearer ${apiSecret}` when the secret is non-empty.
   - Pipes upstream status + body + `content-type` back through `setResponseStatus` / `setResponseHeader` / `send`. For NDJSON, streams via `sendStream(event, response.body)` when `response.body` is a Node stream; otherwise sends the buffered body.
5. **`apps/web/nuxt.config.ts`** _(modified)_ — extend `runtimeConfig`:
   ```ts
   runtimeConfig: {
     apiSecret: "",
     apiUpstream: "http://localhost:4000",
     public: {
       apiBaseUrl: "/api/proxy",
     },
   },
   ```
6. **`apps/web/app/pwa/manifest`** — no change. The PWA `start_url` and `scope` are unaffected because the proxy lives on the same origin.
7. **`.env.example`** _(modified)_ — see "Is" section above. Remove the dead `CORS_ORIGINS` line.
8. **`docs/deployment.md`** _(new)_ — threat model summary, env-var reference, Caddy reverse-proxy example, secret-rotation runbook, list of device-level controls the operator must enable.
9. **Tests.**
   - `apps/api/src/bootstrap/config.spec.ts` _(new)_ — `BIND_HOST` defaults to `127.0.0.1`; respects `DBBOARD_BIND_HOST`. `API_SECRET` reads `DBBOARD_API_SECRET`; empty-string normalises to `undefined`. `assertSafeBindConfig`: `127.0.0.1` / `localhost` + no secret → OK; `0.0.0.0` + no secret → throws with a message naming the env var; `0.0.0.0` + secret → OK.
   - `apps/api/src/presentation/middleware/bearer-auth.middleware.spec.ts` _(new)_ — secret unset → middleware always calls `next()`. Secret set: `GET /health` always passes; `POST /connections` missing header → 401; wrong scheme → 401; wrong token (same length) → 401; wrong token (different length) → 401; correct `Bearer <secret>` → `next()`; case-insensitive scheme `bearer foo` → `next()`. The `timingSafeEqual` branch must not throw on length mismatch.
   - `apps/api/src/presentation/integration/auth.integration.spec.ts` _(new)_ — boot a `NestExpressApplication` via `createApp()` plus the bearer middleware with a known secret; supertest `GET /health` (200, no header), `GET /connections` (401 no header), `GET /connections` with header (200), `POST /connections` (401 no header), `GET /history/export.jsonl` (401 no header).
   - The existing controller specs are unaffected — they unit-test controllers directly without going through the middleware stack.
10. **`.claude/project-status.md`** + **`.claude/roadmap.md`** _(modified)_ — record issue 0016 landed; note the deployment posture now safe for opt-in LAN exposure with secret.

## Out of scope

- Multi-user auth, per-user sessions, OAuth, WebAuthn / passkeys. Deferred until multi-user becomes a real requirement.
- Encryption-at-rest for `InMemoryConnectionRegistry` / `InMemoryHistoryStore`. The defence here is OS full-disk encryption + screen-lock — documented in `docs/deployment.md`, not implemented in code.
- TLS termination inside Node. Operator responsibility (Caddy / nginx in front), documented.
- CORS configuration. The Nuxt proxy moves all traffic same-origin; CORS no longer applies.
- Rate limiting / brute-force lockout on the bearer endpoint. A 32-byte random secret has 2^256 entropy; brute force is not the threat. Adding rate limiting can be a follow-up if the secret ever shrinks.
- Service-worker cache hardening. The audit confirmed `runtimeCaching` is empty and `/history/export.jsonl` is cross-origin (`http://localhost:4000`) from the SW's perspective. After this slice the proxy makes those calls same-origin, but they're still HTTP `POST` / NDJSON streams that Workbox's default rules do not cache. Verified manually.
- happy-dom CRITICAL upgrade. That is a dev-deps bump deferred to a separate hygiene slice — it does not ship to production and is unrelated to this slice's runtime posture.

## Tasks

- [ ] Draft this issue and add a pointer from `.claude/project-status.md` "In progress".
- [ ] Write the failing `config.spec.ts` (RED).
- [ ] Write the failing `bearer-auth.middleware.spec.ts` (RED).
- [ ] Write the failing `auth.integration.spec.ts` (RED).
- [ ] Implement the middleware (GREEN).
- [ ] Extend `config.ts` and update `main.ts` (GREEN).
- [ ] Add the Nuxt server proxy handler (GREEN).
- [ ] Update `nuxt.config.ts` runtimeConfig (GREEN).
- [ ] Update `.env.example` (remove dead CORS_ORIGINS, add new vars, flip public base URL).
- [ ] Write `docs/deployment.md`.
- [ ] Update `.claude/project-status.md` + `.claude/roadmap.md`.
- [ ] Verification chain: `pnpm format:check && pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build`.

## Definition of Done

- [ ] `pnpm --filter @dbboard-web/api dev` with no env vars set listens only on `127.0.0.1:4000`. `curl http://<lan-ip>:4000/health` from a peer machine fails to connect.
- [ ] Setting `DBBOARD_BIND_HOST=0.0.0.0` without `DBBOARD_API_SECRET` crashes at startup with a message naming `DBBOARD_API_SECRET`.
- [ ] With `DBBOARD_API_SECRET=test-secret` set, `curl http://127.0.0.1:4000/connections` returns 401. With `-H "Authorization: Bearer test-secret"` it returns 200.
- [ ] `GET /health` returns 200 even without a header.
- [ ] `apps/web` running against the API (with `NUXT_API_SECRET=test-secret`) loads `/connections`, runs queries, and shows the history sidebar exactly as before — no functional regression.
- [ ] No file under `apps/web/app/` references `apiSecret` or `Authorization` directly. The browser bundle contains no occurrence of the secret string (`grep -r 'test-secret' apps/web/.output/public/` returns empty after `pnpm --filter @dbboard-web/web build`).
- [ ] `docs/api-contract.md` is untouched (auth is transport-level, not contract-level).
- [ ] All 11 locale files unchanged (no UI strings touched).
- [ ] `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` all green.
- [ ] `.claude/project-status.md` + `.claude/roadmap.md` updated in the same series of commits.

## References

- Security audit (2026-06-22): findings 1-A (no auth), 2-A (unauthenticated history export), 1-B (0.0.0.0 default), and the prioritised remediation list (P0 = shared-secret middleware, P1 = localhost-default bind).
- `apps/api/src/bootstrap/content-type.middleware.ts` — the precedent middleware pattern for Express-style request gates inside Nest.
- `apps/api/src/main.ts` — registers `app.use(...)` middlewares before `useGlobalFilters`.
- Nitro server routes: `https://nitro.unjs.io/guide/routing` (event handlers, `[...path]` catch-all, `$fetch.raw`, `sendStream`).
- `apps/web/app/composables/internal/http.ts` — the unchanged `apiFetch` indirection that now resolves against `/api/proxy` instead of `http://localhost:4000`.
- Threat model: laptop / phone left unattended on shared Wi-Fi; attacker on the same LAN; the device's full-disk encryption protects data-at-rest after reboot but not in-memory state of a running process.
