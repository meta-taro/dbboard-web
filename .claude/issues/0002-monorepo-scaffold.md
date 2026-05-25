# 0002 — Monorepo scaffold (Phase 1)

- **Status:** in-progress
- **Phase:** 1
- **Opened:** 2026-05-25
- **Depends on:** [0001](./0001-web-contract-mirror.md)

## Goal

Stand up the pnpm workspace and empty `apps/api` (NestJS) + `apps/web` (Nuxt 4) so that subsequent issues can land application code against a fully wired toolchain. No business logic yet — the HTTP contract surface ships in issue [`0003`](./0001-web-contract-mirror.md#follow-up-issues-phase-1).

The scaffold is the precondition for everything that follows. It locks in the package manager (pnpm via corepack), the layered project layout (`apps/api/src/{domain,usecase,infrastructure,presentation}`, mirrored where it makes sense in `apps/web`), and the per-commit verification chain (`lint`, `typecheck`, `test`, `build`).

## Tasks

- [ ] Root `package.json` with `packageManager` pinned, common scripts (`-r` recursive), and pnpm safety knobs (`onlyBuiltDependencies: []`, `minimumReleaseAge: 1440`).
- [ ] `pnpm-workspace.yaml` declaring `apps/*`.
- [ ] `.npmrc` matching the safety knobs (strict-peer-deps, etc.).
- [ ] `tsconfig.base.json` shared by both apps.
- [ ] `apps/api/` — minimal NestJS 11 app with Vitest, ESLint, layered directory skeleton.
- [ ] `apps/web/` — minimal Nuxt 4 app with Vitest and ESLint.
- [ ] Root ESLint + Prettier config shared via workspace.
- [ ] Husky `pre-commit` (lint-staged: lint + typecheck + tests on staged files) and `pre-push` (full `pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test`) hooks.
- [ ] `.env.example` placeholder for the variables the API will need.
- [ ] `.gitignore` audit: ensure `node_modules`, `.nuxt`, `dist`, `coverage`, `.env*` (except `.example`) are covered.
- [ ] Update [`.claude/project-status.md`](../project-status.md) and [`.claude/roadmap.md`](../roadmap.md) to mark Phase 1 done.

## Definition of Done

Per [`.claude/roadmap.md` Phase 1](../roadmap.md):

- [ ] `pnpm install` succeeds from a clean clone (lockfile committed).
- [ ] `pnpm -r build` succeeds (Nuxt + NestJS).
- [ ] `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` succeed (empty test suites allowed).
- [ ] Husky pre-commit and pre-push hooks installed and runnable on this machine.
- [ ] `corepack` pins the pnpm version via the `packageManager` field.
- [ ] No `package-lock.json` or `yarn.lock` anywhere in the tree.

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

- **2026-05-25** — Issue opened. Branch policy ADR + distribution-model ADR landed in the parent feature branch (`feature/phase-1-bootstrap`) ahead of the scaffold so the README and ADR log explain *why* the scaffold looks the way it does.

## Notes

- Stack version policy (`AI_AGENT_RULES.md` §9): "modern, current stacks ... avoid bleeding-edge". Pin majors only (Nuxt 4, NestJS 11, TypeScript 5) and let `pnpm` resolve patch versions inside the configured `minimumReleaseAge` window (24 h quarantine).
- Layout choice: `apps/web` + `apps/api` (pnpm-workspace convention) rather than `frontend/` + `backend/`. The README has been updated to match.
- ESLint flat config (v9+). Prettier as the formatter, not as an ESLint rule.
- The NestJS HTTP surface (the three contract endpoints) belongs in issue `0003`, not here.
