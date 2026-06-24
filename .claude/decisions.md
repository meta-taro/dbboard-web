# Technical decisions

Append-only log of significant technical decisions. Each entry: date, decision, context, alternatives considered, rationale.

---

## 2026-05-19 — Frontend framework: Nuxt

**Context.** A browser-based counterpart to the `dbboard` desktop client is needed.

**Alternatives.** Next.js, SvelteKit, Remix.

**Decision.** Nuxt (Vue 3, TypeScript).

**Rationale.** Vue's reactivity model fits the live-query / live-result use case well, Nuxt provides a mature SSR + Nitro server story, and the ecosystem covers auto-imports, route handlers, and server middleware out of the box.

---

## 2026-05-19 — Backend framework: NestJS

**Context.** An API layer separating the frontend from databases.

**Alternatives.** Fastify (vanilla), Hono, Express, embedding the API into Nuxt's Nitro server.

**Decision.** NestJS.

**Rationale.** Module boundaries map cleanly to the layered architecture rule. Built-in dependency injection makes the AI provider plug-in pattern straightforward.

---

## 2026-05-19 — Package manager: pnpm

**Context.** Supply-chain and dependency-correctness concerns make `npm` undesirable for this project.

**Decision.** pnpm only; `npm` and `yarn` are forbidden.

**Rationale.** Strict dependency resolution avoids phantom imports, `onlyBuiltDependencies` allowlists install scripts, `minimumReleaseAge` quarantines freshly published versions, and the `packageManager` field plus `corepack` give reproducible installs.

---

## 2026-05-19 — Language for repository artifacts: English

**Context.** Open-source project intended for an external audience.

**Decision.** All files in the repository (markdown, code comments, commit messages, PR text) are written in English. Direct maintainer↔assistant dialogue may remain in Japanese.

**Rationale.** Maximizes contributor reach without making maintenance harder for the primary maintainer, who prefers Japanese for personal channels.

---

## 2026-05-19 — Relationship with `dbboard` desktop client

**Context.** `dbboard-web` and the desktop client `dbboard` (https://github.com/meta-taro/dbboard) are developed by the same maintainer. The desktop client is a **native Rust GUI** application with its own **local Rust API layer**. The two clients do **not** communicate with each other at runtime — they are independent applications that happen to expose the same conceptual API surface to their own UI layer.

**Decision.**

- The two repositories are **fully independent applications**, not two faces of one product:
  - `dbboard-web`: Nuxt UI + NestJS API + databases (this repo).
  - `dbboard`: native Rust GUI + local Rust API + databases.
- **No runtime coupling.** Neither client calls the other's API; neither shares process, build, or release pipelines. A user can install either or both without dependencies between them.
- **What is shared:** the **API contract** only — connection definition shape, query request and response envelopes, error category codes, schema metadata shape, and AI provider request and response shapes. The contract is described in human-readable form so each repository can translate it into idiomatic types for its language (TypeScript DTOs here, `serde` structs there).
- **What is NOT shared:** controllers, services, DB drivers, UI components, build tooling, dependency lockfiles, or any source code.
- **User-data interop.** Export and import formats for connections and query history use the same JSON shape on both sides, so a user can move state between desktop and web. This is the only artifact the two clients exchange.
- **Pace policy.** Maintainer attention is split between the two repos. Phases on each side are sized to be completable in a single focused session, and changes never leave either repo in a broken state. Either side may move ahead on any phase without waiting for the other.
- **Contract evolution.** When the shared API surface changes, the side that needs the change updates the contract first (in human-readable docs), then both sides adopt it on their own schedule. Implementation duplication is permanent and acceptable — the two stacks are too different to share code.

**Rationale.** A native Rust GUI cannot meaningfully reuse a NestJS server or TypeScript UI components, so attempting to share implementation would be pure cost. Keeping the contract aligned by convention captures the only real coupling (consistent vocabulary and exportable user data) without forcing either codebase to compromise on language idioms or tooling.

**Cross-references.** This decision is mirrored on the desktop side as `dbboard/docs/decisions.md` ADR-0004 (revised) and ADR-0006 (local axum HTTP backend, loopback, auto-port).

---

## 2026-05-19 — Initial sequencing: `dbboard` Phase 1 runs before `dbboard-web` Phase 1

**Context.** Both repos are at Phase 0. Either side may proceed independently per the coordination policy above, but the maintainer's attention is split. We need an explicit "what to do this week" without rewriting the coordination policy.

**Decision.**

- `dbboard` (desktop) Phase 1 — Turso vertical slice — runs first.
- `dbboard-web` Phase 1 — monorepo scaffold — is staged behind it.
- Once the desktop slice is working end-to-end, the API contract is drafted (canonical form to be decided) and `dbboard-web` Phase 1 starts.

**Rationale.** `dbboard-web` Phase 1 is mostly scaffolding (pnpm workspace, empty Nuxt + NestJS apps). Doing it first would not move the actual problem forward, and any contract assumptions it bakes in would have to be revised once the desktop slice reveals real shapes. Letting the desktop slice ship first means the web scaffold can lock in a contract that already runs somewhere.

**Reversibility.** Cheap to reverse — neither repo has implementation code that depends on the sequence.

---

## 2026-05-25 — Adopt `dbboard` HTTP API contract as Phase 1 input

**Context.** The desktop client `dbboard` closed Phase 1 at workspace `0.1.0` and shipped a stable HTTP contract documented in `dbboard/docs/api-contract.md`. Per their `ADR-0011`, `dbboard@1.0.0` is gated on interop with `dbboard-web`, which puts the contract mirror on the critical path here. Per their `ADR-0004` (the relationship policy mirrored as the second decision in this log), contract evolution flows through the desktop side first, then mirrors here.

**Decision.**

- The contract at `dbboard@89b7c70:docs/api-contract.md` (last touched at `3f114e4`, "publish the 10,000-row per-query cap") is mirrored into this repo as [`docs/api-contract.md`](../docs/api-contract.md) and becomes the binding target for Phase 1 implementation.
- The mirror is content-identical (line endings normalized to LF to match repo convention).
- Desktop `ADR-0004`, `ADR-0006` (loopback HTTP backend), `ADR-0009` (canonical contract), and `ADR-0011` (SemVer + interop gate) are the canonical references — this repo does not re-derive them.
- Issue [`0001`](./issues/0001-web-contract-mirror.md) tracks the mirror itself and lists follow-up issues for implementation (`0002` scaffold, `0003` HTTP surface, `0004` Postgres adapter, `0005` row cap + conformance tests).

**Explicitly out of scope.** Desktop `ADR-0012` (capability model: `GET /capabilities`, `capability` error category, `/views/...` etc. prefixes) is **not yet implemented on the desktop**. It is purely additive to the current three endpoints, so a mirror built today is forward-compatible; the capability surface will be re-mirrored after the desktop ships it.

**Rationale.** Mirroring now is forward-compatible (capabilities are additive), it unblocks `dbboard@1.0.0`, and it gives the upcoming NestJS scaffold a fixed contract instead of a moving target. Holding off would have meant chasing the desktop's still-shifting contract through Phases 1.5 / 1.6 / 1.7; that phase is now over.

**How contract changes flow.** Per `ADR-0004`, the desktop side drafts the change in `dbboard/docs/api-contract.md` first. When that lands, this repo re-runs the mirror against the new snapshot. Web-side ambiguities discovered during implementation are filed as desktop-side ADR questions — never resolved unilaterally here.

**Reversibility.** The mirror is a documentation artifact. Reverting it costs only the documentation churn; no code has been written against it yet.

---

## 2026-05-25 — Branch policy: `feature/<slug>` → PR → `develop`

**Context.** The repo currently has only docs commits, all landed directly on `develop`. Phase 1 starts shipping real code, and the maintainer also runs the `dbboard` desktop repo, which already follows a `feature/<slug>` → PR → `develop` workflow per `dbboard@ADR-0005`. Aligning the two repos reduces context-switching cost.

**Decision.**

- `develop` is the default branch and the integration target for ongoing work.
- All changes from Phase 1 onward go through a `feature/<slug>` branch and a pull request into `develop`.
- The pull request is the review gate: even for solo work, it forces a final pass over the diff and a clean commit history.
- `main` is reserved for releases. The first `main`-bound merge happens when `0.1.0` is tagged (see "Versioning" — to be added when the first release is cut).
- Conventional Commits remain mandatory (`AI_AGENT_RULES.md` §6).
- Pre-merge: lint, typecheck, and tests must be green (`AI_AGENT_RULES.md` §5). CI will enforce this once it lands; until then the pre-push hook does.
- AI agents author commits on feature branches but **do not push or open PRs** — the human pushes the branch and opens the PR (`AI_AGENT_RULES.md` §6).
- Docs-only changes may still land directly on `develop` when they are part of closing out a previous handoff (e.g. the 2026-05-25 contract-mirror commits on `develop`). From Phase 1 implementation onward this exception ends.

**Rationale.** The desktop side codified the same policy in ADR-0005 for the same reasons: cleaner history, easier to bisect, makes future CI / contributor onboarding straightforward without a second policy migration. Solo PR overhead is small (a few seconds) and the discipline is worth it.

**Reversibility.** Cheap to reverse; the policy is procedural and changing it does not affect any committed artifact.

---

## 2026-05-25 — Distribution model: self-host OSS, no maintainer-run SaaS

**Context.** The desktop client (`dbboard`) and `dbboard-web` are both OSS by the same maintainer. The desktop already covers "single-user, local laptop, native install". `dbboard-web` needs its own clear reason to exist, and a distribution model that matches the maintainer's intent (CLAUDE.md: "Not a production SaaS").

**Decision.**

- **Self-host only.** Users run their own instance of `dbboard-web`. The maintainer does not operate a managed SaaS, hosted demo, or any user-facing endpoint of this code. This is stated in the README.
- **Primary distribution**: a Docker Compose stack (NestJS API + Nuxt web, optional reverse proxy) and pre-built images on the GitHub Container Registry under `ghcr.io/meta-taro/dbboard-web-*`. Users run `docker compose up` and the app is at `http://localhost:<port>`.
- **Secondary distribution**: from-source install via `pnpm install && pnpm build && pnpm start`, for contributors and homelab users who prefer no containers.
- **Optional convenience**: one-click deploy templates for Fly.io / Railway / Vercel + Render / etc., as community-maintained add-ons in `deploy/` or a separate repo. These are not the primary supported path.
- **Authentication**: no auth by default — appropriate for single-user behind a reverse proxy or trusted network. An optional auth layer (basic / OIDC) gated behind an environment flag is a later phase.
- **No telemetry, no phone-home.** The service is fully usable offline (modulo whatever the configured DB requires).
- **Differentiation from desktop:**
  - Desktop = local-only native install, single-user, fastest path, no server.
  - Web = browser UI + server, runs anywhere from laptop to homelab to VPS, accessible from multiple devices, prepares ground for future team / multi-user use.
- **Branding parity** with the desktop is intentional: same name, same JSON shapes (export/import), aligned HTTP contract. They are siblings, not a product line.

**Rationale.** Operating a SaaS is open-ended: it implies SLA, auth, billing, multi-tenancy, abuse handling, GDPR, paging. None of those align with "Not a production SaaS." Self-host keeps the project a tool, not a service. Pre-built Docker images make self-hosting a five-minute task — the friction is low enough that "I want a hosted version" rarely outweighs "I can run this myself."

**Authentication is deferred** because the primary deployment shape (single-user behind a reverse proxy) does not need it, and bolting it on later behind an env flag is straightforward. Shipping unauth defaults that match desktop semantics keeps the two clients conceptually identical.

**Reversibility.** Reversible. If demand for a hosted version surfaces, the same OSS code can be deployed as a managed service later; nothing here precludes that. The decision is about what the maintainer commits to operating, not what the code allows.

## 2026-06-03 — Multi-language UI support (Stage 1, 11 locales)

**Context.** The desktop sibling shipped Stage 1 multilingual UI on the same day (desktop ADR-0015, commits `6a804fe` / `b00c627` / `f6f5107`), covering English, Japanese, Korean, both Chinese variants, and the major EU + Brazilian + Russian locales. The maintainer asked for a matching surface on `dbboard-web` so the two clients stay branding-parallel — a user who switches from desktop to web should not lose their language.

The HTTP contract (`docs/api-contract.md`) is shared with desktop. Translating error envelope text on the wire would create contract drift, so this decision is strictly a presentation concern on `apps/web`. The desktop ADR-0015 makes the same scope cut and explicitly says "translation drift between desktop and web is acceptable: each surface owns its own .ftl (or web equivalent)."

**Decision.**

- **Locales (Stage 1, 11 total).** Mirror desktop ADR-0015 exactly: `en` / `ja` / `ko` / `zh-CN` / `zh-TW` / `de` / `fr` / `es` / `pt-BR` / `ru` / `it`. Arabic (`ar`) and Hindi (`hi`) are deferred to Stage 2 to stay drift-aligned with desktop — even though browsers handle RTL and Devanagari shaping for free, shipping them on web only would let the two clients diverge in a way that is hard to undo later. Stage 2 lifts both sides together.
- **Framework: `@nuxtjs/i18n` (`vue-i18n` underneath).** The official Nuxt module, mature, SSR-aware, supports lazy locale loading, browser detection, and a typed `useI18n()`. The desktop chose `fluent-rs` + `i18n-embed` for ICU MessageFormat coverage; `@nuxtjs/i18n` covers the same surface (interpolation, plurals, named formatters) without requiring a custom Fluent loader on Vue side.
- **Resource format: JSON under `apps/web/i18n/locales/<code>.json`.** Desktop ADR-0015 §Consequences explicitly green-lit per-surface format divergence; Vue I18n's native JSON is far less surprising than wedging Fluent into the Vue ecosystem. Nested keys, ICU-style placeholders (`{count}`, `{rows}`) for parameterised messages.
- **Locale resolution priority (highest first), mirroring desktop's `DBBOARD_LANG > sys-locale > en`:**
  1. **`?lang=<bcp47>` query parameter** — the operator override. Implemented in `app/middleware/locale-query.global.ts` so any navigation can re-pin the locale (screenshot tests, demo URLs, language-locked shareable links). This is the web analogue of the desktop env var: a single authoritative knob external to the user's preferences.
  2. **`dbboard_lang` cookie** — the user's persistent choice, written by `@nuxtjs/i18n`'s `detectBrowserLanguage` config the first time a locale is set (either via the URL override above, the `LocaleSwitcher`, or an `Accept-Language` resolution).
  3. **`Accept-Language` header** — the browser-supplied preference list, walked against `SUPPORTED_LOCALE_CODES`.
  4. **Hard-coded fallback to `en`** — `en` is the source of truth for every key (parity test).
- **Font strategy: no app-level code.** Desktop has to register OS-system CJK fonts at startup because egui ships Latin-only glyphs. Browsers solve this themselves via `<html lang>` + the platform font stack. The app sets `htmlAttrs.lang` reactively from the active locale so the platform picks up the right shaping; that is the entire fix.
- **Scope: `apps/web` only.** The NestJS API (`apps/api`) returns the contract error envelope (`{ error: { category, message } }`) verbatim from the database adapter, in English. Translating the `message` body would break ADR-0009 on the desktop side (same rule). The UI's `error.prefix.*` keys translate the _category_ label and prefix it to the English body — same boundary desktop draws between contract and presentation.
- **Override is authoritative, not additive.** Setting `?lang=ja` does not also append the user's `Accept-Language` chain — once an explicit override is supplied, downstream resolution stops. This matches the desktop rule that "an explicit DBBOARD_LANG is not also followed by OS locale fallback" (desktop ADR-0015 commit message): otherwise the override would silently stop being one the moment its tag is not a shipped locale.

**Consequences.**

- New runtime dependency family on the web: `@nuxtjs/i18n@^10.4.0` pulls `@intlify/core`, `vue-i18n@^11`, `@intlify/h3`, and a handful of build-time helpers. All MIT licensed; no new install / postinstall scripts (the existing `allowBuilds` list is unchanged). Verified against `minimumReleaseAge: 1440` (10.4.0 published 2026-05-21).
- Bundle size growth: ~80 KB gzipped for the runtime plus the eleven lazily-loaded JSON files (each ≤ 2 KB). Cold load fetches only the active locale; switching pulls one more JSON.
- The `LocaleSwitcher` component reads / writes the `dbboard_lang` cookie via `setLocale()`. The cookie is `Secure` in production and is not sent cross-origin — same posture as `@nuxtjs/i18n`'s defaults.
- HTTP contract unchanged → **no handback to desktop is required.** Translation drift between the two clients is acceptable per ADR-0009 + desktop ADR-0015.
- The roadmap moves i18n into **Phase 2.5**, running in parallel with Phase 2 backend implementation (`0003` / `0004` / `0005`). The two tracks do not touch the same files. This matches the desktop sequencing where Phase 2.5 ran parallel to the remaining Phase 2 connection-management work.
- Stage 2 (RTL Arabic + Devanagari Hindi) is a future decision recorded against both clients at once. Browsers can render them today, but shipping them on web only would create a drift the user has explicitly chosen to avoid by asking for a mirror.

**Reversibility.** Reversible at low cost. Removing the module is one `pnpm remove` + reverting the wired `nuxt.config.ts` block + replacing `t("...")` calls with literals; the JSON files would stay as a reference even if disabled. Reversing the framework choice (e.g., moving to FormatJS later) means rewriting the locale files into a different syntax but keeping the same key surface.

---

## 2026-06-05 — Query-history persistence mirrors desktop ADR-0017 (web Stage 2)

**Context.** Desktop closed ADR-0017 Stage 2 with a per-record JSON shape for `history.jsonl` (`dbboard@62ed834:docs/decisions.md`, reference impl `dbboard@72cb165:crates/dbboard-ui/src/history.rs`, closeout `dbboard@ae86627`). The cross-repo brief at [`./handoff/2026-06-04-history-schema-mirror-incoming.md`](./handoff/2026-06-04-history-schema-mirror-incoming.md) requested the same record shape on web so that `cat dbboard-history.jsonl | curl --data-binary @-` round-trips and so the two clients keep "same brand → same log record format" parity. Issue [`./issues/0009-web-history-schema-mirror.md`](./issues/0009-web-history-schema-mirror.md) tracks implementation; this ADR captures the web-side I/O decisions that the brief deliberately left open.

**Decision.**

- **Schema is desktop ADR-0017 §2 verbatim.** The Zod schema at `apps/api/src/domain/history-record.ts` mirrors the desktop ADR field-for-field (`v: 1`, `ts` as RFC 3339 / UTC / ms via `new Date().toISOString()`, `conn`, `actor`, `sql`, `status ∈ {ok, error}`, `duration_ms` int ≥ 0, `rows` vs `rows_affected` mutually exclusive, error envelope `{ category, message }` with category ∈ desktop's five-value taxonomy). Desktop ADR-0017 is the single source of truth — this ADR does not restate the schema, only the points where web has to make a choice that desktop does not.
- **Storage default is in-memory.** `apps/api/src/infrastructure/in-memory-history-store.ts` implements the `HistoryStore` port behind the `HISTORY_STORE` symbol provider (parallel to `DATABASE_ADAPTER` / `CONNECTION_REGISTRY`). It is the default in `AppModule` and the only adapter shipped in Phase 2. A Postgres-backed adapter (jsonb column, `payload->>'v' = '1'` partial index, sort/filter via `payload->>'ts'`) is a follow-up ticket scheduled after Aurora DSQL lands; the brief's `jsonb` recommendation is preserved by keeping the in-process record shape identical to what the future Postgres adapter will write.
- **Write path is a NestJS interceptor**, not buried in each controller. `HistoryRecordingInterceptor` is applied via `@UseInterceptors` on `QueryController`, captures wall-clock at intercept entry, and dispatches `RecordHistory.recordSuccess` (success path via `tap`) or `recordError` (error path via `catchError`). The recorder's throws are swallowed inside the interceptor so a buggy mapper never fails a user-facing request, and the original error is re-thrown untouched so `ContractErrorFilter` still owns the HTTP envelope.
- **`conn` for connection-less `/query` uses sentinel `"_default"`.** ADR-0017 §2 requires `conn` to be a non-empty string. `POST /query` (no `:id`) routes through the bootstrap `DATABASE_ADAPTER` and has no registered connection id, so the recorder logs `conn = "_default"`. `POST /connections/:id/query` uses the path parameter verbatim. The sentinel is **not** part of `docs/api-contract.md` — it appears only in the history record.
- **`actor` is `null` until auth lands.** Desktop emits `null` because it is a local-only single-user app. Web has no auth layer yet (per the self-host ADR), so the recorder hardcodes `null`. A follow-up ticket flips `actor` to the authenticated subject (user id / email / opaque sub) once the optional auth layer ships. The empty string is never emitted (Zod refuses to parse it).
- **`error.category` follows the existing `CategorizedError` taxonomy.** `mapError()` in `RecordHistory` returns its category directly for `CategorizedError`; an uncategorized `Error` falls back to `"query"`, never a synthesized "internal" category. This guarantees the test "no web-internal category leaks" from the ticket DoD.
- **Egress is `GET /history/export.jsonl`, `application/x-ndjson`.** `HistoryController.export()` streams one record per line via `ExportHistory.stream()` (yields `${JSON.stringify(record)}\n`). The route is **operator-only** and intentionally **NOT** documented in `docs/api-contract.md` per desktop ADR-0017 §8 — history is operator egress, not a wire contract. The `InMemoryHistoryStore.iterate()` snapshot-on-iterate guarantee means records landing mid-export are deferred to the next export, mirroring the desktop file-rotation guarantee where each export sees a single sealed segment.
- **Retention / rotation: none on web in Phase 2.** The in-memory store keeps records for the life of the process. The Postgres-adapter follow-up ticket owns retention (env-controlled TTL, presumably aligned with audit-log policy of the deployment).
- **Reader-side `v` / `status` drop counter is deferred** to the Postgres adapter ticket. In-process, the writer guarantees `v: 1` and the storage cannot be written by a different version, so there is no opportunity for cross-version records to enter the store. The unknown-version drop path becomes meaningful only when records can be loaded from a persistent store written by an older or newer build.
- **Zod for schema validation, not class-validator.** The ticket's recommendation was "Zod (or class-validator)". Zod's `superRefine` cleanly expresses ADR-0017 §2's three cross-field invariants (`status=ok ⇒ error=null`, `status=error ⇒ error≠null`, `rows` xor `rows_affected`) in a single object schema; the same in class-validator would require custom validators wrapped around decorated DTOs and is awkward for plain-data persistence shapes that are not also HTTP DTOs.

**Consequences.**

- New runtime dependency: `zod@^4.4.3` on `apps/api`. Already verified against the workspace's `minimumReleaseAge: 1440`; no install / postinstall scripts.
- HTTP contract surface (`docs/api-contract.md`) is unchanged. No handback to desktop is required because the schema text already lives in desktop ADR-0017 — this ADR only points at it.
- A future Postgres history adapter slots in by registering a different provider for `HISTORY_STORE`; controllers, interceptor, use cases, and the export endpoint do not change.
- The Phase 3 conformance harness (ticket `0005`) is unaffected: history persistence is invisible to the contract test suite by design.

**Reversibility.** The mirror is a behavioural addition behind an `Optional`-injected port, so reverting reduces to removing the `HISTORY_STORE` / `RecordHistory` / `ExportHistory` providers, the interceptor decoration on `QueryController`, and `HistoryController` from the module. No external system depends on the egress endpoint yet; nothing in `docs/api-contract.md` references history. The Zod schema would stay as documentation of the shape even if the runtime path were removed.

**Cross-references.**

- Desktop ADR-0017: `dbboard@62ed834:docs/decisions.md` (search `## ADR-0017`).
- Desktop reference implementation: `dbboard@72cb165:crates/dbboard-ui/src/history.rs`.
- Desktop Stage 2 closeout: `dbboard@ae86627`.
- Cross-repo brief: [`./handoff/2026-06-04-history-schema-mirror-incoming.md`](./handoff/2026-06-04-history-schema-mirror-incoming.md).
- Web issue: [`./issues/0009-web-history-schema-mirror.md`](./issues/0009-web-history-schema-mirror.md).

---

## 2026-06-23 — Desktop `history.jsonl` fixture provenance + drift policy

**Context.** The schema-mirror ADR above proves web's `historyRecordSchema` accepts records emitted by web's own writer (`history-record.spec.ts`, `export-history.use-case.spec.ts`). What it does not prove is **byte equivalence across the two independent implementations** of ADR-0017 §2 — desktop's `serde_json::to_string(&RecordWire)` and web's `JSON.stringify(record)`. The Phase 5 acceptance line in [`./roadmap.md`](./roadmap.md) ("Export endpoint streams `application/x-ndjson` records that round-trip via `jq -c .` against a desktop `history.jsonl` fixture") needs a real desktop-emitted fixture to retire. Issue [`./issues/0018-history-export-roundtrip-fixture.md`](./issues/0018-history-export-roundtrip-fixture.md) tracks the closeout; the cross-repo brief is at [`./handoff/2026-06-23-history-fixture-emit-outgoing.md`](./handoff/2026-06-23-history-fixture-emit-outgoing.md).

**Decision.**

- **The fixture is bytes from desktop's production serialiser, not bytes synthesised on the web side.** Web commits `apps/api/test/fixtures/desktop-history.jsonl` containing lines produced by a desktop-side helper that calls the existing `RecordWire::from_entry` + `serde_json::to_string` path. A web-synthesised fixture would tautologically validate against the web schema and would not exercise the cross-implementation byte equivalence that is the point of the cross-check.
- **Production of the fixture is the desktop agent's responsibility.** Web does not touch `dbboard`. The cross-repo brief specifies the case set, the byte conventions, and the suggested helper shape (cargo example / ignored test / scripts dir). The maintainer carries the brief and the resulting bytes between the two repos.
- **Fixture cases are pinned in the issue.** At minimum: one `status=ok` with `rows`, one with `rows_affected`, one with both `null`, one `status=error` per `CategorizedError` category (`query` / `connection` / `schema` / `type_conversion` / `capability`), and one forward-compat record carrying an unknown top-level field. The forward-compat record is the only fixture line where re-emitted bytes intentionally diverge from source bytes (web's Zod strips unknown fields per ADR-0017 §6); the round-trip spec asserts the strip explicitly.
- **Byte invariants on the fixture are operator-checked, not parsed.** LF (not CRLF) terminators, trailing `\n` after the last record, no whitespace inside the JSON objects (`serde_json::to_string` default, not `to_string_pretty`), field order as declared in `RecordWire` (`v, ts, conn, actor, sql, status, duration_ms, rows, rows_affected, error`), and `null` rather than field omission for `Option<T>` fields. These are documented in the brief so the next person regenerating the fixture has a checklist.
- **Drift is a cross-repo coordination event, not a unilateral patch.** If desktop's serialiser later begins reordering keys (e.g. derives a `Serialize` impl that sorts, or adds `#[serde(rename_all=...)]`), changes the `Option<T>` → JSON mapping, or introduces whitespace, the byte-equivalence assertion in `apps/api/test/desktop-history-roundtrip.spec.ts` is what would alarm. Resolution is: open an ADR amendment on **both** repos before patching either side. Web does not silently adapt its `JSON.stringify` ordering to match a desktop drift, and desktop does not silently revert. ADR-0017 §2 is the contract; the fixture is the smoke alarm.
- **The fixture is committed to source control.** It's small (well under 100 lines), stable across releases (a v bump or schema change is an ADR-level event), and exercising the assertions on every CI run is the entire point. The fixture is not lazily downloaded, not regenerated in CI, not behind a network call. A regeneration only happens when ADR-0017 §2 itself changes, which by policy happens at the ADR cadence, not the release cadence.
- **An additional gitignored slot accepts ad-hoc local fixtures.** `apps/api/test/fixtures/local-history.jsonl` (gitignored) gives the maintainer a place to drop an interactively-extracted file from `%APPDATA%\dbboard\dbboard\config\history.jsonl` (or the `directories::ProjectDirs` equivalent on macOS / Linux) for one-off verification without polluting the committed fixture. The spec optionally picks the local file up when `process.env.DBBOARD_LOCAL_HISTORY_FIXTURE === "1"` is set and runs the same assertions; absence of the file or the env flag leaves the test silent.
- **The scaffold lands skipped.** `apps/api/test/desktop-history-roundtrip.spec.ts` is committed as `describe.skip(...)` so the slice lands today without waiting on desktop. Flipping the skip + adding the fixture file is the closeout step; that's a separate commit on `develop` when the bytes arrive.

**Consequences.**

- One small committed fixture file (~6–10 lines, < 2 KB) lives under `apps/api/test/fixtures/`. No new runtime dependency, no new test framework, no new harness.
- Once the fixture lands, every `pnpm test` run cross-validates the web read path against bytes produced by the desktop write path. A drift on either side fails CI immediately; the failure mode points the reader at ADR-0017 §2 + this ADR.
- The forward-compat strip behaviour is captured by a positive assertion (not just absence of an error), which means a future change to web's Zod that started rejecting unknown fields would be caught by the same spec.
- No HTTP contract change. `docs/api-contract.md` is not touched. `GET /history/export.jsonl` stays operator-only per the schema-mirror ADR above and per desktop ADR-0017 §8.
- The Postgres history adapter follow-up (`HISTORY_STORE` swap) inherits the same fixture for free: replacing the in-memory store with a Postgres-backed one in the round-trip spec is a one-line provider swap, not a fixture re-author.

**Reversibility.** Trivially reversible by deleting the spec, the fixture file, and the fixtures README. The Zod schema and the export endpoint are not touched by this ADR; the round-trip assertions are an additive verification, not a behavioural change. The desktop helper is owned by `dbboard` and is not visible from this side; if desktop deletes their fixture-emit binary, the only consequence here is that future regenerations require a one-off helper rebuild rather than a `cargo run` invocation.

**Cross-references.**

- Schema-mirror ADR (2026-06-05, immediately above).
- Desktop ADR-0017: `dbboard@62ed834:docs/decisions.md` (search `## ADR-0017`).
- Desktop reference implementation: `dbboard@72cb165:crates/dbboard-ui/src/history.rs`; current desktop tip: `dbboard@409fa54`.
- Desktop Stage 2 closeout: `dbboard@ae86627`.
- Outgoing brief: [`./handoff/2026-06-23-history-fixture-emit-outgoing.md`](./handoff/2026-06-23-history-fixture-emit-outgoing.md).
- Web issue: [`./issues/0018-history-export-roundtrip-fixture.md`](./issues/0018-history-export-roundtrip-fixture.md).

---

## 2026-06-24 — Aurora DSQL: no adapter mirror needed (desktop ADR-0021)

**Context.** Desktop shipped ADR-0021 (Aurora DSQL as a flavored kind over `dbboard-postgres`) on 2026-06-04 via PR #13 (`dbboard@cd41641`), and on 2026-06-23 issued an explicit no-op brief to web at `dbboard/.claude/issues/0006-web-aurora-dsql-no-mirror.md` (`dbboard@c35b3b2`, origin/develop tip `dbboard@f4126f1`). Incoming receipt at [`./handoff/2026-06-24-aurora-dsql-no-mirror-incoming.md`](./handoff/2026-06-24-aurora-dsql-no-mirror-incoming.md). Web ticket [`./issues/0010-aurora-dsql-no-mirror.md`](./issues/0010-aurora-dsql-no-mirror.md) is closed-on-arrival as no-op. The web side had been parking "Aurora DSQL adapter" under `project-status.md` § "Ready to start" since 2026-06-04 as "Blocked on a desktop handoff brief"; this ADR retires that flag.

**Decision.**

- **No `AuroraDsqlAdapter` is written.** Aurora DSQL speaks pg-wire byte-identically to vanilla Postgres — wire protocol, SQL surface, TLS, pool config, dynamic decoding, row cap. The `PostgresAdapter` shipped in ticket [`./issues/0004-phase-2-postgres-adapter.md`](./issues/0004-phase-2-postgres-adapter.md) (PR #9, `dbboard-web@0dc1a1b`) handles Aurora DSQL URLs unchanged. Adding a flavored subclass would buy zero technical capability and dilute the test surface (the `PostgresAdapter`'s integration spec is the only Postgres-side coverage).
- **No HTTP contract change.** `docs/api-contract.md` is untouched. `GET /capabilities` continues to report the adapter id as a free-form string per ADR-0012 — "aurora-dsql" is a valid identifier if a deployment chooses to surface it, but the wire shape is fixed regardless. No new endpoint, no new DTO, no new error category, no new HTTP status code. SemVer impact per ADR-0011: none.
- **IAM-token UX is documented in `docs/deployment.md`, not the contract.** Aurora DSQL is the only pg-wire flavor (Postgres / Neon / Supabase / Aurora DSQL) that does not accept static passwords — the password segment of the connection URL must carry a short-lived IAM authentication token (~15 min TTL). The user-facing expectation lives in [`../docs/deployment.md`](../docs/deployment.md) § "Connecting to Aurora DSQL (IAM-token URLs)": generate via `aws dsql generate-db-connect-auth-token` (CLI) or `@aws-sdk/dsql-signer` (Node SDK), re-paste the URL when the token expires, expect stale tokens to surface as the existing `connection` error category. AWS-side procedures (IAM policy setup, cluster endpoint discovery) are deliberately not restated — the doc points at AWS docs to avoid drift.
- **No SDK-driven token auto-refresh in this revision.** Desktop ADR-0021 §"Decision" path 2 deferred the SDK-integrated auto-refresh path; web matches that posture. A future "regenerate token" affordance (a server-side module wrapping `@aws-sdk/dsql-signer`) is a pure web-side decision and not a coordination point with desktop — when it ships, the connection URL stays the surface, only the password segment gets rewritten in-process before each pool acquisition.
- **No IAM-aware capability flag.** Desktop deferred `has_iam_auth`-style capability flags (ADR-0021 §"Decision" capability section); web does not pre-mirror them. If they ever cross the desktop HTTP contract, a fresh outbound brief will arrive and an additive mirror will be cheap.
- **The web in-memory `ConnectionRegistry` (`POST /connections`) needs no schema change.** The existing `connectionString` field carries the full `postgres://…` URL — Aurora DSQL hosts (`*.dsql.<region>.on.aws`) work as-is. The auth-mode field rejected for the static-URL case is the user's pre-generated IAM token in the password segment; the registry does not need an `awsRegion` / `awsProfile` / token-source DTO.

**Consequences.**

- Web ticket `0010` closes without any production code change, test suite change, or contract change. The `0010-aurora-dsql-no-mirror.md` issue body is the audit trail; this ADR is the rationale.
- The `project-status.md` "Aurora DSQL adapter" line under § "Ready to start" is replaced by a closed-out marker citing this ADR.
- The Postgres adapter's `sslmode` auto-upgrade list (`*.neon.tech`, `*.supabase.co`) does **not** need a third entry for `*.dsql.<region>.on.aws`. Aurora DSQL connection strings must already carry an explicit `sslmode=require` (TLS-only is mandatory on the cluster side, so a URL missing it would fail at connect), and the auto-upgrade only catches missing `sslmode` for Neon / Supabase where TLS is also required but commonly forgotten by users. Aurora DSQL users are typically following AWS docs which already specify the SSL parameter.
- No new runtime dependency. `@aws-sdk/dsql-signer` is not added — users either run the AWS CLI themselves or, if they want programmatic token refresh, integrate at deployment time (env-var preprocessing, sidecar, cron).
- The memory record `project-aurora-dsql-planned` is now stale (it described a "stub ticket pending desktop brief" approach that is superseded by this no-op disposition). It is updated/deprecated in the same coordination round.

**Reversibility.** Trivially reversible if a future desktop ADR ships a wire-level Aurora DSQL coordination point (capability flag, new endpoint for token refresh, etc.) — a fresh outbound brief would land in `./handoff/`, a new web ticket would open against it, and this ADR would gain a supersedence pointer (not a deletion — the no-op disposition for the static-URL path remains historically correct).

**Cross-references.**

- Desktop ADR-0021: `dbboard@cd41641:docs/decisions.md` (search `## ADR-0021`).
- Desktop reference implementation: `crates/dbboard-postgres` `connect_aurora_dsql` + `FLAVOR_AURORA_DSQL` at `dbboard@cd41641` (PR #13 merged 2026-06-04).
- Desktop brief: `dbboard/.claude/issues/0006-web-aurora-dsql-no-mirror.md` at `dbboard@c35b3b2`.
- Incoming receipt: [`./handoff/2026-06-24-aurora-dsql-no-mirror-incoming.md`](./handoff/2026-06-24-aurora-dsql-no-mirror-incoming.md).
- Web closeout ticket: [`./issues/0010-aurora-dsql-no-mirror.md`](./issues/0010-aurora-dsql-no-mirror.md).
- Web UX note: [`../docs/deployment.md`](../docs/deployment.md) § "Connecting to Aurora DSQL (IAM-token URLs)".

---

## 2026-06-24 — AI Phase 6: no HTTP contract mirror needed (desktop ADR-0023 Stage 1)

**Context.** Desktop shipped ADR-0023 (`dbboard-ai` provider trait + Anthropic provider) Stage 1 across PRs #18 / #20 / #22 / #24 / #27 (closing desktop issue `0005-dbboard-ai-trait-and-anthropic-provider`), and on 2026-06-23 issued an explicit no-op brief to web at `dbboard/.claude/issues/0007-web-ai-phase6-no-contract-mirror.md` (`dbboard@c35b3b2`). Incoming receipt at [`./handoff/2026-06-24-ai-phase6-no-contract-mirror-incoming.md`](./handoff/2026-06-24-ai-phase6-no-contract-mirror-incoming.md). The brief targets the "AI shapes" item in [`./roadmap.md`](./roadmap.md) § "Relationship with the desktop client" (line ~176) and the Phase 6 DoD.

**Decision.**

- **AI is out of the HTTP contract on the desktop side.** ADR-0023 Decision 3 explicitly chose **in-process wiring, not HTTP-mediated** for the AI provider — same precedent as ADR-0020 (`swap_backend`) and ADR-0022 (`set_language`). There is no `POST /ai/explain`, no `POST /ai/suggest`, no `AiResponse` DTO, no AI error category on the desktop's wire. `docs/api-contract.md` (desktop) is untouched by ADR-0023.
- **Web's roadmap is amended to reflect this.** The "AI shapes" entry in the contract-alignment list on [`./roadmap.md`](./roadmap.md) line ~176 is removed (it was speculative — there was no AI shape on the desktop contract to align with). The Phase 6 DoD on the same file gains a no-mirror note pointing at this ADR. The Phase 6 DoD bullets ("provider port", "at least one adapter", "core flows work with the AI module disabled") are unchanged — they were never contract-mirror bullets to begin with; only the parenthetical list at line ~176 implied a wire-level alignment that did not exist.
- **Web is free to ship Phase 6 on the Stage 1 footing whenever it lands** — provider port + at least one adapter behind an env flag + graceful degradation when the env var is absent. Web does **not** wait for a desktop Stage 2 ADR (Settings UI, persisted keychain, streaming, multi-provider switcher, DDL extraction, function-calling, AI history records — all queued on desktop, may or may not produce wire-level coordination). When and if desktop Stage 2 surfaces an HTTP-contract change, a fresh brief in the `0NNN-web-*` sequence will arrive.
- **No web Phase 6 ticket opens in this round.** This ADR records the disposition; the implementation ticket (`.claude/issues/0NNN-*` with a fresh slot number) opens when web actually starts the Phase 6 work, and it cites this ADR + the incoming receipt + desktop ADR-0023 by anchor. Same pattern issue `0009` used for ADR-0017 — no implementation before the green-light.
- **Pattern recommendations are recorded but not binding.** When web does ship Phase 6, the brief recommends (not requires) mirroring desktop's `AiProvider` trait shape conceptually — `id()` / `capabilities()` / `explain()` / `suggest_sql()` translated into TS-flavored signatures — so cross-repo readers recognise the surfaces. Same for the env-var-only Stage 1 footing (no persisted keychain in v1), the graceful-degradation-by-absence convention (no AI panel rendered when the env var is unset, rather than a greyed-out "unavailable" stub), and capability flags defaulting to `false` (streaming / function-calling off until the UI is wired for them). These are design hints, not contract obligations.
- **Web's NestJS-native shape will differ from desktop's Rust shape — that is fine.** `@anthropic-ai/sdk` (the official Node SDK) wrapped in a NestJS module under `apps/api/src/modules/ai/` is the natural Node-side equivalent of desktop's `crates/dbboard-anthropic`. Web's request / response DTOs may diverge from desktop's `ExplainRequest` / `SuggestRequest` / `AiResponse` Rust types — they are not on the same wire and there is no breakage. If web ships `/ai/explain` and `/ai/suggest` as web-only endpoints, those are unilateral surfaces (same posture as `/connections/*` shipped in web PR #7), not contract-mirror endpoints.
- **Env var naming is left open until Phase 6 implementation.** Desktop uses `DBBOARD_ANTHROPIC_API_KEY` and `DBBOARD_ANTHROPIC_MODEL`. Web may reuse those (natural for a maintainer running both clients side-by-side) or pick its own; the `DBBOARD_*` prefix is already a shared convention on both repos (`DBBOARD_API_SECRET`, `DBBOARD_BIND_HOST`, `DBBOARD_PG_URL`, etc.).

**Hard redlines (binding even though the brief is otherwise advisory).**

- **Do not record AI calls in `history.jsonl`.** Desktop deferred AI history records to Stage 2 (ADR-0023 §9). Unilaterally extending web's `historyRecordSchema` (`apps/api/src/domain/history-record.ts`) to capture AI invocations would force a v:1 → v:2 schema bump ahead of any cross-repo coordination — that breaks the byte-equivalence round-trip cross-check shipped in [`./issues/0018-history-export-roundtrip-fixture.md`](./issues/0018-history-export-roundtrip-fixture.md) (the desktop-emitted fixture at `apps/api/test/fixtures/desktop-history.jsonl` is pinned at v:1). A v:2 bump is an ADR-level coordination event on both repos, not a unilateral patch. Web's Phase 6 implementation must leave the history schema untouched.
- **Do not invent a contract surface to "mirror" the in-process AI wiring.** ADR-0023 Decision 3 rejected this for desktop because inflating the shared contract with AI mirror routes buys zero parity. The same reasoning applies on web: if Phase 6 surfaces `/ai/*`, those routes exist for web's own UI consumption, not as a desktop-bound mirror.

**Consequences.**

- One line removed from `./roadmap.md` line ~176 (the "AI shapes" item in the contract-alignment parenthetical). One short note added to the Phase 6 DoD pointing here. No code change, no test change, no production module touched.
- Phase 6 implementation work, when it lands, ships against a smaller acceptance surface: the wire-alignment dimension is now explicitly "none required for Stage 1". The remaining DoD bullets (provider port + one adapter + AI-disabled core flows) are the actual definition of done.
- The desktop Stage 2 future-drift signals listed in the brief (a `POST /ai/*` route, an AI error category, a server-side AI capability flag, an `ai-providers.toml` schema, AI calls in `history.jsonl`) are now the only conditions under which a fresh AI-shaped brief would arrive. Until then, no AI-wire coordination work is queued.

**Reversibility.** Trivially reversible if a future desktop ADR introduces a wire-level AI coordination point. A fresh `0NNN-web-*` brief would land in `./handoff/`, a new web ticket would open against it (or this ADR would gain a supersedence pointer if the change is narrow), and the roadmap entry would be re-added in the form that the new brief actually demands rather than the speculative "AI shapes" placeholder this ADR retires.

**Cross-references.**

- Desktop ADR-0023: `dbboard/docs/decisions.md` (search `## ADR-0023`); Decision 3 ("In-process wiring, not HTTP-mediated") and Decision 9 (Stage 2 deferrals) in particular.
- Desktop reference implementation: trait crate `crates/dbboard-ai` (PR #20, `dbboard@584348f`), provider crate `crates/dbboard-anthropic` (PR #22, `dbboard@c705918`), env-var wiring `apps/dbboard` (PR #24, `dbboard@6ad670d`), UI panel + worker dispatch + 11-locale Fluent (PR #27, `dbboard@c86424a`).
- Desktop brief: `dbboard/.claude/issues/0007-web-ai-phase6-no-contract-mirror.md` at `dbboard@c35b3b2`.
- Incoming receipt: [`./handoff/2026-06-24-ai-phase6-no-contract-mirror-incoming.md`](./handoff/2026-06-24-ai-phase6-no-contract-mirror-incoming.md).
- Sibling closeout: [`./issues/0010-aurora-dsql-no-mirror.md`](./issues/0010-aurora-dsql-no-mirror.md) (same desktop PR `dbboard@c35b3b2` shipped both no-op briefs).
- Web roadmap entry: [`./roadmap.md`](./roadmap.md) § "Phase 6 — Optional AI provider interface" + § "Relationship with the desktop client" (line ~176).
- Hard redline anchor: [`./issues/0018-history-export-roundtrip-fixture.md`](./issues/0018-history-export-roundtrip-fixture.md) (v:1 schema lock).
