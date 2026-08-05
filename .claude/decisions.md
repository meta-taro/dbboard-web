# Technical decisions

Append-only log of significant technical decisions. Each entry: date, decision, context, alternatives considered, rationale.

> **On baseline §31 (record-file stocktake).** This file passed 400 lines on 2026-08-05 and will keep growing. It is not a stocktake target: §31 names decisions, their Why, lessons from failures, and primary-source citations as content that stays in the original file — and this file is nothing else. Archiving an entry here would remove the record a future session needs in order to not re-litigate the decision. The files §31 is aimed at are the ones that accumulate session logs and stale snapshots; `project-status.md` is the one to watch.

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

---

## 2026-08-03 — Port the desktop PII scanner; add the CI this repo never had

**Context.** Reviewing the desktop client's progress surfaced two of its recent ADRs that are not database-behaviour mirrors and therefore had no incoming brief, but that describe an exposure this repository shares one-for-one:

- **ADR-0055** (`dbboard`): a public repo developed against real, business-identifying databases needs a preventive leak scanner, not just a one-time cleanup.
- **ADR-0084** (`dbboard`): commit **identity** is asymmetric with commit **content**. A leaked string in a file is fixable by a later commit; an address in the author/committer field is part of the commit object, so removing it rewrites that hash and every descendant. `git grep` reads trees, so it structurally cannot see this class of leak.

Two facts made this urgent rather than aspirational. First, `dbboard-web` is public and its fixtures are full of connection strings. Second — verified, not assumed — **this repository had no `.github/` directory at all**: no CI, no scanner, nothing. The husky hooks were the only gate, and a hook is skippable and absent entirely for a reviewer working from a fork. Baseline §23 ("check CI after every commit") had been silently unsatisfiable since the repo was created.

A third fact was found while checking: all 129 commits from the root commit to `develop` carried the maintainer's personal email in the author and committer fields, on a public repo. The desktop repo had already fixed its going-forward half; this one had not.

**Alternatives.** (a) Write a web-native scanner in TypeScript as a pnpm script — rejected: it would drift from the desktop's rules, and the rule set is the valuable part, not the language. (b) Adopt an off-the-shelf secret scanner (gitleaks, trufflehog) — rejected: none of them scan commit _identity_, which is the half that cannot be fixed after the fact, and a third-party action in a `contents: read` workflow is new supply-chain surface for a repo whose own `pnpm-workspace.yaml` quarantines dependencies for 24h. (c) Enable GitHub's push protection only — rejected as insufficient: it catches provider-issued credentials, not customer names or a personal email in a commit header.

**Decision.** Port `scripts/pii-scan.sh` and its allowlist from the desktop, adapt only what is repo-specific, and add the two workflows this repo was missing.

- **Scanner**, ported with four changes: the lockfile exclusion (`Cargo.lock` to `pnpm-lock.yaml`), the runbook pointer, the header provenance note, and two web-specific lines in the selftest's clean fixture.
- **Allowlist** gained one advisory-tier section for the two DSN shapes web's fixtures actually use — the testcontainers template with an unresolved host/port, and the single-letter controller placeholder. Both under the advisory marker, which is load-bearing: entries there cannot silence a blocking finding.
- **Hooks**: `pre-commit` runs the scanner _after_ `lint-staged`, so it sees the bytes that will actually be committed; `commit-msg` scans the message. Both pass `--reveal` — a local terminal is private, a public Actions log is not.
- **`.github/workflows/pii-scan.yml`**: selftest, tree, commit messages, and identity, on push/PR to the integration branches plus a daily cron. `contents: read`, first-party actions only, denylist materialized from the `PII_DENYLIST` secret and shredded afterwards, never `--reveal`.
- **`.github/workflows/ci.yml`**: the verification chain CLAUDE.md already documents — `format:check`, `lint`, `typecheck`, `test`, `build` — on pnpm via corepack.
- **Git identity**: the repo-local `user.email` is now the GitHub noreply address. Nothing new joins the leaked set.

**Rationale.**

- _Why port rather than reimplement._ The scanner's value is the calibration: which rules block and which only advise, and why. A database client's test suite is full of synthetic connection strings, so a scanner that blocks on every passworded URL gets disabled within a week. The two-tier split (denylist literals + private keys + AWS key ids block; URL/email/path _shapes_ advise) is the outcome of that pressure on the desktop side, and it transfers unchanged because both repos have the same fixture problem.
- _Why the identity check is blocking while shape rules are not._ This is the ADR-0084 asymmetry. Everything else the scanner finds can be fixed by the next commit. An author address cannot, so it has to be stopped before the commit object exists.
- _Why the identity scan is event-scoped and the message scan is not._ Measured, not guessed: scanning all 129 commit messages from the root commit comes back clean, so scanning the full message history is free and stays green. Identity over the same range is red on every single commit, pending the rewrite. Scanning it would be permanently red and would bury the live signal — the check exists to stop new ones.
- _Why `origin/main..HEAD` for messages._ Inherited from the desktop template, but it means something different here: `main` **is** the root commit (`develop` is 129 ahead, `main` is 0 ahead), so the desktop's "new commits" range is web's "all commits" range. Kept as-is because on this repo it happens to be the strictly better scan, and noted in the workflow header so the next reader is not misled by the familiar-looking expression.
- _Why TDD applied to a shell script._ It caught a real bug on the desktop side (a mode that parsed but never dispatched, so it reported "clean" without scanning anything — the worst possible failure for a scanner). Here the RED step had to be made honest twice: the first attempt seeded the selftest fixture with a _resolved_ URL, which only tripped one of the two expected rules because an existing allow entry already covered the loopback address. Using the literal tracked text — the unresolved host/port template — produced a genuine two-rule failure before the allow entries were added.

**Hard boundaries (not AI work).**

- **The `.pii-denylist` file and the `PII_DENYLIST` secret must be created by the maintainer** (baseline §15). Until they exist, literal-name detection is OFF and the scan runs on generic rules only. It degrades quietly rather than failing, which is the right default but is also easy to forget — the workflow logs `denylist: PII_DENYLIST secret absent` on every run.
- **The 129 published commits are left alone.** Rewriting them means a force-push on a public repository, which baseline §6 and §32 both put on the human side, and it is the same decision as the desktop's own pending 428-commit rewrite. Doing one repo and not the other buys nothing. The shape of the work is written up in `docs/maintainer/pii-scanning.md` § History rewrite so the decision can be made from the facts rather than re-derived.

**Consequences.**

- Every commit from here is scanned twice locally and up to four ways in CI; no commit can be authored under a non-noreply address without the hook refusing.
- CI exists for the first time, which means baseline §23 is now actually satisfiable and a fork's PR gets checked by something other than trust.
- The conformance battery stays out of CI deliberately — it spawns the desktop loopback binary, which does not exist on a GitHub runner. It remains a maintainer-invoked `pnpm conformance`.
- The Postgres integration spec _does_ run in CI: `ubuntu-latest` has a Docker daemon, so the testcontainers path is exercised rather than skipped.

**Reversibility.** Fully reversible — the scanner is one self-contained script plus a data file, and the workflows are additive. The one irreversible part is deliberately not being done in this change: the history rewrite.

**Cross-references.**

- Desktop: ADR-0055 and ADR-0084 in `dbboard/docs/decisions.md`; the runbook at `dbboard/docs/maintainer/history-sanitize-runbook.md`; the workflow this one was ported from at `dbboard/.github/workflows/pii-scan.yml`.
- Web operator guide: [`../docs/maintainer/pii-scanning.md`](../docs/maintainer/pii-scanning.md).
- Baseline anchors: §6 (push is the human's), §15 (secrets are the human's), §23 (CI self-check), §32 (no personal identity in a public repo).

---

## 2026-08-03 — Admit GitHub's web-flow committer address in the identity check (mirrors desktop ADR-0085)

**Context.** The scanner ported earlier the same day allowed only the per-account noreply forms as a publishable identity: `<id>+<login>@users.noreply.github.com` and the older `<login>@` variant. That is the address `git config user.email` produces, so every commit written from a clone passes.

It is not the only address GitHub writes. Commits created through the web UI — "Squash and merge" included — are stamped by GitHub's web-flow with the bare `noreply@github.com` as the **committer**. That address is not under `users.`, so the allowlist rejected it.

The desktop repo found this the hard way. Its PR #127 squash leaked a personal author address; turning on the account's email-privacy setting fixed the author, and the identity step stayed red anyway on the committer. A genuine finding and a false positive that had been firing on every web merge were indistinguishable from the job status. Desktop fixed it as ADR-0085 (`dbboard@27824b0`).

The same defect was live here. This repository merges through the GitHub web UI — twelve commits in its history already carry `noreply@github.com` as the committer — so the next squash merge would have gone red on a check no configuration could satisfy.

**Alternatives.** (a) Leave it and let maintainers learn to ignore identity failures on merge commits — rejected, and the reason is the whole point of the desktop incident: a check that is red for a known-benign reason cannot report the unknown malignant one. (b) Skip the identity scan on merge commits — rejected: the merge commit is exactly where the author leak appeared, so exempting it removes the coverage that mattered. (c) Broaden the pattern to any `@github.com` address — rejected as too loose; `evil-noreply@github.com` and `noreply@github.com.example.com` would both slip through.

**Decision.** Widen `IDENTITY_ALLOW_RE` to admit `noreply@github.com` as a whole-string alternative alongside the two account forms, and pin all three in `--selftest` together with the two near-miss rejections.

**Rationale.**

- _Why it is safe to admit._ The address belongs to GitHub rather than to any account, so it identifies nobody. Admitting it leaks nothing; the personal address it might otherwise mask is caught on the author field, which is unchanged.
- _Why a whole-string alternative rather than a relaxed pattern._ The regex is anchored at both ends and the new branch is a literal. `evil-noreply@github.com` fails the left anchor and `noreply@github.com.example.com` fails the right one. Both are asserted in the selftest, so a future edit that loosens the anchors fails the first CI step rather than silently widening what counts as publishable.
- _Why TDD on a one-line regex._ The RED step is what proved the defect was live here and not merely inherited from desktop's history: adding `noreply@github.com` to the selftest's accept list failed against web's own copy before the regex changed. The two near-miss cases passed at RED already, which is the useful half of the result — it shows the fix widened exactly one thing.

**Consequences.**

- Web-UI merges no longer fail the identity step. An identity failure from here is a finding.
- Twelve existing web-flow commits stay out of scope regardless: the CI identity scan is event-scoped, so it only ever sees the commits a push or PR introduced.
- The two repositories' scanners are back in sync. They are separate files by design (no shared submodule), so drift is a standing risk — this entry is the second data point, after the initial port, that desktop is the upstream of record for scanner rules.

**Reversibility.** One line and five selftest fixtures; fully reversible.

**Cross-references.**

- Desktop: ADR-0085 in `dbboard/docs/decisions.md`, landed by `dbboard@27824b0`. The incident behind it is the squash merge of PR #127 (`dbboard@e15dcff`); its write-up is `dbboard@d7ed16b`.
- Prior entry: "2026-08-03 — Port the desktop PII scanner; add the CI this repo never had" above.
- Operator guide: [`../docs/maintainer/pii-scanning.md`](../docs/maintainer/pii-scanning.md) § Commit identity.

---

## 2026-08-04 — History schema v:2: mirror desktop ADR-0027, and upgrade v:1 on read

**Context.** Ticket [`0023`](./issues/0023-history-v2-mirror.md), rung 1 of [`parity-ledger.md`](./parity-ledger.md). Desktop bumped the per-record history schema from v:1 to v:2 on 2026-06-30 (its ADR-0027) so AI calls could be logged alongside SQL, adding a top-level `kind: "query" | "ai"` discriminator. Brief `0008` was handed to this repo the same day. It was found 35 days later by the parity survey, not by the handoff — the receipt in [`handoff/2026-08-04-history-v2-mirror-incoming.md`](./handoff/2026-08-04-history-v2-mirror-incoming.md) is dated accordingly.

The per-record JSON is one of exactly two things the two repos share (ADR-0004: the HTTP contract and the user-data formats; no code). So this entry mirrors a design rather than making one. What follows is only the places where web had to decide something desktop's ADR does not answer.

**Decision 1 — v:1 upgrades on read; byte-identical v:1 round-trip is given up.**

Brief 0008 requires v:1 records to load as the equivalent v:2 `kind: "query"` record. Ticket [`0018`](./issues/0018-history-export-roundtrip-fixture.md) asserts a desktop-emitted v:1 fixture re-exports byte-identically. Both cannot hold: upgrade on read means re-emitting produces v:2 bytes.

The brief wins and the byte-identity assertion narrows to "v:1 in, canonical v:2 out". This is safe _here specifically_ because web's history store is in memory — **there is no v:1 data in this system to preserve.** The v:1 reader exists solely to ingest desktop-emitted files, and for that purpose representing them correctly is the requirement; round-tripping them back to disk unchanged is not something any caller does.

That would be a different judgement against a persisted v:1 corpus, and it is worth stating because the next bump will face the same fork with a store that may by then not be in-memory.

**Decision 2 — mirror the writer-side 64 KiB cap (desktop Decision 10), keep the reader unbounded.**

`prompt` and `response` are capped at 64 KiB of **UTF-8** each at the write boundary, backing off to the code-point boundary at-or-below the cap and appending a marker. The schema keeps a bare `z.string()`, matching desktop, so a record written under a different cap — an older build, another tool, a future value — still reads.

This was missed on the first pass. The ticket's invariant list originally said prompts were stored with "no trimming", which conflated Decision 8 (no redaction, which is true) with Decision 10 (a length cap, which the ADR summary does not surface). It came to light while checking a type name against desktop's source rather than asserting it from memory. **The reusable finding is that the gap was invisible in the decision record and visible only in the reference implementation** — the remaining parity rungs should read desktop's shipped code, not its prose.

Two details carry the byte-equivalence and are pinned by tests because either is easy to "fix" wrongly:

- The cap counts UTF-8 bytes; JS string length is UTF-16 code units. A naive `slice(0, CAP)` keeps roughly 3x too much CJK.
- ADR-0027's prose renders the marker with a leading ellipsis. The shipped constant has a leading space and no ellipsis. The bytes have to match a running program, so the implementation is the authority — noted at the constant, in the spec header, and in the ticket, because the prose is what a future reader is most likely to find first.

**Decision 3 — no `recordAiCancelled` writer.**

The schema accepts `status: "cancelled"` because desktop emits it and web must read it. Web does not write it: its AI surface is non-streaming request/response with no abort path, so the writer would be unreachable code. Add it when Stage 2 wires streaming.

The cost is stated plainly rather than filed away: web's read support for `cancelled` is exercised only against objects web itself constructed. That is the circular validation a desktop fixture is supposed to break, and the fixture does not yet cover it — see "Known gap" below.

**Decision 4 — `AiProvider.getModel()` exists because the error path needs it.**

v:2 requires a non-empty `model` on an AI record whether or not the call succeeded. On the error path there is no response to read one from, so the port exposes the configured model separately from `AiResponse.model` (what actually answered). When both are available the served id wins — it is the more precise answer to "what produced this?".

This is a divergence in port shape from desktop, not in the record: the record ends up identical either way.

**Decision 5 — 401/403 map to `configuration`, everything unproven to `provider`.**

The AI envelope's three categories are `network | provider | configuration`, disjoint from the query record's five DB categories. Only the adapter can tell a transport failure from an upstream rejection, so only `AiError` carries a category we trust; an authentication rejection is a deployment fault rather than an Anthropic fault, hence `configuration`. Everything else — including a DB `CategorizedError` that reached the AI path by mistake — records as `provider`, on the grounds that the call failed past our boundary and nothing has proven otherwise.

A non-`AiError` exception is deliberately **not** recorded at all: it is a bug in our own code, not an AI outcome, and filing it under `provider` would blame the upstream for our crash.

**Decision 6 — the `{ text, model }` wire body is frozen.**

`AiResponse` widened to carry `tokensIn` / `tokensOut` / `stopReason` for the record. The HTTP body did not: the controller projects back down to the documented `{ text, model }`. Token counts are history-log material, not something the UI asked for, and widening a response body is not reversible once a client depends on it.

**Consequences.**

- Byte-compatibility is now demonstrated rather than argued. Before the desktop-emitted v:2 fixture landed, key-order equivalence rested on reasoning about Zod v4 normalising to schema-declaration order on parse; the fixture now re-exports byte-for-byte, AI record included.
- The Phase 6 redline ("do not record AI calls in `history.jsonl`") is spent. It is struck through in [`roadmap.md`](./roadmap.md) rather than deleted, because the rule it encoded — a schema shared with another repo does not get bumped from one side — outlives this instance.
- `GET /ai-history` still does not exist. History remains off the wire.

**Known gap (owed by desktop).** The fixture was generated from desktop's own emitter via the command brief 0008 prescribes, so the bytes are genuinely desktop's serialiser. But the emitter constructs exactly one AI record, `status: "ok"`. The `error` and `cancelled` AI cases are unwritten, and `cancelled` is the one that matters per Decision 3. Raised back to desktop per brief 0008 § Notes ("file it back as a desktop-side ticket rather than diverging silently") rather than being papered over with a hand-written fixture, which would prove only that web agrees with web. Outgoing brief: [`handoff/2026-08-04-ai-fixture-cases-outgoing.md`](./handoff/2026-08-04-ai-fixture-cases-outgoing.md).

**Reversibility.** The schema is additive and the v:1 reader stays. The one thing not reversible for free is Decision 1 — once callers rely on reads returning v:2, restoring v:1 passthrough is a second migration.

**Cross-references.**

- Desktop: ADR-0027 (Decisions 5, 8, 9, 10) and ADR-0026 Decision 12 in `dbboard/docs/decisions.md`; the reference implementation at `dbboard/crates/dbboard-ui/src/history.rs`; the brief at `dbboard/.claude/issues/0008-web-history-v2-mirror.md`.
- Prior web entries: "2026-06-05 — Query-history persistence mirrors desktop ADR-0017 (web Stage 2)" and "2026-06-23 — Desktop `history.jsonl` fixture provenance + drift policy" above; the latter's provenance rules are what this fixture was generated under.
- Ticket: [`issues/0023-history-v2-mirror.md`](./issues/0023-history-v2-mirror.md). Ledger: [`parity-ledger.md`](./parity-ledger.md) rung 1.

## 2026-08-04 — Adapter correctness: enforce the text wire format, add a server-side timeout, survive idle-client errors

**Context.** Ticket [`0024`](./issues/0024-adapter-correctness.md), rung 2 of [`parity-ledger.md`](./parity-ledger.md). Desktop shipped three adapter-level corrections web had never mirrored: ADR-0070 (row-producing paths must use the text wire protocol, enforced at runtime), ADR-0081 (send a statement timeout to the server), ADR-0071 (a listed table nobody can read must degrade, not abort the sweep). ADR-0024 (`0o600` at-rest permissions) was on the same rung.

Rung 1's lesson was "read the shipped code, not the prose." This rung found it cuts the other way as well: **the ledger was wrong about _web_ three times in one rung.** Two of the four rows turned out to be no-ops, and a third was already satisfied by a different mechanism than the row assumed. What follows records both what changed and what did not, because the rows that did not change cost the same reading time and would otherwise be re-derived from the same wrong text.

**Decision 1 — reject binary-format columns at decode, and trigger on `=== "binary"`.**

`pgOidToValue` decodes text-format bytes. Handed binary ones it does not fail: a binary `int4` of `1` is `00 00 00 01`, which passes a UTF-8 check and renders as four invisible control characters. Desktop shipped exactly that in v0.4.0, which is why its ADR-0070 Decision 4 insists the check survive a release build rather than living in a `debug_assert`.

Web reaches the text path by omitting `values` from `pool.query` (keeping pg on the simple protocol) plus a `getTypeParser` override. Both are conventions, not guarantees — adding a `values` array, the obvious shape of a future parameterisation change, flips the protocol with no other visible symptom. So the guard sits at decode and inspects `result.fields`, i.e. **what the server actually replied**, not our own call site.

The trigger is `format === "binary"`, deliberately not `format !== "text"`. `Field.format` is `'text' | 'binary'` on the wire (`pg-protocol/dist/parser.js:216`, `int16() === 0 ? 'text' : 'binary'`) but pg defaults it downstream (`lib/result.js:99`, `desc.format || 'text'`), and roughly thirty hand-built stubs in the unit suite omit the property entirely. Rejecting on `!== "text"` would fail all of them while asserting something the data does not say. **Absence is not evidence**; two positive tests pin it (explicit `"text"` accepted, omitted `format` accepted) so the next reader does not "tighten" it back.

This required one non-obvious change elsewhere: `translateError` gained a pass-through for our own domain errors. The guard throws from inside the same `try`, carries no `code`, and a codeless error is deliberately read as connection-level — without the pass-through a corrupt-decode report would have surfaced to the caller as a 502 "database unreachable".

**Decision 2 — keep both timeouts; they fail in different places and neither subsumes the other.**

The ledger row said web sent no statement timeout. It did — as `query_timeout`. But pg's `query_timeout` is a **client-side `setTimeout`** (pg@8.21.0 `lib/client.js` ~654): nothing is sent to the server, no CancelRequest is issued, the socket is not destroyed. It calls `query.handleError`, invokes the callback, clears the query and pulses the queue. The caller is told the statement failed **while it is still running**, and outside an explicit transaction the write still commits.

`statement_timeout` is a real startup-packet parameter (`lib/client.js:543`, `getStartupConf`), so the server aborts the statement itself with SQLSTATE 57014. Set once at connect — no per-query `SET`, no extra round trip.

Both are kept at the same budget. Client-side alone leaks server work; server-side alone leaves the caller hanging if the connection itself wedges. Desktop's ADR-0081 concerns MySQL's probed timeout variable and states the Postgres path "has no such divergence" — true of desktop's Postgres adapter, not of web's, which is why this row read as satisfied and was not.

**Carry-forward for rung 6.** A startup-packet `statement_timeout` applies to every statement on the connection, writes included. When write paths land (ADR-0042/0049/0050/0051/0045), a long `UPDATE` will be aborted server-side at the same 30 s budget. That is the correct default, but it is a behavioural constraint on rung 6 rather than a discovery to be made there — recorded here and in ticket 0024 invariant 4.

**Decision 3 — log idle pooled-client errors instead of letting them kill the process.**

Not in the ticket's survey. The integration suite reported **25/25 passing with exit code 1** and an uncaught `FATAL: terminating connection due to administrator command` (SQLSTATE 57P01).

The temptation was to read that as harness noise. It was settled by isolation instead: stash everything → HEAD exit 0; stash only the new tests, keep the production change → exit 0; a **pre-existing** test (`-t "int4 → Integer"`) run with the production change → exit 1, and with the production files stashed as well → **also exit 1**. So the defect predates the ticket entirely; the new tests merely shifted teardown timing enough to expose it.

A pooled client that errors while idle has no in-flight query to reject, so pg emits `'error'` on the Pool. With no listener there Node treats it as unhandled and the process exits — from something entirely routine: a database restart, an admin terminate, a pooler recycling an idle connection (Neon and Supabase both do), or an idle TCP reset. **A Neon connection left idle overnight could have taken the API process down.** Nothing needs recovering — pg removes the broken client itself and the next query opens a fresh one — so `attachIdleClientErrorHandler` logs and stays up.

Fixed in production code rather than in the test, because the test was reporting the truth. **A green test count with a non-zero exit code is a finding, not a formatting problem.**

**Two rows that were already satisfied, and why they read as open.**

- **ADR-0024 (`0o600` at-rest) — `n/a`.** Desktop's concern is a local credential file. Web holds no such file: connection config arrives per request and lives in memory. There is nothing on disk to chmod. The row's `todo` was a category error, not a gap.
- **ADR-0071 (an unreadable table must not abort the sweep) — `done`.** `listTables` reads `pg_catalog.pg_tables`, which lists what the role can see and does not attempt to read any of them. Desktop's sweep touched each table and therefore needed per-table degradation; web's single catalog query cannot partially fail in that way.

Both are now recorded with reasoning in the ledger rather than deleted, for the same reason this section exists.

**Consequences.**

- A binary-format column now produces an actionable `QueryError` naming the column instead of invisible control characters in the grid.
- Over-budget statements are aborted by the server, not merely abandoned by the client. Callers may now see SQLSTATE 57014 (`canceling statement due to statement timeout`) where they previously saw only pg's client-side timeout message.
- The API no longer exits when an idle pooled connection is dropped.
- Integration suite is 25/25 with exit 0 and no uncaught exceptions.

**Reversibility.** All three are small and self-contained. The one with a standing implication is Decision 2: removing `statement_timeout` later would silently restore the leak-server-work behaviour, and nothing would fail — which is the argument for the tests that pin it.

**Cross-references.**

- Desktop: ADR-0070, ADR-0081, ADR-0071, ADR-0024 in `dbboard/docs/decisions.md`.
- pg internals cited from the shipped source at `node_modules/pg@8.21.0` — `lib/client.js` (543, ~654), `lib/result.js:99`, `pg-protocol/dist/parser.js:216`.
- Ticket: [`issues/0024-adapter-correctness.md`](./issues/0024-adapter-correctness.md). Ledger: [`parity-ledger.md`](./parity-ledger.md) rung 2.

## 2026-08-04 — Grid and UX parity: enforce the theme rule mechanically, sort as a permutation, show both halves of an error

**Context.** Ticket [`0025`](./issues/0025-grid-and-ux-parity.md), rung 3 of [`parity-ledger.md`](./parity-ledger.md) — six desktop ADRs in six slices: ADR-0041 (theme), ADR-0035 (CSV/TSV export), ADR-0048 (multi-column sort), ADR-0082 (wide-cell viewer), ADR-0039 (localized + original error), ADR-0083 (sidebar divider). Re-deriving all six against `apps/web/app/` before writing code corrected three rows, and the corrections are recorded in the ticket. What follows is the subset that constrains work after this rung.

**Decision 1 — the theme carry-forward rule is enforced by a test that reads source off disk, not by review.**

ADR-0041 leaves one obligation on everything built after it: colours introduced later must read from the active theme. On the web that decays silently — a hard-coded literal renders correctly in whichever theme the author happened to be using, and looks wrong only to somebody else. `theme-tokens.test.ts` therefore reads `.vue` files from the filesystem rather than inspecting a rendered page: happy-dom does not apply stylesheets, and the point is to catch the literal where it was written. It bans colour literals outside the shell's palette, bans `var(--x, fallback)` (a fallback pins one theme's colour in place and nothing looks broken enough to notice), and requires every token used anywhere to be defined by the shell.

**That test first shipped vacuous, and the way it was caught is the part worth keeping.** A plain `indexOf(':root[data-theme="dark"]')` matched the _prose_ in the comment above the selectors and then walked to the next `{`, so all three palette sets read the light block and "dark matches light" was comparing the light block with itself. It could never fail. It was found by deleting a token and watching the suite stay green — not by reading the test. **A check that can pass by reading the wrong bytes is worse than no check: it spends the reader's trust without earning it.** Every rule this test added since is pinned by a deliberate mutation for the same reason.

One relaxation was made under pressure and is worth naming so it is not widened casually: slice F's `--sidebar-width` is a layout value the page sets on itself, and declaring it in the shell's three theme blocks would assert it varies with the theme when it does not. The rule now accepts a custom property the same file also defines. That is looser than a CSS parse, but it can only ever excuse a token the file names on the left of a colon, and a typo'd token still fails.

**Decision 2 — sorting is a display permutation; the real row index travels with the row.**

`sortedRowOrder` returns a permutation of indices, the grid resolves each virtual slot through it, and `result.rows` is asserted byte-identical after a sort. Every rendered row carries `data-row-index` with its **real** index, and every consumer takes `rowIndexFor(virtualIndex)` rather than the display position — the cell viewer already does.

This is a standing constraint on rung 6, not just a slice detail. **Inline cell editing (ADR-0042) must key staged edits on the real index**, or an edit made while sorted will land on a different row than the one clicked. The same class of bug was found and fixed inside this rung: the viewer's sorted-case test was written against a descending sort, which for that fixture is the identity permutation, so the case was vacuous and a mutation to the display index survived it.

Two ordering choices are pinned because they are the kind that get "simplified" later. Numeric order reproduces Rust's `f64::total_cmp` by reinterpreting the double's bits as a sign-magnitude integer — `<` leaves NaN incomparable and calls `-0 < 0` false, so a comparator built on it returns 0 for those pairs and the sort may place them anywhere. Strings compare by UTF-16 code unit and deliberately **not** `localeCompare`: the same result must not sort two ways on two machines.

**Decision 3 — an error shows both halves, and the English half is a static `?raw` import.**

ADR-0039's pair is the message the reader can read and the English one they can search. Before this slice, five surfaces each assembled `prefix: message` by hand with their own copy of the banner CSS, and the English half existed nowhere: an error a user could not read was also an error they could not look up.

The English half is a static import of `en.json`, not `t(key, { locale: "en" })`, because `i18n.lazy` is on and on a Japanese session the English bundle may not be in memory — a half that is sometimes the sentence and sometimes the raw key is worse than no half. That import must be `?raw`: @nuxtjs/i18n compiles locale files into vue-i18n message AST nodes, so a plain JSON import yields objects and interpolating one gives `[object Object]`. The first version shipped exactly that. Only the prefix is translated; the body is the engine's own wording, and translating it would mean inventing wording for someone else's error.

**Decision 4 — ADR-0083 is mirrored in half, and the other half is dropped rather than ported.**

ADR-0083 bundles two unrelated things: a draggable sidebar divider (decisions 1-5) and a DOM-free popover placer, `placePopover`, re-run on resize (decisions 6-7). **Web has no toolbar-anchored popover to place.** `CellViewer` is a centered modal, `ResultGrid`'s only absolute positioning is a `.visually-hidden` utility, and the history is a docked column. Porting `placePopover` would have produced a tested module with no consumer, which reads as parity while proving nothing.

The divider half is mirrored whole, including the two decisions that look like details and are not: the _chosen_ width is stored unclamped and the _applied_ width derived from it, so a window that shrinks and grows again returns to what the user asked for; and the minimum width wins over the viewport cap, because a sidebar clamped to nothing on a narrow window is worse than one that overflows.

**Consequences.**

- Any new `.vue` file with a colour literal, a `var()` fallback, or an undefined token fails the suite. That is intended to be annoying at the moment it happens rather than discovered by a user on the other theme.
- Rung 6's write paths inherit a constraint (real row index) and, from rung 2, a second one (a startup-packet `statement_timeout` applies to writes too).
- `ErrorBanner.vue` is the only place an error renders. New surfaces get both halves by using it and lose them by hand-rolling.
- One row of the ledger is marked done with half of it deliberately absent. **Re-deriving a rung can shrink it, not only grow it** — the row records why, so the next session does not re-derive the same drop.

**Reversibility.** All six slices are additive and self-contained. The one with a standing implication is Decision 2: nothing fails if a future consumer takes the display index, which is precisely why `rowIndexFor` is the only accessor and why the viewer's case is pinned against an ascending sort, where the two indices disagree.

**Cross-references.**

- Desktop: ADR-0041, ADR-0035, ADR-0048, ADR-0082, ADR-0039, ADR-0083 in `dbboard/docs/decisions.md`; ported source read directly from `dbboard-core/src/sort.rs`, `dbboard-ui` `SortState`, and `apps/desktop/src/lib/grid/edit.ts`.
- Ticket: [`issues/0025-grid-and-ux-parity.md`](./issues/0025-grid-and-ux-parity.md) — per-slice log, including the mutations each slice was checked with. Ledger: [`parity-ledger.md`](./parity-ledger.md) rung 3.

## 2026-08-05 — Schema depth: a second column type, and a flag that has to be per connection to mean anything

**Context.** Ticket [`0026`](./issues/0026-schema-depth.md), rung 4 of [`parity-ledger.md`](./parity-ledger.md) — desktop ADR-0028 (`describe_table`), ADR-0031 (inspect a table's columns), ADR-0072 (identifier dialect). Re-deriving the three rows before writing code moved two of them off the rung entirely: ADR-0072 to rung 7 and ADR-0028's AI half (Decisions 8-9) to rung 8, both for reasons recorded in the ticket. It also surfaced a prerequisite no ADR could have named. What follows is the subset that constrains work after this rung.

**Decision 1 — introspection gets its own column type; the wire's `Column` is not widened.**

Desktop keeps two: `Column` in `row.rs` for query results and `ColumnInfo` in `schema.rs` for introspection. ADR-0028 widened the second and left the first alone. Web had mirrored only `Column` — and `Column` is on the shared wire, pinned by `docs/api-contract.md § Column`, which is drafted desktop-side and mirrored here byte-for-byte (ADR-0004).

Adding `nullable` and `primary_key` to it would therefore have been a contract change to `QueryResult`, negotiated across repos, for a field that cannot be filled in: **a query result genuinely has no primary key to report.** `SELECT 1 AS x` has a column named `x` that belongs to no table. So rung 4 added `TableSchema` and a separate `ColumnInfo` alongside, matching desktop's split rather than collapsing it. `docs/api-contract.md` is untouched across the whole rung, verified by `git diff`.

**Decision 2 — capabilities are answered per connection, because otherwise flipping a flag is invisible.**

This is the part the ledger could not have contained, and it is the more useful half of the rung.

`GET /capabilities` resolves the **bootstrap** adapter — the one built from `DATABASE_ADAPTER` at startup. Every real connection lives in the registry and carries its own adapter, created by `POST /connections`. So setting `has_describe_table: true` on `PostgresAdapter` would have changed nothing anyone could observe: the only capabilities route in existence reports a different adapter, usually the null one. The flag would have been true in the code and false at every surface that could read it.

Desktop does not have this problem, and that is why no ADR mentions it: desktop has one backend at a time, swapped via `swap_backend` (ADR-0020), so "the adapter" is unambiguous. Web's per-connection registry is a divergence rung 0 already recorded — the consequence just landed four rungs later. `GET /connections/:id/capabilities` is therefore a prerequisite of the rung, not an extra on it.

**The generalisation, and it applies to every remaining rung: re-deriving a row means asking not only "is this still true of desktop and of web?" but "what does web have to already be true for this to be visible?"** Rungs 1-3 each corrected a row's _content_. This one added a slice that no row implied, and the reason lived in web's divergences from desktop rather than in any ADR.

**Decision 3 — table and schema names travel as query parameters, not path segments.**

A Postgres identifier may legally contain `/`, `%`, `?` and `#`. All four survive a path segment only if every hop percent-encodes correctly and nothing along the way normalises. Nothing breaks when it works, and nothing checks that it did — a table named `a/b` failing to open is a bug that surfaces against exactly one user's schema and nobody else's. The query string makes those characters ordinary. `/tables/:name/columns` would also have under-named the response, which is a `TableSchema`, not a column collection.

Related, and pinned by test rather than by comment: `describeTable` **binds** `$1`/`$2` rather than interpolating the identifiers, and rung 2's text-format invariant still holds on that path. Ticket 0024 pinned the _result format_, not the protocol — a bound query takes pg's extended path, and pg-protocol writes result format code `0` (text) unless `binary: true` is passed. `still refuses a binary reply on the bound path (ADR-0070)` keeps the guard enforced where it would otherwise be assumed.

**Decision 4 — the shallow path is kept, and absence is rendered as "not told", never as "no".**

The `LIMIT 0` probe was not replaced. It needs no capability at all — the result set's own `columns[]` metadata is the answer — so it is the only thing that works against an adapter that cannot introspect, and it keeps the sidebar useful on every driver web will ever add.

Keeping two paths makes the optional fields load-bearing. `nullable`, `primary_key` and `default_value` are optional on `ColumnInfo` rather than defaulted, and `SchemaBrowser.vue` reads `undefined` as unknown: a column on the shallow path shows **no badge**, not "nullable, no key". Defaulting them would have been a confident claim about a table that was never inspected, and it would have looked correct in every screenshot. A test asserts the absence.

The two failure modes are deliberately asymmetric. A failed **probe** degrades to `LIMIT 0` — the shallow path still works, and showing nothing because a metadata request failed is a worse answer than showing less. A failed **describe route** propagates — that route was chosen because this connection advertises it, so its error is the real one, and a `LIMIT 0` retry would restate "relation does not exist" less clearly and cost a round trip. Both are tested.

**Consequences.**

- The first rung-0 capability flag is true, and true at a surface that can read it. Rung 6 sets the next ones and now has the per-connection route it will need.
- `useSchemaBrowser` probes lazily and memoises the **promise**, not the answer, so two tables expanded in the same tick share one probe. Mount still issues exactly one request.
- Anything added to `ColumnInfo` later must stay optional or explain why it can be answered on both paths. The badge rule is the reason: a required field forces the shallow path to invent a value.
- ADR-0031 is closed on the depth, not on a tab. Web's docked sidebar already expands a table inline and works on a phone; a Structure tab beside Results would duplicate a working surface with a worse one. **A later rung should not "finish" ADR-0031 by adding one.**

**Reversibility.** Every slice is additive: a new domain type, an optional port method, two new routes, one branch in the composable. Nothing existing changed shape. The one standing implication is Decision 1 — widening `Column` later is still possible, but it becomes a cross-repo contract change rather than a local edit, which is the intended cost.

**Cross-references.**

- Desktop: ADR-0028, ADR-0031 in `dbboard/docs/decisions.md`; the two-type split read directly from `crates/dbboard-core/src/row.rs` and `src/schema.rs`. ADR-0028 ships with no HTTP route (`describe_table` is absent from `crates/dbboard-server`), so web's route is a unilateral surface and no handoff is owed.
- Ticket: [`issues/0026-schema-depth.md`](./issues/0026-schema-depth.md) — the survey corrections in full. Ledger: [`parity-ledger.md`](./parity-ledger.md) rung 4.

## 2026-08-05 — The connection form: a default that was worse than a missing control, and two ADRs that were right not to be mirrored

**Context.** Ticket [`0027`](./issues/0027-connection-form.md), rung 5 of [`parity-ledger.md`](./parity-ledger.md) — desktop ADR-0073 (parts, not a hand-written DSN), ADR-0078 / 0079 (TLS as a form choice), ADR-0080 (the edit form asks what the add form asks), ADR-0074 (unsupported kinds disabled rather than refused). Re-deriving the four rows before writing code changed all four, and one of the corrections was a live security divergence the ledger did not record. What follows is the subset that constrains work after this rung.

**Decision 1 — the adapter is hardened before the form gains a control, not after.**

`resolvePostgresPoolOptions` defaulted an unspecified `sslmode` to `prefer`, and `prefer` resolved to `ssl: false`. Web therefore attempted no TLS at all unless the host ended in `.neon.tech` or `.supabase.co`, or the caller wrote `sslmode=require` by hand — on a client whose two named providers are hosted Postgres reached over the internet.

That makes the obvious slice order wrong. ADR-0078 Decision 3 says `require` should emit **no** query parameter, because the adapter's hardening supplies the mode. Web had no hardening to lean on, so mirroring that decision first would have shipped a select whose default option reads **Required** over a plaintext connection — a control that reports the opposite of what it does, which is worse than the missing control it replaces. Slice A landed first for that reason, and every later slice's honesty rests on it.

`hardenSslMode` lives in `domain/ssl-mode.ts`, not beside the Postgres adapter: `AdapterConfig` is a usecase-layer type and must not import infrastructure (§9), and the rule is not Postgres-specific — desktop applies the same one to MySQL.

**Decision 2 — an explicit `disable` outranks a host-suffix guess, on every host.**

`SSL_REQUIRED_HOST_SUFFIXES` used to force TLS on Neon and Supabase _including over an explicit opt-out_. Once the default is `require`, that override is the only thing the list can still do, and it is the one thing it should not: a user who typed `sslmode=disable` said something, and a suffix match did not. The list is gone, and the two tests that pinned the old behaviour were rewritten with a note rather than deleted (§7).

The two spellings are validated differently on purpose. The `sslMode` **field** rejects `prefer`; a `sslmode` inside a pasted **URL** is merely hardened up to `require`. A field is a claim about which option the select was on, and the select has no such option; libpq's vocabulary keeps working where libpq's conventions apply.

**Decision 3 — two of the four ADRs are `n/a`, and that is the finding, not an omission.**

ADR-0073 composes a DSN in the frontend, with percent-encoding and IPv6 bracketing "in one place, under test", **because sqlx offers no parts-shaped path**. Web's resolver has had a split-fields branch since 0004 that hands `host` / `port` / `user` / `password` / `database` to `pg.Pool` individually. Sending parts as parts means no DSN is assembled from user input at all, so the failure ADR-0073 exists to handle — a password containing `@`, `/`, `#` or `?` cutting the authority at the wrong character — **cannot occur** rather than being handled correctly. Porting `composeDsn` would have been building the bug in order to solve it.

ADR-0074 governs kinds declared in `connections.toml` that have no in-app form. Web has no `connections.toml`, no keyring, and no kind whose credential cannot be typed. Its transferable half was a real defect: the driver `<select>` restated `postgres` and `null` in the template while `StaticAdapterFactory` owned the list, so adding a driver hid it and offering a missing one produced a 404 banner **on submit** — exactly the "correct rule, wrong presentation" ADR-0074 removes.

**Decision 4 — the driver list is a route, not a shared constant.**

Slice E could have exported the list from a package both sides import, which is how the two copies of `hardenSslMode` are kept honest. That works for a **rule**. It does not work here, because the question is not "what does the vocabulary say" but "what can _this running server_ build". A constant compiled into the browser bundle answers the first and only looks like it answers the second — it goes stale the moment an API deploy adds a driver, which is the drift the slice removes. So the browser asks: `GET /connections/drivers`, nested under the already-unilateral `/connections/*` prefix so the contract stays at a zero diff.

Consequently `Driver` is now `string`, not `"postgres" | "null"`. A union was a closed-world claim the browser is not in a position to make: the API can gain a driver without the web being rebuilt, and the compiler would then reject a value the server had just called valid. And an unloadable list **disables the form** rather than falling back to `["postgres"]` — a fallback puts an option in front of the user that this build may not support, which is the same defect in a smaller font.

**Decision 5 — the password is unrepresentable, not filtered.**

Web was blocked from prefilling an edit form for precisely desktop's reason: nothing remembered the host. `RegisterConnection` destructured the config and dropped it, which 0004 chose deliberately and pinned with a `GET /connections` leak test.

Desktop's answer transfers intact, including the part that makes it safe: a parts type **with no password field and no connectionString field**, so a prefill payload built from it cannot leak one by oversight, because there is nowhere to put one. The split-fields branch cannot read a credential even if handed one. Only the URL branch discards anything, and it discards everything it is not explicitly asked for. A filter over a wider shape was the alternative, and it fails the first time someone adds a field to the record and forgets the filter.

Parts are `undefined`, not `{}`, when there are none — a `null`-driver connection has no address, and an empty object claims there is a connection to describe with nothing in it. Parts also mirror the resolver's precedence exactly, and have to: a prefilled form that resolved the conflict differently would describe a connection nobody made.

**Decision 6 — no keyring, so the rebuild starts from the adapter and answers with an adapter.**

Desktop's `dsn_with_stored_password` (ADR-0080 decision 3) asks the OS keyring and grafts the password on inside the Rust process. Web has no keyring: the only copy of a live connection's credential is inside the adapter serving it. So `AdapterFactory` gained `rebuild(previous, driver, config)`, delegating for postgres to `PostgresAdapter.rebuildWith`, which returns **a successor adapter, never a secret**. The credential moves from one private field to another and no accessor yields it — the same property ADR-0080 states as "it never crosses into the webview in either direction", reached through different machinery because the storage is different.

`UpdateConnection` builds the replacement before closing the old pool, so an edit the factory refuses costs nothing — least of all the connection being edited.

**Decision 7 — a blank password box means keep, and the form says so.**

The API never sends a credential back, so the box starts empty in edit mode. `carryCredential` reads blank and absent identically: keep. The form therefore emits **nothing at all** for an untouched box, which is the honest spelling of "the user said nothing about it", and the hint under the box states the rule rather than leaving the user to discover it. Removing a credential for good remains a delete and a re-add.

**Decision 8 — one component, two modes, pinned by a test that compares them.**

The acceptance criterion is that the edit form opens with the same inputs the add form renders. A second component satisfies the sentence and loses the point: two copies of the same eleven fields drift, and the one that drifts is the one used less. `ConnectionForm.vue` is mounted in both modes — desktop ADR-0080 decision 5 settles the same way — and the first test in `connection-form.test.ts` compares the rendered `data-testid` sets directly, so divergence fails rather than merely looks wrong.

Two differences are deliberate. The **driver is shown, not offered**: repointing a live id at another engine would keep the label while changing what the connection is. The form still emits it (it is displaying it) and the page drops it before calling `update`, because `PATCH` has no such field. And **resetting belongs to the page**, not the form: only the page knows whether the server accepted, and a `:key` bump would have reset the driver select too — a real regression for anyone registering several connections against one engine.

**Consequences.**

- **TLS is on by default and can only be turned off deliberately.** The integration suite now opts out with `?sslmode=disable`, and that is the feature working, not a workaround for it. `.env.example`, `apps/api/README.md` and the curl example in `0004-postgres-adapter.md` carry the same opt-out.
- `pnpm -r lint` is at zero warnings. `vue/html-self-closing` was set to `void: "any"` because Prettier rewrites `<input>` to `<input />` and the default rule warned about exactly that, so the warning could not be acted on. A rule nobody can satisfy trains people to skip the output.
- Rung 6's write paths inherit a third constraint, alongside the real row index and the startup-packet timeout: **an edit rebuilds the adapter**, so anything caching a connection's adapter instance across requests must survive a swap.
- `/connections/*` remains unilateral. `docs/api-contract.md` has a zero diff across the whole rung — three rungs running.

**Reversibility.** Slices B-G are additive. Slice A is not: it changes what an existing configuration does, which is the point, and it is the one part of this rung that would need a deliberate decision to undo rather than a deletion.

**Cross-references.**

- Desktop: ADR-0073, ADR-0074, ADR-0078, ADR-0079, ADR-0080 in `dbboard/docs/decisions.md`; `harden_ssl_mode` and `dsn_with_stored_password` read directly from the Rust adapters.
- Ticket: [`issues/0027-connection-form.md`](./issues/0027-connection-form.md) — the survey corrections in full, per-slice. Ledger: [`parity-ledger.md`](./parity-ledger.md) rung 5.
