# `apps/api/test/`

Integration tests that need a running Nest app, an HTTP layer, or a real
database. Heavy enough that we don't co-locate them next to `src/` (where
`*.spec.ts` unit tests live, per the Nest convention).

Included in the default `pnpm test` glob via `vitest.config.ts`:

```ts
include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
```

The sibling directory [`../tests/`](../tests/README.md) is intentionally
**excluded** from that glob — see its README for why.

## Files

- `auth.integration.spec.ts` — bearer auth + localhost-bind end-to-end
  through the Nest app (issue 0016).
- `http-contract.spec.ts` — HTTP contract assertions against the
  in-process server.
- `postgres-integration.spec.ts` — real Postgres via testcontainers
  (issue 0004 follow-ups).
- `desktop-history-roundtrip.spec.ts` — cross-implementation byte
  equivalence with desktop's `RecordWire` serialiser (issue 0018).
- `fixtures/` — shared test data; see
  [`fixtures/README.md`](./fixtures/README.md).
