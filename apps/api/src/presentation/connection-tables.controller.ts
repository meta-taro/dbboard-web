import { Controller, Get, Param } from "@nestjs/common";
import {
  ListConnectionTables,
  type ListConnectionTablesOutput,
} from "../usecase/list-connection-tables.use-case";

@Controller("connections")
export class ConnectionTablesController {
  constructor(private readonly listConnectionTables: ListConnectionTables) {}

  @Get(":id/tables")
  listOn(@Param("id") id: string): Promise<ListConnectionTablesOutput> {
    return this.listConnectionTables.execute(id);
  }
}
