# Handoff: PWA pivot for dbboard-web — incoming brief (2026-05-26)

Received from desktop (`dbboard` side) via maintainer on 2026-05-26.
Companion to the outgoing brief at
[`2026-05-26-back-to-desktop-phase-2.md`](./2026-05-26-back-to-desktop-phase-2.md).
Translated to English for the OSS repo per
[`../../CLAUDE.md`](../../CLAUDE.md) language policy; original framing
preserved.

## Context (desktop side, 2026-05-26)

Desktop shipped 0.1.0 today. The dev-hardening branch landed via PR #3
(desktop ADR-0011 SemVer + ADR-0012 Capability pattern) merged to
`develop`; release PR #4 merged to `main` as commit `84c08be`. `v0.1.0`
tag is scheduled the same day. Phase 2 work (adapter trait extraction +
Capability implementation + `GET /capabilities`) is queued separately —
a dedicated brief in the `939fe22` format will follow once
`/capabilities` lands. **This brief is independent and strategic, not
blocking on Phase 2.**

## Decision

Strategy for mobile, settled with the maintainer:

- **No native Android / iOS apps.** A separate `dbboard-mobile`
  repository is explicitly _not_ on the roadmap right now.
- **`dbboard-web` is PWA-ified** to absorb mobile demand in a single
  codebase.

## Why

Target use is **ambient, read-mostly, like the GitHub mobile app**:
glance at production signup counts during a meeting, verify a specific
user's order went through, receive an alert from a saved query, kill a
long-running query from a phone. Not "DataGrip shrunk to phone size."

- Read-heavy, short interactions, notification-driven → Flutter + a Rust
  bridge would be overkill. A thin HTTP client over the existing contract
  is enough.
- Aligns with the web-side self-host-only ADR: users install "their own
  self-hosted `dbboard-web` instance" as a PWA on their phone; no managed
  hosting needed.
- Forward-compatible with desktop ADR-0011 (HTTP contract = public API)
  and ADR-0012 (Capability pattern). No breakage on either side.

## Scope (web-side work)

1. Add `apps/web/public/manifest.json` — `name` / `icons` (192×192,
   512×512 maskable) / `start_url` / `display: standalone` /
   `theme_color`.
2. Wire a Nuxt PWA module (`@vite-pwa/nuxt`) — auto-generated service
   worker, precache + an offline fallback page.
3. Install-prompt UI handled non-intrusively (capture
   `beforeinstallprompt`, surface as opt-in, never push).
4. iOS Safari support: `apple-touch-icon`,
   `apple-mobile-web-app-capable`, status-bar style. iOS 16.4+ exposes
   the Web Push API.
5. Mobile-first responsive review — schema sidebar collapse, SQL editor
   vertical layout, results table horizontal scroll, touch targets
   ≥ 44 × 44 px.
6. _(Optional, later)_ Web Push alerts — VAPID key generated locally +
   the `web-push` Node library for self-hosted notifications. No vendor
   lock-in.

## Out of scope (not now)

- Native apps / a `dbboard-mobile` repo — revisit only after PWA demand
  is observable.
- Authentication — PWA installability does not require auth.
- Offline write queue — read-mostly assumption makes this non-essential.

## Acceptance

- [ ] Android Chrome shows "Add to Home Screen" (installability check
      passes).
- [ ] iOS Safari shows the `apple-touch-icon` and launches in standalone
      display mode.
- [ ] Lighthouse PWA score ≥ 90.
- [ ] At mobile viewport 375 × 667, schema browser + results table
      remain usable without layout breakage.
- [ ] Cold start while offline shows the cached UI shell + an explicit
      "offline" message (no white screen).

## Parallel execution

PWA work touches the application shell only, not the HTTP contract.
Therefore it can proceed **in parallel** with the wait on desktop's
`/capabilities` publication (which gates the web-side queued issues
`0003`, `0004`, `0005`).

## Handback

When the PWA shell is installable (top three Acceptance items pass),
send a short report back to desktop. Empirical feedback on whether the
ambient + read-mostly UX actually works on real devices (Android Chrome

- iOS Safari) is also welcome — that evaluation determines whether
  "native is still needed" or "PWA is enough" gets locked in.

## Tech recommendations (reference, not prescriptive)

- `@vite-pwa/nuxt` — Nuxt 4 compatible, thin wrapper over the Vite
  plugin, Workbox-backed.
- `@vite-pwa/assets-generator` — generate all icon sizes from a single
  SVG.
- Push: VAPID + `web-push` for self-hosted delivery (optional, later
  phase).
