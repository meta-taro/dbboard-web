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

export function contentTypeGuard(req: Request, res: Response, next: NextFunction): void {
  if (!BODY_METHODS.has(req.method)) {
    next();
    return;
  }
  const header = req.headers["content-type"];
  if (
    typeof header === "string" &&
    header.split(";")[0]?.trim().toLowerCase() === "application/json"
  ) {
    next();
    return;
  }
  res.status(415).type("text/plain").send("Unsupported Media Type — expected application/json");
}
