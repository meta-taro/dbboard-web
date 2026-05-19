# AI Agent Rules

Rules for AI coding agents (Claude Code, Cursor, Cline, etc.) and human contributors working on **dbboard-web**.

These rules apply to every change in this repository.

## 1. Development flow (TDD)

1. **Add a failing test first** before changing behavior.
2. Write the **minimal implementation** that makes the test pass.
3. **Refactor** while keeping tests green.
4. **Commit per phase** in small, reviewable steps.

If a change does not warrant a test, justify it in the commit message.

## 2. Package manager

- **Use pnpm.** `npm` and `yarn` are forbidden.
- Never create or commit `package-lock.json` or `yarn.lock`.
- All setup steps in `README.md` and scripts must be expressed in pnpm.
- Pin the pnpm version via the `packageManager` field in the root `package.json` and rely on `corepack`.

## 3. Architecture (layering)

Keep business logic out of controllers and API routes. Organize each app along these layers:

| Layer | Responsibility |
|---|---|
| `domain` | Business rules, entities, value objects |
| `usecase` | Application orchestration (workflows, transaction scripts) |
| `infrastructure` | DB, external APIs, file I/O, mail |
| `presentation` | Controllers, API routes, view rendering |
| `tests` | Unit and integration tests |

- Controllers and API routes are **thin** — they translate transport concerns into use case calls.
- Domain code must not import from `infrastructure` or `presentation`.

### dbboard-web specifics

- AI features live in a separate module (`backend/src/modules/ai/`) and must remain optional.
- Core database features must work with the AI module disabled.
- The frontend never talks to a database directly — always via the NestJS API.

## 4. Code quality

### Readability

- Functions and classes have a single, narrow responsibility.
- Names express intent (variables, functions, files, types).
- Add a comment when a conditional or workaround would surprise the next reader.

### Comments

- Explain **why**, not what — the code already says what.
- Document non-obvious constraints, invariants, and workarounds.
- Mark temporary code or compromises as `TODO:` with the reason.

## 5. Testing

### Required stacks

- **Frontend (Nuxt / TypeScript):** Vitest, Vue Testing Library / Nuxt Test Utils, Playwright (E2E), Storybook (component states).
- **Backend (NestJS):** Vitest or Jest, supertest for HTTP, Testcontainers for integration tests against real databases.

### When to add tests

Always add tests when introducing:

- New domain logic, branches, or validations.
- Changes to API responses or error handling.
- Bug fixes — write a regression test that fails on the buggy code first.

If no test is appropriate, justify it in the commit message.

### Pre-commit minimum

```sh
pnpm lint && pnpm typecheck && pnpm test:run
```

## 6. Git workflow

### Commits

- **AI authors commits, humans push.** Never run `git push` from an AI agent unless explicitly asked.
- Small commits per phase. The diff should be reviewable in one sitting.
- Conventional Commits format:

  ```
  <type>: <imperative summary>

  <body explaining motivation and notable details>
  ```

  Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

- Before committing, run format, lint, typecheck, and unit tests. Review the diff.

### Before push (human responsibility)

- The app actually runs locally.
- No stray or unrelated file changes.
- README and docs match the implementation.
- Full test suite is green.
- No secrets or credentials in the diff.
- Commit granularity is appropriate (squash if needed).

### Hooks (added during tooling setup)

- **pre-commit** (husky + lint-staged): format, lint, typecheck, unit tests on staged files.
- **pre-push**: build, storybook build, full test run.

## 7. Documentation

### README

- pnpm-based setup steps.
- Environment variables (matching `.env.example`).
- Local run, test, and build commands.
- Updated in the same commit as any behavior change it describes.

### File layout

```
CLAUDE.md            # Entry point for AI agents (overview + pointers)
AI_AGENT_RULES.md    # This file — detailed rules
DESIGN.md            # UI / design specification
README.md            # Project entry for humans
docs/                # Design references and deeper documents
.claude/
  project-status.md  # Current phase, completed work, open items
  roadmap.md         # Phases and completion criteria
  decisions.md       # Technical decisions and rationale
  issues/
    NNN-<slug>.md    # Work tickets
```

### Issue file format (`.claude/issues/NNN-<slug>.md`)

Each work ticket includes:

1. **Goal** — what is being achieved and why.
2. **Tasks** — concrete steps.
3. **Definition of Done** — checklist of completion criteria.
4. **Verification commands** — exact commands to confirm DoD.
5. **Work log** — actions taken and results, appended as the work progresses.

## 8. Design

The design system is captured in [DESIGN.md](./DESIGN.md) and covers:

- Visual direction and tone.
- Color palette.
- Layout (spacing, sizes, radii).
- Typography (font families and scale).
- UI patterns (buttons, cards, forms).
- Responsive strategy.

Update `DESIGN.md` before introducing new visual patterns. The UI must stay simple and fast — prefer plain components over decorative cards, gradients, or unnecessary animation.

## 9. Technology selection

- Choose **modern, current stacks** that match real-world job postings and active OSS projects.
- Avoid **bleeding-edge or rapidly breaking** dependencies.
- Audit `package.json`, `Dockerfile`, and other manifests for stale pinned versions during major changes.

## 10. Local development

- Provide `.env.example` with every required variable.
- Local development must work without proprietary or paid external services where possible.
- Provide pnpm scripts for the common workflow: `dev`, `build`, `test`, `lint`, `typecheck`, `format`.
- Git hooks should be installed via `pnpm install` (husky `prepare` script).
- Document local DB options (Neon branch, Supabase local stack, libSQL embedded) per provider.

## 11. Security

When introducing external resources or dependencies:

- Audit the dependency for known issues (`pnpm audit`, advisory databases).
- Confirm no unexpected outbound network traffic at runtime.
- Keep API keys and secrets in environment variables — never in source.
- Review GitHub Actions workflows for unsafe inputs (e.g., `pull_request_target` with checkout of untrusted refs).
- Confirm license compatibility.

Use `pnpm` safety knobs in the root `package.json`:

```json
"pnpm": {
  "onlyBuiltDependencies": [],
  "minimumReleaseAge": 1440
}
```

## 12. Initial phase checklist

When bootstrapping or restarting major work:

1. Generate or update the roadmap before implementation.
2. Confirm stack and directory layout.
3. Split work into phases with explicit completion criteria.
4. Decide test, CI, and git hook policy upfront.
5. Update `AI_AGENT_RULES.md` and `.claude/*` to match reality.

## 13. Language

- All files in this repository are written in **English**.
- This includes markdown, code comments, commit messages, PR titles and bodies, and configuration comments intended for external readers.
- The only sanctioned exceptions are direct maintainer↔assistant dialogue and personal scratch files (e.g., comments inside `.gitignore`) where the maintainer prefers Japanese.
