import { Controller, Get, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { DumpDatabase } from "../usecase/dump-database.use-case";
import { DumpQueryDto } from "./dto/dump-query.dto";

// Web-only surface (desktop ADR-0049 saves to a file the app picked, so
// there is no HTTP route to mirror), so docs/api-contract.md is untouched —
// see .claude/issues/0029-logical-dump.md.
//
// `@Res()` rather than a returned value: a dump is unbounded, and the whole
// point of the use case is that it never holds the script in memory. Nest's
// normal response handling would serialise a string.
//
// Deliberately NOT decorated with `@UseInterceptors(HistoryRecordingInterceptor)`,
// for the same reason as write-back: history is the record of queries the
// user ran, and a dump's hundreds of generated `SELECT`s are statements
// nobody typed. Desktop writes no history entry for a dump either.
@Controller("connections")
export class ConnectionDumpController {
  constructor(private readonly dump: DumpDatabase) {}

  @Get(":id/dump")
  async download(
    @Param("id") id: string,
    @Query() query: DumpQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    // Preflight before a single header goes out. Once the response has
    // begun there is no status code left to send, so an unknown connection
    // or a database over the size gate has to fail here — otherwise the
    // browser saves an error envelope to disk under a .sql name.
    const prepared = await this.dump.prepare(id, query.confirm === "true");

    res.setHeader("Content-Type", "application/sql; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${dumpFilename(id)}"`);

    try {
      for await (const chunk of this.dump.run(prepared)) {
        // A false result means the client is gone. Returning tears the
        // generator down at its suspension point, which closes the read
        // loop rather than dumping the rest of the database into a socket
        // nobody is holding.
        if (!(await writeChunk(res, chunk))) return;
      }
    } catch (e) {
      // Per-table failures are already comments; reaching here means the
      // run itself died. The file is the only channel left, so say so in
      // it — a truncated dump that looks complete is the worse outcome.
      await writeChunk(res, abortComment(e));
    }

    res.end();
  }
}

/**
 * Write one chunk, respecting backpressure.
 *
 * @returns `false` once the client is gone — the caller should stop reading.
 */
async function writeChunk(res: Response, chunk: string): Promise<boolean> {
  if (res.writableEnded || res.destroyed) return false;
  if (res.write(chunk)) return true;

  // The kernel buffer is full. Waiting for `drain` is what keeps a dump of
  // a database larger than memory from becoming a heap of pending writes.
  // `close` is the other way out: a socket that went away never drains.
  return new Promise<boolean>((resolve) => {
    const settle = (ok: boolean): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      resolve(ok);
    };
    const onDrain = (): void => settle(true);
    const onClose = (): void => settle(false);
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

// Same rule as the use case's per-table comments: the message lands inside
// a `--` comment in a file meant to be run, so a line break in it would
// leave everything after it standing as SQL.
function abortComment(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `-- !! dump aborted: ${message.replace(/[\r\n]+/g, " ")}\n`;
}

// Connection ids are registry-minted, so this is belt and braces — but the
// value lands in a header the browser turns into a filename on disk, and a
// quote in it would end the quoted string early.
const FILENAME_ID_LIMIT = 100;

function dumpFilename(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, FILENAME_ID_LIMIT);
  return `dbboard-dump-${safe.length > 0 ? safe : "connection"}.sql`;
}
