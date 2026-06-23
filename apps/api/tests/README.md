# `apps/api/tests/`

Gated suites **excluded from the default `pnpm test` run** because they
require heavy external prerequisites. Run on demand:

```sh
pnpm conformance   # = pnpm --filter @dbboard-web/api conformance
```

Uses a dedicated `vitest.conformance.config.ts` so the default
`vitest.config.ts` (which scans `src/**` + `test/**`) does not pick
these specs up.

## Why the singular/plural split

| Directory | In default `pnpm test`? | Requires                                      |
| --------- | ----------------------- | --------------------------------------------- |
| `test/`   | yes                     | nothing beyond `pnpm install`                 |
| `tests/`  | no                      | external prerequisites listed per suite below |

Reading the tree, `test/` = "runs every time", `tests/` = "runs when you
ask for it". The asymmetry is deliberate; please don't merge them.

## Suites

### `conformance/`

Desktop ⇔ web contract battery from issue
[`0005`](../../../.claude/issues/0005-row-cap-body-limit-conformance.md).
Boots the desktop Rust binary and an in-process web server side by side
and asserts deep-equal responses against a shared Postgres.

Requires:

- `DBBOARD_SERVER_BIN` — path to the desktop binary (`dbboard-server`).
- A reachable Docker daemon (testcontainers spins up the shared
  Postgres).

Skips cleanly when either gate is absent — local dev without the Rust
toolchain, CI without a daemon, and Windows hosts where `DOCKER_HOST`
is unset all hit the skip gracefully.
