import { describe, expect, it, vi } from "vitest";
import { CapabilityError, QueryError } from "../domain/errors";
import type { StatementKind } from "../domain/restore/plan";
import type {
  PreparedRestore,
  RestoreDatabase,
  RestoreOptions,
  RestoreOutcome,
} from "../usecase/restore-database.use-case";
import { ConnectionRestoreController } from "./connection-restore.controller";
import type { RestoreQueryDto } from "./dto/restore-query.dto";

// A prepared restore is opaque to the controller — it only ever hands one
// straight back to `run`. What the plan route reads off it is the plan.
function prepared(
  kinds: readonly StatementKind[],
  existingTables: readonly string[] = [],
): PreparedRestore {
  return {
    adapter: {},
    plan: {
      statements: kinds.map((kind, i) => ({ sql: `STATEMENT ${i}`, kind })),
      existingTables: [...existingTables],
    },
  } as unknown as PreparedRestore;
}

const OUTCOME: RestoreOutcome = {
  statementsRun: 2,
  ddlRun: 1,
  dataRun: 1,
  failures: [],
  cancelled: false,
  atomic: true,
};

interface StubOptions {
  prepareResult?: PreparedRestore;
  prepareError?: unknown;
  outcome?: RestoreOutcome;
  runError?: unknown;
}

function stub(options: StubOptions = {}): {
  restore: RestoreDatabase;
  prepare: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
} {
  const prepare = vi.fn(() =>
    options.prepareError !== undefined
      ? Promise.reject(options.prepareError)
      : Promise.resolve(options.prepareResult ?? prepared(["ddl", "data"])),
  );
  const run = vi.fn(() =>
    options.runError !== undefined
      ? Promise.reject(options.runError)
      : Promise.resolve(options.outcome ?? OUTCOME),
  );
  return { restore: { prepare, run } as unknown as RestoreDatabase, prepare, run };
}

// A stand-in for the Express response the run route takes in passthrough
// mode. It exists only to carry the `close` listener the controller uses to
// notice the client leaving.
function fakeResponse(): {
  res: Parameters<ConnectionRestoreController["run"]>[3];
  /** The client hung up before the response was written. */
  vanish: () => void;
  /** The response was written and the socket closed normally after it. */
  finish: () => void;
} {
  let onClose: (() => void) | undefined;
  let finished = false;
  const res = {
    get writableFinished(): boolean {
      return finished;
    },
    on(event: string, listener: () => void): void {
      if (event === "close") onClose = listener;
    },
  };
  return {
    res: res as unknown as Parameters<ConnectionRestoreController["run"]>[3],
    vanish: () => onClose?.(),
    finish: () => {
      finished = true;
      onClose?.();
    },
  };
}

function query(overrides: Partial<RestoreQueryDto> = {}): RestoreQueryDto {
  return { ...overrides } as RestoreQueryDto;
}

describe("ConnectionRestoreController.plan", () => {
  it("summarises the runnable statements and reports the target", async () => {
    const { restore, prepare } = stub({
      prepareResult: prepared(
        ["transaction_control", "ddl", "data", "data", "other", "unparsed", "transaction_control"],
        ["public.a"],
      ),
    });

    const body = await new ConnectionRestoreController(restore).plan(
      "c1",
      "CREATE TABLE t (id int)",
    );

    expect(prepare).toHaveBeenCalledWith("c1", "CREATE TABLE t (id int)");
    expect(body).toEqual({
      // Transaction control is stripped by the runner, so it is excluded
      // here too: the numbers describe what will actually execute.
      statements_total: 5,
      ddl_count: 1,
      data_count: 2,
      unparsed_count: 1,
      existing_tables: ["public.a"],
      is_target_empty: false,
    });
  });

  it("reports an empty target as empty", async () => {
    const { restore } = stub({ prepareResult: prepared(["ddl"]) });

    const body = await new ConnectionRestoreController(restore).plan(
      "c1",
      "CREATE TABLE t (id int)",
    );

    expect(body.existing_tables).toEqual([]);
    expect(body.is_target_empty).toBe(true);
  });

  it("reports a script of nothing as a plan of nothing", async () => {
    const { restore } = stub({ prepareResult: prepared([]) });

    const body = await new ConnectionRestoreController(restore).plan("c1", "");

    expect(body).toEqual({
      statements_total: 0,
      ddl_count: 0,
      data_count: 0,
      unparsed_count: 0,
      existing_tables: [],
      is_target_empty: true,
    });
  });

  it("treats a missing body as an empty script rather than failing", async () => {
    // No body parser ran (no Content-Type, or an empty one), so express
    // leaves `{}` behind. Nothing to restore is a truthful answer; a 500
    // from reading `.length` off an object is not.
    const { restore, prepare } = stub({ prepareResult: prepared([]) });

    await new ConnectionRestoreController(restore).plan("c1", {} as unknown as string);

    expect(prepare).toHaveBeenCalledWith("c1", "");
  });

  it("propagates an unknown connection", async () => {
    const { restore } = stub({ prepareError: new CapabilityError("unknown connection: nope") });

    await expect(new ConnectionRestoreController(restore).plan("nope", "SELECT 1")).rejects.toThrow(
      CapabilityError,
    );
  });
});

describe("ConnectionRestoreController.run", () => {
  it("applies the posted script and returns the outcome", async () => {
    const { restore, prepare } = stub();
    const { res } = fakeResponse();

    const body = await new ConnectionRestoreController(restore).run(
      "c1",
      query(),
      "CREATE TABLE t (id int)",
      res,
    );

    expect(prepare).toHaveBeenCalledWith("c1", "CREATE TABLE t (id int)");
    expect(body).toEqual({
      statements_run: 2,
      ddl_run: 1,
      data_run: 1,
      failures: [],
      cancelled: false,
      atomic: true,
    });
  });

  it("re-plans from the posted script rather than taking a plan in", async () => {
    // ADR-0065: re-plan-on-run is what makes a stale plan unexecutable.
    // The prepared value the runner receives has to be the one this
    // request built, not one a caller could hand back.
    const own = prepared(["ddl"]);
    const { restore, run } = stub({ prepareResult: own });
    const { res } = fakeResponse();

    await new ConnectionRestoreController(restore).run(
      "c1",
      query(),
      "CREATE TABLE t (id int)",
      res,
    );

    expect(run.mock.calls[0]?.[0]).toBe(own);
  });

  it("defaults to unconfirmed and stop-on-first-failure", async () => {
    const { restore, run } = stub();
    const { res } = fakeResponse();

    await new ConnectionRestoreController(restore).run("c1", query(), "SELECT 1", res);

    expect(run.mock.calls[0]?.[1]).toEqual<RestoreOptions>({ confirmed: false, onError: "stop" });
  });

  it("passes the caller's confirmation and error policy through", async () => {
    const { restore, run } = stub();
    const { res } = fakeResponse();

    await new ConnectionRestoreController(restore).run(
      "c1",
      query({ confirmed: "true", on_error: "continue" }),
      "SELECT 1",
      res,
    );

    expect(run.mock.calls[0]?.[1]).toEqual<RestoreOptions>({
      confirmed: true,
      onError: "continue",
    });
  });

  it("reads confirmed=false as not confirmed", async () => {
    const { restore, run } = stub();
    const { res } = fakeResponse();

    await new ConnectionRestoreController(restore).run(
      "c1",
      query({ confirmed: "false" }),
      "SELECT 1",
      res,
    );

    expect(run.mock.calls[0]?.[1]?.confirmed).toBe(false);
  });

  it("reports per-statement failures as part of a completed run", async () => {
    // A run with failures is not an error: the per-statement path reports
    // what it managed to apply, and the UI shows a partial result.
    const { restore } = stub({
      outcome: {
        statementsRun: 1,
        ddlRun: 1,
        dataRun: 0,
        failures: [{ index: 1, message: 'relation "t" does not exist' }],
        cancelled: false,
        atomic: false,
      },
    });
    const { res } = fakeResponse();

    const body = await new ConnectionRestoreController(restore).run(
      "c1",
      query({ on_error: "continue" }),
      "SELECT 1",
      res,
    );

    expect(body.failures).toEqual([{ index: 1, message: 'relation "t" does not exist' }]);
    expect(body.atomic).toBe(false);
  });

  it("propagates the empty-target refusal", async () => {
    const { restore } = stub({ runError: new QueryError("restore target is not empty (2 …)") });
    const { res } = fakeResponse();

    await expect(
      new ConnectionRestoreController(restore).run("c1", query(), "SELECT 1", res),
    ).rejects.toThrow(QueryError);
  });

  it("cancels the run when the client goes away mid-flight", async () => {
    const { restore, run } = stub();
    const { res, vanish } = fakeResponse();

    const pending = new ConnectionRestoreController(restore).run("c1", query(), "SELECT 1", res);
    vanish();
    await pending;

    expect(run.mock.calls[0]?.[2]?.aborted).toBe(true);
  });

  it("does not cancel a run whose response was already written", async () => {
    // Every response closes its socket eventually. Only a close *before*
    // the response was written means the client left.
    const { restore, run } = stub();
    const { res, finish } = fakeResponse();

    await new ConnectionRestoreController(restore).run("c1", query(), "SELECT 1", res);
    finish();

    expect(run.mock.calls[0]?.[2]?.aborted).toBe(false);
  });
});
