import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { CapabilityError, QueryError } from "../domain/errors";
import type { DumpDatabase, PreparedDump } from "../usecase/dump-database.use-case";
import { ConnectionDumpController } from "./connection-dump.controller";

// A stand-in for the real Response. Extends EventEmitter because the
// controller waits on `drain` and `close`, which only exist on a stream.
class FakeResponse extends EventEmitter {
  readonly headers: Record<string, string> = {};
  readonly chunks: string[] = [];
  writableEnded = false;
  destroyed = false;
  /** 1-based index of the write that reports a full buffer. */
  stallAt: number | null = null;
  /** 1-based index of the write after which the client vanishes. */
  closeAfter: number | null = null;

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    if (this.closeAfter !== null && this.chunks.length >= this.closeAfter) {
      this.destroyed = true;
    }
    return this.stallAt === null || this.chunks.length !== this.stallAt;
  }

  end(): void {
    this.writableEnded = true;
  }

  get body(): string {
    return this.chunks.join("");
  }
}

function response(): { res: Response; fake: FakeResponse } {
  const fake = new FakeResponse();
  return { res: fake as unknown as Response, fake };
}

const PREPARED = { adapter: {}, plan: { tables: [] } } as unknown as PreparedDump;

interface StubOptions {
  prepare?: (id: string | undefined, confirm: boolean) => Promise<PreparedDump>;
  chunks?: string[];
  failAfter?: number;
  failure?: unknown;
}

function stubUseCase(options: StubOptions = {}): {
  dump: DumpDatabase;
  prepare: ReturnType<typeof vi.fn>;
} {
  const prepare = vi.fn(options.prepare ?? (() => Promise.resolve(PREPARED)));
  const chunks = options.chunks ?? ["-- dbboard logical dump (stub)\n"];
  async function* run(): AsyncIterable<string> {
    for (const [index, chunk] of chunks.entries()) {
      if (options.failAfter !== undefined && index === options.failAfter) {
        throw options.failure ?? new Error("boom");
      }
      yield chunk;
    }
    if (options.failAfter === chunks.length) throw options.failure ?? new Error("boom");
  }
  return { dump: { prepare, run } as unknown as DumpDatabase, prepare };
}

/** Let pending microtasks settle without resolving the controller's promise. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ConnectionDumpController", () => {
  it("serves SQL as an attachment named after the connection", async () => {
    const { dump } = stubUseCase();
    const { res, fake } = response();

    await new ConnectionDumpController(dump).download("prod-pg", {}, res);

    expect(fake.headers["Content-Type"]).toBe("application/sql; charset=utf-8");
    expect(fake.headers["Content-Disposition"]).toBe(
      'attachment; filename="dbboard-dump-prod-pg.sql"',
    );
  });

  it("writes the dump and ends the response", async () => {
    const { dump } = stubUseCase({ chunks: ["-- header\n", "CREATE TABLE a();\n"] });
    const { res, fake } = response();

    await new ConnectionDumpController(dump).download("c1", {}, res);

    expect(fake.body).toBe("-- header\nCREATE TABLE a();\n");
    expect(fake.writableEnded).toBe(true);
  });

  // The id is registry-minted, so this is belt and braces — but it lands
  // verbatim in a header the browser turns into a filename on disk.
  it.each([
    ['../../etc/passwd"', "dbboard-dump-.._.._etc_passwd_.sql"],
    ['a" ; rm -rf /', "dbboard-dump-a____rm_-rf__.sql"],
    ["", "dbboard-dump-connection.sql"],
  ])("sanitises %o into the filename", async (id, expected) => {
    const { dump } = stubUseCase();
    const { res, fake } = response();

    await new ConnectionDumpController(dump).download(id, {}, res);

    expect(fake.headers["Content-Disposition"]).toBe(`attachment; filename="${expected}"`);
  });

  it("keeps the filename to a length a filesystem will accept", async () => {
    const { dump } = stubUseCase();
    const { res, fake } = response();

    await new ConnectionDumpController(dump).download("x".repeat(500), {}, res);

    const filename = /filename="([^"]+)"/.exec(fake.headers["Content-Disposition"] ?? "")?.[1];
    expect(filename).toBeDefined();
    expect(filename!.length).toBeLessThanOrEqual(255);
    expect(filename!.endsWith(".sql")).toBe(true);
  });

  it.each([
    [undefined, false],
    ["false", false],
    ["true", true],
  ])("passes confirm=%o through as %o", async (confirm, expected) => {
    const { dump, prepare } = stubUseCase();
    const { res } = response();

    await new ConnectionDumpController(dump).download("c1", { confirm }, res);

    expect(prepare).toHaveBeenCalledWith("c1", expected);
  });

  // Every refusal has to land before a byte is written, or the status code
  // is gone and the client saves an error page as a .sql file.
  it.each([new CapabilityError("unknown connection: nope"), new QueryError("over the threshold")])(
    "refuses before sending any header (%s)",
    async (error) => {
      const { dump } = stubUseCase({ prepare: () => Promise.reject(error) });
      const { res, fake } = response();

      await expect(new ConnectionDumpController(dump).download("c1", {}, res)).rejects.toBe(error);
      expect(fake.headers).toEqual({});
      expect(fake.chunks).toEqual([]);
      expect(fake.writableEnded).toBe(false);
    },
  );

  // Past the headers there is no status code left to send, so the failure
  // has to be visible inside the file itself.
  it("names a mid-stream failure in the file rather than truncating silently", async () => {
    const { dump } = stubUseCase({
      chunks: ["-- header\n", "INSERT INTO a VALUES (1);\n"],
      failAfter: 1,
      failure: new QueryError("connection terminated"),
    });
    const { res, fake } = response();

    await new ConnectionDumpController(dump).download("c1", {}, res);

    expect(fake.body).toBe("-- header\n-- !! dump aborted: connection terminated\n");
    expect(fake.writableEnded).toBe(true);
  });

  it("flattens an aborted message onto one comment line", async () => {
    const { dump } = stubUseCase({
      chunks: ["-- header\n"],
      failAfter: 1,
      failure: new Error("boom\nDROP TABLE users;\r-- "),
    });
    const { res, fake } = response();

    await new ConnectionDumpController(dump).download("c1", {}, res);

    const aborted = fake.chunks[fake.chunks.length - 1]!;
    expect(aborted).toBe("-- !! dump aborted: boom DROP TABLE users; -- \n");
    expect(aborted.slice(0, -1)).not.toContain("\n");
  });

  it("stops reading the database once the client has gone", async () => {
    const { dump } = stubUseCase({ chunks: ["a\n", "b\n", "c\n"] });
    const { res, fake } = response();
    fake.closeAfter = 1;

    await new ConnectionDumpController(dump).download("c1", {}, res);

    expect(fake.body).toBe("a\n");
  });

  it("waits for the socket to drain instead of buffering the whole database", async () => {
    const { dump } = stubUseCase({ chunks: ["a\n", "b\n"] });
    const { res, fake } = response();
    fake.stallAt = 1;

    const pending = new ConnectionDumpController(dump).download("c1", {}, res);
    await tick();
    expect(fake.body).toBe("a\n");
    expect(fake.writableEnded).toBe(false);

    fake.emit("drain");
    await pending;
    expect(fake.body).toBe("a\nb\n");
  });

  // A stalled write that never drains because the client vanished would
  // otherwise hold the connection — and the adapter's — open forever.
  it("gives up on a stalled write when the socket closes", async () => {
    const { dump } = stubUseCase({ chunks: ["a\n", "b\n"] });
    const { res, fake } = response();
    fake.stallAt = 1;

    const pending = new ConnectionDumpController(dump).download("c1", {}, res);
    await tick();

    fake.emit("close");
    await pending;
    expect(fake.body).toBe("a\n");
  });
});
