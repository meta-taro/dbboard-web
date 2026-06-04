import "reflect-metadata";
import { HttpStatus, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { MAX_BODY_BYTES } from "./bootstrap/config";
import { contentTypeGuard } from "./bootstrap/content-type.middleware";
import { ContractErrorFilter } from "./presentation/filters/contract-error.filter";
import { RequestLevelRejectionFilter } from "./presentation/filters/request-level-rejection.filter";

export async function createApp(): Promise<NestExpressApplication> {
  // bodyParser: false + app.useBodyParser — the seam 0003 needs.
  // Routes the 64 KiB cap (and the value 0005 will lock in) through a
  // single configurable hook rather than NestFactory's default 100 KiB
  // limit. Keeps express off the dependency surface.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.use(contentTypeGuard);
  app.useBodyParser("json", { limit: MAX_BODY_BYTES });
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
  const app = await createApp();
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
}

if (require.main === module) {
  void bootstrap();
}
