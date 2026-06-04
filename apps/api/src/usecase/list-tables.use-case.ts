import type { DatabaseAdapter } from "../domain/database-adapter.port";
import type { TableInfo } from "../domain/values";

export interface ListTablesOutput {
  tables: TableInfo[];
}

export class ListTables {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async execute(): Promise<ListTablesOutput> {
    return { tables: await this.adapter.listTables() };
  }
}
