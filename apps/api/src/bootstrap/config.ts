import { QUERY_BODY_LIMIT_BYTES } from "../domain/limits";

// Seam for the per-request body cap. The canonical value lives in
// domain/limits.ts (QUERY_BODY_LIMIT_BYTES = 64 KiB, pinned by
// docs/api-contract.md). DBBOARD_API_MAX_BODY_BYTES is a local
// experimentation override only — do not commit non-contract values.
export const MAX_BODY_BYTES = Number.parseInt(
  process.env.DBBOARD_API_MAX_BODY_BYTES ?? `${QUERY_BODY_LIMIT_BYTES}`,
  10,
);
