# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html) with the pre-1.0
caveat that a minor bump may break things.

## [0.1.0] — 2026-08-12

The first tagged release. Everything below shipped between 2026-05-19 and
2026-08-11 across 212 commits; this entry describes the surface as a whole
rather than a diff, because there is no earlier tag to diff against.

**Installation is from source only.** There are no published images and no
`deploy/docker-compose.yml` yet — see [Known limitations](#known-limitations).

### Databases

- **PostgreSQL wire protocol** — Neon, Supabase and plain Postgres all connect
  through one adapter. TLS is required unless the caller
  writes `sslmode=disable`; an unqualified URL resolves to `sslmode=require`
  rather than silently falling back to plaintext.
- **MySQL / MariaDB**, with the identifier-quoting seam that stops `"orders"`
  being read as a string literal on a server without `ANSI_QUOTES`.
- **Turso / libSQL** and **Cloudflare D1**.
- **SSH tunnelling** for the two adapters that speak to a socket (Postgres,
  MySQL): host-key fetch and pinning, liveness detection, and a form that
  treats a blank secret as "keep the stored one" instead of "clear it".
- Per-connection **capability flags**, so a feature the adapter cannot perform
  is hidden rather than offered and then failed. Turso reports no
  `has_table_ddl`; D1 reports no `has_atomic_restore`.
- A server-side **statement timeout** and a **10,000-row cap** per query, so a
  runaway statement cannot hold the process or silently truncate the grid.

### Working with data

- **Query editor** with a result grid: column sort (documents, blobs and nulls
  each get their own rank bucket), CSV/TSV export, and a cell viewer for values
  too wide for their column.
- **Inline cell editing**. A table without a declared key stays read-only —
  there is no rowid fallback and no SQL parsing to guess provenance. A failed
  save keeps the staged edit.
- **Logical dump** (schema + data) and **restore**, including a plan step that
  reports what a restore file will do before it runs.
- **Schema browser** with `describe_table` depth — columns, types, keys —
  behind the capability flag rather than assumed.
- **Query history** as JSONL, schema v2, byte-compatible with the desktop
  client's format (ADR-0017 / ADR-0027). Exportable over
  `GET /history/export.jsonl`.

### AI assistance (optional)

- Two providers: **Anthropic** and **OpenAI**, both **streaming** from the
  first token, with cancel and a token/cost meter.
- Explain-this-query and suggest-a-query, with the connection's table list —
  and, where `has_describe_table` is true, the full schema — in the prompt.
- **Entirely opt-in.** With no provider configured, every `/ai` route answers
  `404 ai_disabled`, the panel renders a neutral notice, and no database path
  changes. Provider keys are read from the environment only; the API never
  accepts a key over HTTP.
- AI calls do **not** enter `history.jsonl`. That file records SQL the user ran.

### Interface

- Nuxt 4 single-page interface, **11 locales** (en, ja, de, es, fr, it, ko,
  pt-BR, ru, zh-CN, zh-TW), light/dark theme, resizable sidebar.
- **Installable as a PWA** with an offline page. Real-device acceptance on
  Android Chrome and iOS Safari is still outstanding — see below.

### Security

- **Loopback bind by default.** Binding `0.0.0.0` without setting
  `DBBOARD_API_SECRET` is refused at startup rather than warned about.
- **Bearer-token auth** on every route except `GET /health`.
- The browser bundle never sees the secret: the Nuxt server proxies to the API
  and injects the `Authorization` header server-side.
- `POST /query` bodies capped at 64 KiB, rejected before any handler runs.

### Cross-repo contract

- `docs/api-contract.md` is a byte-mirror of the shared subset published by the
  [`dbboard`](https://github.com/meta-taro/dbboard) desktop client, pinned at
  desktop `e064717` (v0.7.0).
- 24 HTTP routes across health, connections, drivers, tables, table-schema,
  capabilities, query, rows, dump, restore, history and ai.
- The **desktop-parity programme is complete** — rungs 0 through 9, every
  desktop ADR classified as a shared surface, a portable feature, or not
  portable. See
  [`.claude/parity-ledger.md`](./.claude/parity-ledger.md).

### Known limitations

- **No published Docker images and no `deploy/docker-compose.yml`.** From
  source is the only path that works today.
- **Single user.** There is no login, no per-user connection storage, and no
  OIDC. The bearer secret is shared by everyone who can reach the instance.
- **Connections are held in memory** and are lost when the API restarts.
- **The four real-device PWA acceptance items are unverified** (issue `0006`).
  The manifest, service worker and offline page are implemented; nobody has
  installed the app on a physical Android or iOS device and signed off.
- **Manual verification is partial.**
  [`docs/test-specs/001-v0-1-0-release.tsv`](./docs/test-specs/001-v0-1-0-release.tsv)
  is the record of what a human has and has not exercised against a running
  instance. Rows left `未実施` were not run, and this release does not claim
  them. The sheet is the authority on that question, not this list.
- **`main` is empty.** Development happens on `develop`.
- Two integration suites (`postgres-integration`, `mysql-integration`) require
  a Docker daemon and skip without one.

[0.1.0]: https://github.com/meta-taro/dbboard-web/releases/tag/v0.1.0
