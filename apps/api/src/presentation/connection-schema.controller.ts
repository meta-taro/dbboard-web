import { Controller, Get, Param, Query } from "@nestjs/common";
import type { TableSchema } from "../domain/values";
import { DescribeTable } from "../usecase/describe-table.use-case";
import { TableSchemaQueryDto } from "./dto/table-schema-query.dto";

// Web-only surface (desktop ADR-0028 has no HTTP route to mirror), so
// docs/api-contract.md is untouched — see .claude/issues/0026-schema-depth.md.
//
// Named `table-schema` rather than `:table/columns` because the response is
// a TableSchema: the primary key belongs to the table, not to any column,
// and key order has nowhere to live in a column list.
@Controller("connections")
export class ConnectionSchemaController {
  constructor(private readonly describeTable: DescribeTable) {}

  @Get(":id/table-schema")
  describe(@Param("id") id: string, @Query() query: TableSchemaQueryDto): Promise<TableSchema> {
    // `schema` absent means "the engine's default"; the adapter, not the
    // controller, decides what that is.
    return this.describeTable.execute(id, { schema: query.schema ?? null, name: query.table });
  }
}
