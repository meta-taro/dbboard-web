// Numeric limits shared across layers. They live in the domain layer (not
// bootstrap) so use cases and conformance tests can import them without
// pulling in Nest / express plumbing. The first two are pinned by
// docs/api-contract.md; the third deliberately is not — see below.

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

// The cap on a restore script (0030 slice E), applied to the
// `application/sql` body parser on the two restore routes.
//
// **Not contract-pinned, and not a wire promise.** docs/api-contract.md
// does not describe the restore routes at all — they are a web-only
// surface, because desktop reads the `.sql` file it was pointed at
// (ADR-0051) and has no HTTP boundary to cross. What this number bounds
// is memory: the script arrives as one string and is then split into an
// array of statements, so the peak is roughly two to three times the
// figure below, per concurrent restore.
//
// 16 MiB covers a logical dump of a database of the size this tool is
// meant for while keeping that peak bounded. It is far above the 64 KiB
// query cap on purpose: a dump is not a query, and reusing the contract's
// number here would reject almost every real restore. If the ceiling ever
// binds, the follow-on is a streaming split rather than a bigger constant
// — desktop holds the whole file in a `String` too, so raising this is
// not "catching up" with anything.
export const RESTORE_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
