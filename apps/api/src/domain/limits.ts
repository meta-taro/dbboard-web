// Contract-level numeric limits. Both values are pinned by
// docs/api-contract.md — they live in the domain layer (not bootstrap)
// so the use case and the conformance test can import them without
// pulling in Nest / express plumbing.

// Per docs/api-contract.md: "Each adapter caps a single query at 10,000
// rows. A statement that would return more is rejected with a `query`
// error (status 400) so the UI never silently shows a truncated grid."
// Enforced in ExecuteQuery (use case layer) so no adapter can forget.
export const ROW_CAP = 10_000;

// Per docs/api-contract.md § Request-level rejections: a body above
// 64 KiB on POST /query (and POST /connections/:id/query) is rejected
// with 413 plain text before any handler runs. Applied in the bootstrap
// layer to body-parser; the env-var override in bootstrap/config.ts is
// strictly for local experimentation.
export const QUERY_BODY_LIMIT_BYTES = 64 * 1024;
