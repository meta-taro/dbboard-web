import { describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NULL_CAPABILITIES } from "../domain/values";
import type { ConnectionRecord, ConnectionRegistry } from "../usecase/connection-registry.port";
import { UpdateRow } from "../usecase/update-row.use-case";
import { ConnectionRowsController } from "./connection-rows.controller";
import type { UpdateRowDto } from "./dto/update-row.dto";

// The controller's whole job is turning a JSON body into an UpdatePlan, so
// the tests assert the SQL that comes out the far end rather than the shape
// of an intermediate object: the mapping is only correct if the statement is.

function writing(affected = 1): DatabaseAdapter {
  return {
    getId: () => "pg",
    getCapabilities: () => ({ ...NULL_CAPABILITIES, has_execute: true }),
    listTables: async () => [],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
    execute: vi.fn().mockResolvedValue(affected),
  };
}

function registry(records: ConnectionRecord[]): ConnectionRegistry {
  const map = new Map(records.map((r) => [r.id, r]));
  return {
    add: () => undefined,
    list: () => [...map.values()],
    get: (id) => map.get(id),
    delete: () => true,
  };
}

function controllerOn(adapter: DatabaseAdapter): ConnectionRowsController {
  const useCase = new UpdateRow(
    writing(),
    registry([{ id: "abc", label: "A", driver: "postgres", adapter }]),
  );
  return new ConnectionRowsController(useCase);
}

function body(overrides: Partial<UpdateRowDto> = {}): UpdateRowDto {
  return {
    table: "users",
    schema: "public",
    key: [{ column: "id", value: 7 }],
    edits: [{ column: "email", value: "new@example.com" }],
    ...overrides,
  } as UpdateRowDto;
}

async function sqlFrom(adapter: DatabaseAdapter, dto: UpdateRowDto): Promise<string> {
  await controllerOn(adapter).update("abc", dto);
  return vi.mocked(adapter.execute!).mock.calls[0]![0];
}

describe("ConnectionRowsController", () => {
  it("delegates to UpdateRow and reports the affected count", async () => {
    const adapter = writing();
    await expect(controllerOn(adapter).update("abc", body())).resolves.toEqual({
      rows_affected: 1,
    });
    expect(adapter.execute).toHaveBeenCalledWith(
      `UPDATE "public"."users" SET "email" = 'new@example.com' WHERE "id" = 7`,
    );
  });

  it("leaves the table unqualified when no schema is given", async () => {
    const adapter = writing();
    await expect(sqlFrom(adapter, body({ schema: undefined }))).resolves.toContain(
      `UPDATE "users" SET`,
    );
  });

  it("writes SQL NULL for an explicit null", async () => {
    const adapter = writing();
    await expect(
      sqlFrom(adapter, body({ edits: [{ column: "email", value: null }] })),
    ).resolves.toContain(`SET "email" = NULL`);
  });

  it("writes SQL NULL for an omitted value", async () => {
    // Absent and null mean the same thing on the wire; JSON clients differ
    // on which one they send for "cleared".
    const adapter = writing();
    await expect(sqlFrom(adapter, body({ edits: [{ column: "email" }] }))).resolves.toContain(
      `SET "email" = NULL`,
    );
  });

  it("writes an empty string as a literal, not as NULL", async () => {
    const adapter = writing();
    await expect(
      sqlFrom(adapter, body({ edits: [{ column: "email", value: "" }] })),
    ).resolves.toContain(`SET "email" = ''`);
  });

  it("keeps every edited column, in the order the body listed them", async () => {
    const adapter = writing();
    await expect(
      sqlFrom(
        adapter,
        body({
          edits: [
            { column: "email", value: "a@b.c" },
            { column: "name", value: "Ada" },
          ],
        }),
      ),
    ).resolves.toContain(`SET "email" = 'a@b.c', "name" = 'Ada'`);
  });

  it("keys on every identity column the body listed", async () => {
    const adapter = writing();
    await expect(
      sqlFrom(
        adapter,
        body({
          key: [
            { column: "tenant", value: "acme" },
            { column: "id", value: 7 },
          ],
        }),
      ),
    ).resolves.toContain(`WHERE "tenant" = 'acme' AND "id" = 7`);
  });

  it("does not escape the route's own quoting for the client", async () => {
    // The one thing this route must never do is hand text through
    // unescaped; the domain does the quoting, and the controller is the
    // layer that could quietly undo it.
    const adapter = writing();
    await expect(
      sqlFrom(adapter, body({ edits: [{ column: "no'te", value: "O'Hara" }] })),
    ).resolves.toContain(`SET "no'te" = 'O''Hara'`);
  });
});
