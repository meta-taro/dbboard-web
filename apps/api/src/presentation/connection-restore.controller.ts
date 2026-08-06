import { Body, Controller, HttpCode, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { summarizeStatements } from "../domain/restore/plan";
import {
  RestoreDatabase,
  isTargetEmpty,
  type OnError,
  type RestoreOptions,
  type RestoreOutcome,
} from "../usecase/restore-database.use-case";
import { RestoreQueryDto } from "./dto/restore-query.dto";

/** The preflight summary, in the shape desktop's `RestorePlanDto` uses. */
export interface RestorePlanResponse {
  /** Runnable statements only — transaction control is stripped and excluded. */
  statements_total: number;
  ddl_count: number;
  data_count: number;
  /** Statements the classifier could not parse. They still run verbatim. */
  unparsed_count: number;
  existing_tables: string[];
  is_target_empty: boolean;
}

/** The result of a completed — or cancelled — restore. */
export interface RestoreOutcomeResponse {
  statements_run: number;
  ddl_run: number;
  data_run: number;
  failures: { index: number; message: string }[];
  cancelled: boolean;
  atomic: boolean;
}

/**
 * The restore surface (0030 slice E) — the HTTP mirror of desktop's
 * `plan_restore` / `run_restore` commands.
 *
 * Web-only, so `docs/api-contract.md` is untouched: desktop reads the `.sql`
 * file it was pointed at and never crosses a wire (ADR-0051), and the
 * contract describes the surfaces the two clients share.
 *
 * Both routes take the script as a raw `application/sql` body — the one
 * non-JSON body in the API. Wrapping a multi-megabyte dump in JSON would
 * mean escaping every quote and newline in it for no gain, and it is a file
 * the user already has on disk. The two exemptions that makes necessary (the
 * content-type guard and a second body parser) are scoped to these paths.
 *
 * Deliberately NOT decorated with `@UseInterceptors(HistoryRecordingInterceptor)`,
 * for the same reason as dump and write-back: history is the record of
 * queries the user ran, and a restore's statements are ones they were handed
 * in a file. Desktop writes no history entry for a restore either.
 */
@Controller("connections")
export class ConnectionRestoreController {
  constructor(private readonly restore: RestoreDatabase) {}

  /**
   * Preflight: classify the posted script and report what the target already
   * holds, so the client can size the restore and decide whether it needs to
   * ask for confirmation. Reads only — nothing here can change the database.
   */
  @Post(":id/restore/plan")
  @HttpCode(200)
  async plan(@Param("id") id: string, @Body() body: unknown): Promise<RestorePlanResponse> {
    const { plan } = await this.restore.prepare(id, asScript(body));
    const counts = summarizeStatements(plan.statements);

    return {
      statements_total: counts.runnable,
      ddl_count: counts.ddl,
      data_count: counts.data,
      unparsed_count: counts.unparsed,
      existing_tables: plan.existingTables,
      is_target_empty: isTargetEmpty(plan),
    };
  }

  /**
   * Apply the posted script.
   *
   * The plan is never taken in — ADR-0065 makes re-plan-on-run a correctness
   * rule, and the way to keep a stale plan unexecutable is to give the caller
   * no way to supply one. So this re-prepares from the script it was posted,
   * exactly as desktop re-reads and re-plans the file.
   */
  @Post(":id/restore")
  @HttpCode(200)
  async run(
    @Param("id") id: string,
    @Query() query: RestoreQueryDto,
    @Body() body: unknown,
    // Passthrough: Nest still serialises the returned object. The response is
    // here only as the place where "the client went away" is observable.
    @Res({ passthrough: true }) res: Response,
  ): Promise<RestoreOutcomeResponse> {
    // Web's answer to desktop's `cancel_restore`: there is no second call to
    // make over HTTP, so the request going away is the cancellation. Every
    // response closes its socket eventually, hence the `writableFinished`
    // check — only a close *before* the response was written means the client
    // left. On the atomic path this can only be observed before the batch
    // starts; that is the same guarantee desktop gives.
    //
    // Subscribed before the preflight, not after it: `prepare` queries the
    // target for its table list, and a client that hangs up during *that*
    // should not have the restore start behind it.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    const prepared = await this.restore.prepare(id, asScript(body));
    const outcome = await this.restore.run(prepared, optionsFrom(query), controller.signal);
    return toResponse(outcome);
  }
}

/**
 * The body as a script.
 *
 * A request that carried no body at all leaves express's `{}` behind rather
 * than a string. Nothing to restore is a truthful answer to that — the plan
 * comes back empty and the run applies nothing — and it is a better one than
 * a 500 from reading `.length` off an object.
 */
function asScript(body: unknown): string {
  return typeof body === "string" ? body : "";
}

function optionsFrom(query: RestoreQueryDto): RestoreOptions {
  return {
    confirmed: query.confirmed === "true",
    onError: (query.on_error as OnError | undefined) ?? "stop",
  };
}

function toResponse(outcome: RestoreOutcome): RestoreOutcomeResponse {
  return {
    statements_run: outcome.statementsRun,
    ddl_run: outcome.ddlRun,
    data_run: outcome.dataRun,
    failures: outcome.failures.map((f) => ({ index: f.index, message: f.message })),
    cancelled: outcome.cancelled,
    atomic: outcome.atomic,
  };
}
