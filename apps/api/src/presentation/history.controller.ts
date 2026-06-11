import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { ExportHistory } from "../usecase/export-history.use-case";

// Operator-only egress for the query-history log. ADR-0017 §8 keeps
// history off `docs/api-contract.md`; this route is intentionally not
// documented as part of the wire contract and is expected to live
// behind operator auth in any deployment that exposes it. We stream
// NDJSON so `curl … | jq -c .` works without ever materialising the
// full table in memory.
@Controller("history")
export class HistoryController {
  constructor(private readonly exporter: ExportHistory) {}

  @Get("export.jsonl")
  async export(@Res() res: Response): Promise<void> {
    res.setHeader("Content-Type", "application/x-ndjson");
    for await (const chunk of this.exporter.stream()) {
      res.write(chunk);
    }
    res.end();
  }
}
