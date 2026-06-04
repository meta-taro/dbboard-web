import { Controller, Get } from "@nestjs/common";
import { ListTables, type ListTablesOutput } from "../usecase/list-tables.use-case";

@Controller("tables")
export class TablesController {
  constructor(private readonly listTables: ListTables) {}

  @Get()
  list(): Promise<ListTablesOutput> {
    return this.listTables.execute();
  }
}
