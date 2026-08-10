# Deployment

`dbboard-web` is a self-hosted single-maintainer tool. This document covers
the network and authentication posture you need to know before running it
on anything other than `localhost` — and the device-level controls that
the codebase cannot replace.

## Threat model

The motivating scenario is **device loss** of a maintainer's laptop or
phone:

- A stolen-but-locked device: the API process may still be alive (lid
  closed, screen lock engaged). A LAN-adjacent attacker on the same
  Wi-Fi who can reach the API port has access until the OS suspends
  networking or the device is wiped.
- A stolen-and-unlocked device: the attacker has shell access. No
  network controls help; defense is OS full-disk encryption and the
  remote-wipe story from the device vendor (iCloud, Find My Device, MDM).
- A LAN-adjacent attacker on the maintainer's home or office Wi-Fi: an
  unauthenticated API on port 4000 acts as an open SSRF/proxy via
  `POST /connections`, and a single `GET /history/export.jsonl` siphons
  every executed SQL statement (which may carry inline PII, passwords,
  or tokens).

The codebase closes the LAN-adjacent risks via two coupled controls
(both shipped in issue 0016):

1. **Loopback bind by default.** `DBBOARD_BIND_HOST` defaults to
   `127.0.0.1`; the API is unreachable from any other machine on the
   LAN unless you opt in.
2. **Bearer secret required when exposed.** Setting `DBBOARD_BIND_HOST`
   to anything other than a loopback address (`127.0.0.1`, `localhost`,
   `::1`, `::ffff:127.0.0.1`) **without** also setting
   `DBBOARD_API_SECRET` causes the API to refuse to start. Auth and
   network exposure are linked: you cannot expose without authenticating.

The codebase does **not** close:

- Disk-resident data after device theft (the `InMemoryConnectionRegistry`
  and `InMemoryHistoryStore` are heap-only and evaporate on reboot, but
  swap files or hibernate state may briefly retain them; full-disk
  encryption is the only general defense).
- In-memory state on a running but locked device (no in-code control
  can revoke access to a live process; OS screen-lock + auto-suspend or
  remote wipe are the controls).
- TLS in transit (the API never speaks TLS itself; terminate at a
  reverse proxy — see the Caddy example below).

## Environment variables

See `.env.example` for the canonical list. Reference:

### API (`apps/api`)

| Variable                     | Default          | Notes                                                                                                    |
| ---------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| `PORT`                       | `4000`           | TCP port the API listens on.                                                                             |
| `DBBOARD_BIND_HOST`          | `127.0.0.1`      | IPv4/IPv6 address to bind. Loopback is safe; non-loopback requires `DBBOARD_API_SECRET`.                 |
| `DBBOARD_API_SECRET`         | _(unset)_        | Shared bearer secret. Required to enable LAN/Internet exposure. Generate with `openssl rand -base64 48`. |
| `DBBOARD_API_MAX_BODY_BYTES` | `65536` (64 KiB) | Per-request body cap. Pinned by the contract; do not commit non-default values.                          |
| `DATABASE_URL`               | _(unset)_        | Convenience env for local Postgres dev. The API does not auto-connect at boot.                           |

### Web (`apps/web`)

| Variable                   | Default                 | Notes                                                                                                                                                     |
| -------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NUXT_PUBLIC_API_BASE_URL` | `/api/proxy`            | Same-origin path the browser composables call. The Nuxt server proxy forwards from here to the upstream API. Browser bundle never sees the bearer secret. |
| `NUXT_API_UPSTREAM`        | `http://localhost:4000` | Server-only — where the Nuxt proxy reaches the NestJS API.                                                                                                |
| `NUXT_API_SECRET`          | _(unset)_               | Server-only — the bearer token the proxy injects on every upstream call. Mirror to `DBBOARD_API_SECRET`.                                                  |

## Localhost-only quickstart (default — no secret needed)

```sh
cp .env.example .env
pnpm install
pnpm dev
```

Both the API and the Nuxt frontend listen on `127.0.0.1`. The bearer
secret is unset, the middleware is a no-op, and `DBBOARD_BIND_HOST` is
the loopback default — the fail-fast check passes. Only processes on
your local machine can connect.

## LAN / Internet exposure (secret required)

1. Generate a secret: `openssl rand -base64 48`.
2. Set the same value in both env vars and bind to a non-loopback
   address:

   ```sh
   DBBOARD_BIND_HOST=0.0.0.0
   DBBOARD_API_SECRET=<paste>
   NUXT_API_SECRET=<same value>
   NUXT_API_UPSTREAM=http://127.0.0.1:4000   # or wherever the API listens
   ```

3. Put a TLS-terminating reverse proxy in front of Nuxt. Example Caddy:

   ```caddyfile
   dbboard.example.com {
     reverse_proxy 127.0.0.1:3000
   }
   ```

   Caddy provisions HTTPS automatically. The API stays bound to the
   loopback if you prefer (`DBBOARD_BIND_HOST=127.0.0.1`) — the Nuxt
   server is the only client that needs to reach it directly, and the
   proxy injects the bearer secret server-side.

4. Verify: `curl -i https://dbboard.example.com/api/proxy/health` →
   `200 {"status":"ok"}`. `curl -i https://dbboard.example.com/api/proxy/connections`
   should pass too — the proxy injects the secret transparently. Confirm
   the secret is **not** in the browser bundle:

   ```sh
   pnpm --filter @dbboard-web/web build
   grep -r "$NUXT_API_SECRET" apps/web/.output/public/
   # → no output
   ```

## Connecting to Aurora DSQL (IAM-token URLs)

Aurora DSQL speaks the Postgres wire protocol — registering a cluster
goes through the same `POST /connections` flow as any Postgres / Neon /
Supabase URL, and is served by the same `PostgresAdapter`. The only
deployment-time wrinkle is the password segment: Aurora DSQL does **not**
accept static passwords. The URL's password segment must carry a
short-lived **IAM authentication token** (~15 min lifetime).

Generate a token with the AWS CLI:

```sh
aws dsql generate-db-connect-auth-token \
  --hostname <cluster-id>.dsql.<region>.on.aws \
  --region <region>
```

…or programmatically with `@aws-sdk/dsql-signer` in Node, then build
the URL:

```
postgres://admin:<TOKEN>@<cluster-id>.dsql.<region>.on.aws:5432/postgres?sslmode=require
```

`sslmode=require` is mandatory — Aurora DSQL is TLS-only. Stale tokens
surface as the existing `connection` error category from
`POST /connections/:id/query`; the affordance is to regenerate the
token and re-register the connection (`DELETE /connections/:id` then
`POST /connections` with the refreshed URL). There is no built-in
auto-refresh — that is a deliberate Stage-1 deferral matching desktop
ADR-0021. A future "regenerate token" affordance (a server-side module
wrapping `@aws-sdk/dsql-signer`) is on the table but not shipped.

IAM setup (policy creation, cluster endpoint discovery, role
permissions) is out of scope for this doc — follow the AWS Aurora DSQL
documentation. The pattern of "user pre-generates a token, pastes the
URL into the app, re-pastes when it expires" is the entire web-side
contract.

See `.claude/decisions.md` "2026-06-24 — Aurora DSQL: no adapter
mirror needed (desktop ADR-0021)" for the cross-repo rationale.

## Connecting through an SSH bastion

A Postgres or MySQL server that is not reachable from this machine can be
reached through an SSH forward: the API opens a session to a bastion you can
reach, forwards a local port to the database, and points the driver at that
local port instead. Registering one goes through the same `POST /connections`
flow, with an `ssh` block beside the database fields; the connection form
grows the boxes for it when the selected driver supports one.

Which drivers those are is decided by whether the driver dials a `host:port`
pair at all. Postgres and MySQL do. Turso and Cloudflare D1 speak HTTP to a
provider endpoint, so there is no socket to redirect — the form offers no
bastion for them, and an `ssh` block sent for one is refused with a `404` and
`driver does not support an ssh tunnel: <driver>`.

### Verifying the bastion's host key is not optional

There is no "accept any key" setting, and none is planned. An SSH forward
whose far end is unverified is a forward to whoever answered, and the
credentials for your database go down it. Two ways to state the key are
accepted:

- a **fingerprint** — the `SHA256:…` field of what
  `ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -` prints. The digest is
  base64 with the padding stripped, exactly as OpenSSH renders it, and the
  comparison is case-sensitive; the `SHA256:` label itself is optional;
- a **`known_hosts` entry** — one or more lines in the format
  `~/.ssh/known_hosts` uses, which is what to paste when you already manage
  the host key alongside your other SSH clients.

The form's **Fetch** button dials the bastion and shows the key it presented.
That is a convenience for reading the key, not a substitute for verifying it:
the value it fills in came from whatever answered on that address. Compare it
against a fingerprint you obtained some other way — from the host's console,
from whoever provisioned it, from your existing `known_hosts` — before
saving. Nothing is fetched unless you press it.

### Where the key material goes

The private key is pasted into the form as PEM text and sent to the API in
the request body. There is deliberately **no** "path to a key file" field:
one would have the API process reading files off its own host on request,
which is a very different thing from the operator handing it a key.

The API holds the key in `InMemoryConnectionRegistry`, in heap, for as long
as the process lives. It is never written to disk by the application and does
not survive a restart — the same properties, and the same limits, as the
database passwords described under [Threat model](#threat-model): swap and
hibernate state may retain it, and full-disk encryption is the only general
defense.

Because the key crosses the browser-to-API boundary, the transport rules
matter more here than anywhere else in this document. The default loopback
bind keeps it on the machine. If you expose the API, terminate TLS at a
reverse proxy — an exposed API without TLS puts a private key on the wire in
clear text, and the bearer secret does nothing about that.

An encrypted key is supported: give the passphrase in the field beside it.
Password authentication to the bastion is supported too, as the alternative
to a key rather than in addition to one.

### Editing a connection that has a tunnel

The same rule the database password follows: a blank key or password box
means "keep the one you already gave me", not "remove it". Changing the
bastion's host or port without re-pasting the key is therefore an ordinary
edit. Unticking the tunnel checkbox removes it, and takes the stored key with
it.

### When the bastion goes away

A forward whose session has died does not fail loudly on its own — the local
listener keeps accepting, and a query against it hangs. So a connection that
has been idle for more than 30 seconds is probed with `SELECT 1` before the
next query is sent, and a connection that fails the probe is rebuilt: the
tunnel is re-dialled and the driver reconnected, from the credentials held in
the adapter. A caller sees a slower first query rather than a hang. If the
bastion is genuinely unreachable, the rebuild fails and the query returns the
usual `connection` error.

## Optional: Anthropic AI provider

`dbboard-web` ships an optional AI provider seam (Phase 6 Slices 1–2,
issues 0019 and 0020). The defaults keep AI fully disabled — every
database flow works without a key and no AI route is documented on the
shared HTTP contract. Enable it only when you want SQL-explain or
NL→SQL features exposed to the Nuxt UI.

Two environment variables drive the seam:

| Variable                    | Default             | Notes                                                                                                                                                        |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DBBOARD_ANTHROPIC_API_KEY` | _(unset)_           | Absence is the disable switch. When unset, the `AI_PROVIDER` DI token resolves to `undefined` and consumers must mark the injection `@Optional()`.           |
| `DBBOARD_ANTHROPIC_MODEL`   | `claude-sonnet-4-6` | Model id forwarded to `Anthropic#messages.create`. The Anthropic API may resolve an alias (`claude-sonnet-4-6`) to a concrete dated version on the response. |

Variable names mirror the desktop client's `DBBOARD_ANTHROPIC_*` env
block so a single `.env` covers both clients. The desktop side uses the
same key for the same purpose — there is no per-client key rotation to
manage.

HTTP routes (Slice 2):

| Route              | Body                                        | Success               | Disabled          | Upstream failure  |
| ------------------ | ------------------------------------------- | --------------------- | ----------------- | ----------------- |
| `POST /ai/explain` | `{ "sql": "...", "dialect"?: "postgres" }`  | `200 { text, model }` | `404 ai_disabled` | `502 ai_provider` |
| `POST /ai/suggest` | `{ "prompt": "...", "dialect"?: "sqlite" }` | `200 { text, model }` | `404 ai_disabled` | `502 ai_provider` |

`POST /ai/suggest` also accepts an optional `schema` — the tables the
caller introspected, as `[{ "schema": "public" \| null, "name": "users" }]`
(desktop ADR-0028 Decision 8). They are rendered ahead of the dialect and
the request so the model names tables that exist.

Omitting the field and sending `[]` are different requests, and the
prompt says something different for each: omitted means the caller never
looked and the prompt mentions tables not at all; `[]` means it looked
and there are none, which is stated, because silence lets the model
invent a plausible table and "there are none" does not. A malformed
entry — no `name`, or a `schema` that is neither a string nor null — is a
`422`, not a silently dropped field. No separate size cap: the 64 KiB
body limit already bounds the list.

Both routes sit behind the same bearer-auth middleware as the rest of
the API (no per-route exemption — `GET /health` remains the only
unauthenticated path). The two new error categories (`ai_disabled` and
`ai_provider`) are web-only and intentionally absent from
`docs/api-contract.md`; the envelope shape (`{ error: { category,
message } }`) matches the existing DB-side categories for client
consistency.

Privacy and contract notes:

- **The `/ai/*` routes are web-only.** `docs/api-contract.md` (the
  cross-repo shared subset) stays silent on AI by design (desktop
  ADR-0023 Decision 3 — in-process wiring only). Web exposes a thin
  HTTP wrapper so the browser can call into the same provider.
- **AI calls _are_ recorded in the history log, as of 2026-08-04.**
  This reverses the earlier posture. Until the v:2 schema bump they
  were not, because recording them would have forced a `v:1 → v:2`
  bump ahead of cross-repo coordination; that coordination happened
  (desktop ADR-0027, brief 0008) and web mirrored it in ticket
  [`0023`](../.claude/issues/0023-history-v2-mirror.md).

  An AI record carries `kind: "ai"` and holds the prompt and the
  response **verbatim in content** — no redaction (desktop ADR-0027
  Decision 8). Both fields are capped at 64 KiB of UTF-8 at the write
  boundary (Decision 10), which is a size limit, not a privacy one.
  `GET /history/export.jsonl` therefore returns prompt text to any
  caller holding the bearer token. Treat the export route as carrying
  the same sensitivity as the AI conversation itself.

  Recording happens in the use cases (`explain-sql` / `suggest-sql`,
  through the shared `record-ai-call.ts`), not in an interceptor:
  `HistoryRecordingInterceptor` reads `req.body.sql` and maps a
  `QueryResult`, neither of which an AI call has.

- **No persisted key storage.** The key lives in env only — there is
  no settings UI or OS keychain integration.

Toggle disabled at any time by clearing `DBBOARD_ANTHROPIC_API_KEY` and
restarting the API process; the factory short-circuits to `undefined`
on the next boot and both routes return `404 ai_disabled` until the
key is restored.

## Secret rotation

1. Generate a new value: `openssl rand -base64 48`.
2. Update `DBBOARD_API_SECRET` and `NUXT_API_SECRET` to the new value
   in your `.env` (or your process manager's env).
3. Restart both processes. The Nuxt proxy and the NestJS middleware
   pick up the new value on next boot; there is no warmup window where
   both old and new are accepted (which is fine for a single-maintainer
   tool — the rotation window is the time it takes the operator to
   restart, measured in seconds).

If you regenerate the secret without also restarting the corresponding
side, the proxy will start failing with `401` from NestJS, surfaced to
the browser as the upstream error envelope. There is no cached fallback.

## Device-level controls the codebase cannot replace

| Control                       | What it protects                                                               | How                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Full-disk encryption          | Data at rest after the device is powered off (swap, hibernate, raw filesystem) | FileVault (macOS), BitLocker (Windows), LUKS (Linux), hardware encryption (iOS / Android)                               |
| Screen lock + short auto-lock | In-memory state on a running but unattended device                             | OS settings; pair with auto-suspend so the API process is paused                                                        |
| Remote wipe                   | A device that has already been stolen                                          | iCloud Find My Mac, Find My Device (Android), MDM (work devices); terminates the process and destroys in-memory history |
| Network egress filtering      | A malicious package or a compromised user agent reaching out                   | Operating system firewall; Little Snitch / `pf` on macOS; Windows Defender Firewall                                     |

None of these are configurable from inside `dbboard-web`. Make sure they
are enabled on every device you install the PWA on.

## What the browser bundle never sees

After issue 0016 the browser only ever calls same-origin paths under
`/api/proxy/`. The bearer secret lives in `runtimeConfig.apiSecret`
(server-only — no `public` prefix), is read inside the Nitro proxy
handler at request time, and is injected into the outgoing
`Authorization` header. Nuxt's runtime config split guarantees that
`runtimeConfig.public.*` is the only key surfaced to the client bundle,
and the proxy handler is server-side code that is bundled separately
into `.output/server/`.

You can verify by inspecting the build output:

```sh
pnpm --filter @dbboard-web/web build
grep -r "apiSecret" apps/web/.output/public/   # empty
grep -r "Authorization" apps/web/.output/public/ # empty unless a 3rd-party module surfaces it
```

The `apps/web/.output/server/` bundle does carry the secret string at
runtime through the env, which is appropriate.
