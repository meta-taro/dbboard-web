import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError } from "../domain/errors";
import {
  NULL_CAPABILITIES,
  type Capabilities,
  type QueryResult,
  type TableInfo,
} from "../domain/values";

// The zero-database adapter. Lets the HTTP surface stand up before any
// real driver lands (0004 Postgres). All inspection endpoints succeed
// with their "empty" shape; executeQuery raises CapabilityError so the
// UI can distinguish "no database configured" from "SQL is wrong".
export class NullAdapter implements DatabaseAdapter {
  getId(): string {
    return "null";
  }

  getCapabilities(): Capabilities {
    return NULL_CAPABILITIES;
  }

  async listTables(): Promise<TableInfo[]> {
    return [];
  }

  async executeQuery(_sql: string): Promise<QueryResult> {
    throw new CapabilityError("query is not supported by the null adapter");
  }
}
