import { Body, Controller, Param, Post } from "@nestjs/common";
import type { CellValue, UpdatePlan } from "../domain/write-back";
import { UpdateRow } from "../usecase/update-row.use-case";
import type { CellEditDto } from "./dto/update-row.dto";
import { UpdateRowDto } from "./dto/update-row.dto";

/** What the route answers with — the contract's own word for the count. */
export interface UpdateRowResponse {
  rows_affected: number;
}

// Web-only surface: desktop reaches write-back through a Tauri command
// (`update_row`) and has no HTTP route to mirror, so docs/api-contract.md is
// untouched. Nested under the already-unilateral `/connections/*` prefix for
// that reason — see .claude/decisions.md and .claude/issues/0028.
//
// Deliberately NOT decorated with `@UseInterceptors(HistoryRecordingInterceptor)`:
// history is the record of queries the user ran, and this statement is one
// they never typed. Desktop makes the same call — its write-back writes no
// history entry either.
//
// Also deliberately not exposed as an AI tool surface. Desktop's comment on
// the command says it plainly: this is the app's first DB *write*, and it is
// kept off the agent-facing side so external agents stay read-only.
@Controller("connections")
export class ConnectionRowsController {
  constructor(private readonly updateRow: UpdateRow) {}

  @Post(":id/rows")
  async update(@Param("id") id: string, @Body() body: UpdateRowDto): Promise<UpdateRowResponse> {
    const rows_affected = await this.updateRow.execute(id, toPlan(body));
    return { rows_affected };
  }
}

function toPlan(body: UpdateRowDto): UpdatePlan {
  return {
    // `schema` absent means "the engine's default"; the adapter, not the
    // controller, decides what that is.
    table: { schema: body.schema ?? null, name: body.table },
    key: body.key.map((k) => ({ column: k.column, value: k.value })),
    edits: body.edits.map((e) => ({ column: e.column, value: toCellValue(e) })),
  };
}

// Two spellings of "cleared" — `"value": null` and no `value` at all —
// collapse to the one variant that means SQL NULL. Everything else is text,
// including `""`, which is a value the editor can produce on purpose.
function toCellValue(edit: CellEditDto): CellValue {
  const value = edit.value;
  return value === null || value === undefined ? { kind: "null" } : { kind: "text", text: value };
}
