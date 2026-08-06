import "reflect-metadata";
import { HttpStatus, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { API_SECRET, BIND_HOST, MAX_BODY_BYTES, assertSafeBindConfig } from "./bootstrap/config";
import { SQL_MEDIA_TYPE, contentTypeGuard } from "./bootstrap/content-type.middleware";
import { RESTORE_BODY_LIMIT_BYTES } from "./domain/limits";
import { ContractErrorFilter } from "./presentation/filters/contract-error.filter";
import { RequestLevelRejectionFilter } from "./presentation/filters/request-level-rejection.filter";
import { createBearerAuthMiddleware } from "./presentation/middleware/bearer-auth.middleware";

export interface CreateAppOverrides {
  // Test-only seam: lets the integration suite inject a known secret
  // without juggling process.env across test files (vi.resetModules
  // does not reliably re-evaluate config.ts when other specs share the
  // worker). Production paths pass nothing and resolve from env.
  apiSecret?: string;
}

export async function createApp(overrides?: CreateAppOverrides): Promise<NestExpressApplication> {
  const secret = overrides?.apiSecret ?? API_SECRET;
  // bodyParser: false + app.useBodyParser — the seam 0003 needs.
  // Routes the 64 KiB cap (and the value 0005 will lock in) through a
  // single configurable hook rather than NestFactory's default 100 KiB
  // limit. Keeps express off the dependency surface.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.use(contentTypeGuard);
  // Bearer-auth gate (issue 0016). Runs after the content-type guard so
  // a malformed POST still surfaces 415 rather than 401, but before any
  // controller logic so unauthenticated SQL bodies never reach the
  // recording interceptor.
  app.use(createBearerAuthMiddleware(secret));
  app.useBodyParser("json", { limit: MAX_BODY_BYTES });
  // The restore body (0030 slice E). A second parser rather than a wider
  // first one: it only claims `application/sql`, so the contract's 64 KiB
  // cap on every JSON body stays exactly where it is, and a restore script
  // gets its own far larger ceiling. `RESTORE_BODY_LIMIT_BYTES` is not
  // contract-pinned — see domain/limits.ts for why.
  app.useBodyParser("text", { type: SQL_MEDIA_TYPE, limit: RESTORE_BODY_LIMIT_BYTES });
  // class-validator failures → 422 (semantic). Malformed JSON falls
  // through to express.json's default 400; oversized bodies surface as
  // 413 via PayloadTooLargeError. The ContractErrorFilter is for
  // domain CategorizedError envelopes, not request-level rejections.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    }),
  );
  // Nest evaluates global filters LIFO (last registered = first matched),
  // so list the catch-all first and the specific filter last:
  //   - RequestLevelRejectionFilter (@Catch()): plain-text 400 / 413,
  //     pass-through JSON for 422 / 404, generic 500 for uncaught.
  //   - ContractErrorFilter (@Catch(CategorizedError)): JSON envelope
  //     for domain errors. Wins for any CategorizedError because Nest
  //     picks the most-recently-registered matching filter first.
  app.useGlobalFilters(new RequestLevelRejectionFilter(), new ContractErrorFilter());
  return app;
}

async function bootstrap(): Promise<void> {
  // Fail-fast: refuse to bind to a non-loopback address without an API
  // secret (issue 0016). Couples network exposure to authentication so
  // an exposed-but-unauthenticated misconfiguration cannot reach
  // `app.listen`.
  assertSafeBindConfig({ bindHost: BIND_HOST, apiSecret: API_SECRET });
  const app = await createApp();
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, BIND_HOST);
}

if (require.main === module) {
  void bootstrap();
}
