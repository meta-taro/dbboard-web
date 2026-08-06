import type { NextFunction, Request, Response } from "express";

// Per docs/api-contract.md § Request-level rejections: a request that
// carries a non-JSON body must be rejected with 415 _before_ the JSON
// parser runs. body-parser's default behavior on a mismatched
// Content-Type is to silently skip parsing, which would surface the
// request to the DTO layer with an empty body and yield a 422 — wrong.
//
// This middleware short-circuits POST/PUT/PATCH with a missing or
// non-JSON Content-Type. GET / DELETE / HEAD / OPTIONS are body-less in
// the contract, so we let them through unconditionally.
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

// The one exemption (0030 slice E): a restore posts a `.sql` script as its
// body, so those two routes also accept `application/sql`. Matched on the
// exact path rather than a substring so nothing else — `/restore/all`, a
// future `/restore/history` — inherits a second media type by accident.
//
// This surface is web-only and not described by docs/api-contract.md, which
// is why widening the guard here does not touch the contract: desktop reads
// the file it was pointed at and never crosses HTTP (ADR-0051).
const SQL_BODY_PATHS = /^\/connections\/[^/]+\/restore(\/plan)?\/?$/;

export const SQL_MEDIA_TYPE = "application/sql";

export function contentTypeGuard(req: Request, res: Response, next: NextFunction): void {
  if (!BODY_METHODS.has(req.method)) {
    next();
    return;
  }
  const header = req.headers["content-type"];
  const mediaType =
    typeof header === "string" ? header.split(";")[0]?.trim().toLowerCase() : undefined;

  if (mediaType === "application/json") {
    next();
    return;
  }
  if (mediaType === SQL_MEDIA_TYPE && SQL_BODY_PATHS.test(req.path ?? "")) {
    next();
    return;
  }

  const expected = SQL_BODY_PATHS.test(req.path ?? "")
    ? `application/json or ${SQL_MEDIA_TYPE}`
    : "application/json";
  res.status(415).type("text/plain").send(`Unsupported Media Type — expected ${expected}`);
}
