import {
  Inject,
  Injectable,
  Optional,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { type Observable, catchError, tap, throwError } from "rxjs";
import { RecordHistory, type RecordContext } from "../../usecase/record-history.use-case";

interface QueryShapedRequest {
  body: { sql?: unknown };
  params: { id?: unknown };
}

// Cross-cuts POST /query and POST /connections/:id/query. Recording is
// best-effort: a thrown recorder is swallowed so a buggy mapper never
// breaks a user-facing request. The thrown query error is re-thrown
// untouched so ContractErrorFilter still owns the HTTP envelope.
@Injectable()
export class HistoryRecordingInterceptor implements NestInterceptor {
  // `nowMs` is `@Optional()` so the DI container does not try to
  // resolve a `Function` token; tests pass a fake clock directly.
  constructor(
    @Inject(RecordHistory) private readonly recorder: RecordHistory,
    @Optional() private readonly nowMs: () => number = () => Date.now(),
  ) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    const req = context.switchToHttp().getRequest<QueryShapedRequest>();
    const sql = typeof req.body?.sql === "string" ? req.body.sql : "";
    const connectionId = typeof req.params?.id === "string" ? req.params.id : undefined;
    const ctx: RecordContext = {
      sql,
      connectionId,
      startTimeMs: this.nowMs(),
      actor: null,
    };

    return next.handle().pipe(
      tap((result) => {
        void this.safeRecordSuccess(ctx, result);
      }),
      catchError((err: unknown) => {
        void this.safeRecordError(ctx, err);
        return throwError(() => err);
      }),
    );
  }

  private async safeRecordSuccess(ctx: RecordContext, result: unknown): Promise<void> {
    try {
      await this.recorder.recordSuccess(
        ctx,
        result as Parameters<RecordHistory["recordSuccess"]>[1],
      );
    } catch {
      // Swallowed deliberately — see class comment.
    }
  }

  private async safeRecordError(ctx: RecordContext, err: unknown): Promise<void> {
    try {
      await this.recorder.recordError(ctx, err);
    } catch {
      // Swallowed deliberately — see class comment.
    }
  }
}
