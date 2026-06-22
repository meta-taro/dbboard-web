import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Bearer-auth middleware — issue 0016.
//
// When the secret is undefined the middleware is a no-op so `pnpm dev`
// keeps working without configuration; the bootstrap refuses to bind to
// a non-loopback address in that mode (see assertSafeBindConfig), so the
// no-op path is only reachable on 127.0.0.1.
//
// GET /health is exempt unconditionally so liveness probes (and the
// reverse proxy's upstream health check) do not need the secret.

const LIVENESS_EXEMPT_PATHS = new Set(["/health"]);

export function createBearerAuthMiddleware(
  secret: string | undefined,
): (req: Request, res: Response, next: NextFunction) => void {
  if (secret === undefined) {
    return (_req, _res, next) => next();
  }

  const secretBuf = Buffer.from(secret, "utf8");

  return (req, res, next) => {
    if (req.method === "GET" && LIVENESS_EXEMPT_PATHS.has(req.path)) {
      next();
      return;
    }

    const header = req.headers["authorization"];
    if (typeof header !== "string") {
      reject(res);
      return;
    }

    const match = /^bearer\s+(.+)$/i.exec(header);
    if (match === null) {
      reject(res);
      return;
    }

    const token = match[1]!.trim();
    if (token.length === 0) {
      reject(res);
      return;
    }

    const tokenBuf = Buffer.from(token, "utf8");
    // timingSafeEqual throws on length mismatch; short-circuit first.
    if (tokenBuf.length !== secretBuf.length || !timingSafeEqual(tokenBuf, secretBuf)) {
      reject(res);
      return;
    }

    next();
  };
}

function reject(res: Response): void {
  res.status(401).type("text/plain").send("Unauthorized");
}
