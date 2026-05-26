# 0002 — Monorepo scaffold (Phase 1)

- **Status:** done (2026-05-25)
- **Phase:** 1
- **Opened:** 2026-05-25
- **Closed:** 2026-05-25
- **Branch:** `feature/phase-1-bootstrap`
- **Depends on:** [0001](./0001-web-contract-mirror.md)

## Goal

Stand up the pnpm workspace and empty `apps/api` (NestJS) + `apps/web` (Nuxt 4) so that subsequent issues can land application code against a fully wired toolchain. No business logic yet — the HTTP contract surface ships in issue [`0003`](./0001-web-contract-mirror.md#follow-up-issues-phase-1).

The scaffold is the precondition for everything that follows. It locks in the package manager (pnpm via corepack), the layered project layout (`apps/api/src/{domain,usecase,infrastructure,presentation}`, mirrored where it makes sense in `apps/web`), and the per-commit verification chain (`lint`, `typecheck`, `test`, `build`).

## Tasks

- [x] Root `package.json` with `packageManager` pinned, common scripts (`-r` recursive), and pnpm safety knobs (`onlyBuiltDependencies: []`, `minimumReleaseAge: 1440`).
- [x] `pnpm-workspace.yaml` declaring `apps/*` + `allowBuilds` ACL (esbuild/parcel-watcher/unrs-resolver `true`, `@nestjs/core` `false`).
- [x] `.npmrc` matching the safety knobs (strict-peer-deps, no auto-install-peers, no fund).
- [x] `tsconfig.base.json` shared by both apps (ES2023, strict, noUncheckedIndexedAccess, Bundler resolution).
- [x] `apps/api/` — minimal NestJS 11 app with Vitest, ESLint, layered directory skeleton + a smoke `GET /health` controller.
- [x] `apps/web/` — minimal Nuxt 4 app with Vitest (happy-dom + nuxt environment) and ESLint.
- [x] Root ESLint flat config v9 + Prettier shared via workspace; `.gitattributes` + `.editorconfig` enforce LF.
- [x] Husky 9 `pre-commit` (lint-staged) and `pre-push` (`typecheck` + `lint` + `test` + `build`) hooks.
- [x] `.env.example` placeholder for the variables the API will need.
- [x] `.gitignore` audit: `node_modules`, `.nuxt`, `.output`, `dist`, `coverage`, `.env*` (except `.example`) covered.
- [x] Update [`.claude/project-status.md`](../project-status.md) and [`.claude/roadmap.md`](../roadmap.md) to mark Phase 1 done.

## Definition of Done

Per [`.claude/roadmap.md` Phase 1](../roadmap.md):

- [x] `pnpm install` succeeds from a clean clone (lockfile committed).
- [x] `pnpm -r build` succeeds (Nuxt + NestJS).
- [x] `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` succeed (smoke tests in place).
- [x] Husky pre-commit and pre-push hooks installed and runnable on this machine.
- [x] `corepack` pins the pnpm version via the `packageManager` field.
- [x] No `package-lock.json` or `yarn.lock` anywhere in the tree.

## Verification

```sh
corepack enable
rm -rf node_modules apps/*/node_modules
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
# Hooks
pnpm exec husky --version
ls -la .husky/
```

## Work log

- **2026-05-25** — Issue opened. Branch policy ADR + distribution-model ADR landed in the parent feature branch (`feature/phase-1-bootstrap`) ahead of the scaffold so the README and ADR log explain _why_ the scaffold looks the way it does.
- **2026-05-25** — Scaffold complete on `feature/phase-1-bootstrap`. Notable fixes during bring-up:
  - `pnpm-workspace.yaml allowBuilds` ACL added so install scripts only run for the runtime-required toolchain (esbuild, parcel-watcher, unrs-resolver). `@nestjs/core`'s install-time banner is denied.
  - Root `eslint.config.mjs` imports must be declared at the root (pnpm doesn't hoist into the workspace root) — `@eslint/js` and `typescript-eslint` live in the root `devDependencies`.
  - `apps/api` lint script targets `src/**/*.ts` only (no `test/` directory; tests are colocated).
  - `apps/api/tsconfig.json` sets `incremental: false` — `nest-cli`'s `deleteOutDir: true` together with `tsc --incremental` produced a stale buildinfo claiming "already emitted" with no `dist/` on disk.
  - `docs/api-contract.md` is listed in `.prettierignore` to preserve its byte-identical mirror of the desktop contract.
- **2026-05-25** — Verification chain green: `pnpm install`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build`, `pnpm format:check`.

## Notes

- Stack version policy (`AI_AGENT_RULES.md` §9): "modern, current stacks ... avoid bleeding-edge". Pin majors only (Nuxt 4, NestJS 11, TypeScript 5) and let `pnpm` resolve patch versions inside the configured `minimumReleaseAge` window (24 h quarantine).
- Layout choice: `apps/web` + `apps/api` (pnpm-workspace convention) rather than `frontend/` + `backend/`. The README has been updated to match.
- ESLint flat config (v9+). Prettier as the formatter, not as an ESLint rule.
- The NestJS HTTP surface (the three contract endpoints) belongs in issue `0003`, not here.
