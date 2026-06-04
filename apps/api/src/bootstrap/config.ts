// Seam for the per-request body cap. 0003 ships the cap so the
// surrounding plumbing (415 / 413 mapping) is exercised end-to-end;
// 0005 lowers (or confirms) the production value alongside the
// row-cap conformance test. Override via DBBOARD_API_MAX_BODY_BYTES
// for local experimentation only — do not commit non-contract values.
export const MAX_BODY_BYTES = Number.parseInt(
  process.env.DBBOARD_API_MAX_BODY_BYTES ?? `${64 * 1024}`,
  10,
);
