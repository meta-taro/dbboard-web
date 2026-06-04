import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";

// docs/api-contract.md § Request-level rejections says 400 (malformed
// JSON) and 413 (body too large) must be **plain-text** bodies — the
// JSON envelope is reserved for domain errors (`CategorizedError`) and
// validation 422s. Nest's default exception handling wraps every
// HttpException in JSON; body-parser's `PayloadTooLargeError` is a raw
// Error that Nest would surface as 500. This filter intercepts both.
//
// Filter ordering: registered after ContractErrorFilter in main.ts so
// CategorizedError still routes to its dedicated JSON-envelope filter
// (Nest picks the most specific @Catch first). This filter sits as the
// catch-all for everything else.
@Catch()
export class RequestLevelRejectionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    // body-parser surfaces oversized bodies as a `PayloadTooLargeError`
    // with `.type === 'entity.too.large'`. It is *not* an HttpException,
    // so we sniff the property bag instead of the class.
    if (this.isPayloadTooLarge(exception)) {
      response
        .status(413)
        .type("text/plain")
        .send("Payload Too Large — request body exceeds the 64 KiB cap");
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === 400) {
        // The only 400 in this surface today is body-parser's malformed-
        // JSON failure. Validation failures use 422 via ValidationPipe.
        response.status(400).type("text/plain").send("Bad Request — malformed JSON body");
        return;
      }
      // Preserve Nest's default JSON envelope for everything else
      // (422 validation, 404 unknown route, …).
      const body = exception.getResponse();
      response
        .status(status)
        .json(typeof body === "string" ? { statusCode: status, message: body } : body);
      return;
    }

    // Genuine programmer errors (uncaught throws) — Nest's default would
    // be 500 with a generic body. Reproduce that shape so the wire stays
    // predictable; the underlying error is still logged by Nest's
    // ExceptionsHandler upstream of this filter.
    response.status(500).json({ statusCode: 500, message: "Internal Server Error" });
  }

  private isPayloadTooLarge(e: unknown): boolean {
    return (
      typeof e === "object" && e !== null && (e as { type?: unknown }).type === "entity.too.large"
    );
  }
}
