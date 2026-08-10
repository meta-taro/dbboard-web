import { describe, expect, it } from "vitest";
import {
  EXPLAIN_SYSTEM,
  SUGGEST_SYSTEM,
  buildExplainPrompt,
  buildSuggestPrompt,
  qualify,
} from "./ai-prompts";

// The prompts are shared by every adapter on purpose, so these tests are
// the contract rather than an implementation detail of one of them:
// switching provider must change which model answers, not what it was
// asked. Each adapter's own spec still asserts that it sends these
// strings — that is the wiring, this is the wording.

describe("system prompts", () => {
  it("asks for a plain-English explanation", () => {
    expect(EXPLAIN_SYSTEM).toBe(
      "You are a database expert. Explain SQL queries concisely in plain English.",
    );
  });

  it("asks for bare SQL with no prose or fences", () => {
    expect(SUGGEST_SYSTEM).toBe(
      "You are a database expert. Translate the user's natural-language request into a single SQL query. Return only the SQL — no prose, no fenced code block, no commentary.",
    );
  });
});

describe("qualify", () => {
  it("prefixes the schema when the table has one", () => {
    expect(qualify({ schema: "public", name: "users" })).toBe("public.users");
  });

  it("uses the bare name when it does not", () => {
    expect(qualify({ schema: null, name: "users" })).toBe("users");
  });
});

describe("buildExplainPrompt", () => {
  it("states the dialect above the query when one is known", () => {
    expect(buildExplainPrompt({ sql: "SELECT 1", dialect: "postgres" })).toBe(
      "Dialect: postgres\n\nExplain the following SQL query:\n\nSELECT 1",
    );
  });

  it("omits the dialect line entirely when it is not", () => {
    expect(buildExplainPrompt({ sql: "SELECT 1" })).toBe(
      "Explain the following SQL query:\n\nSELECT 1",
    );
  });
});

describe("buildSuggestPrompt", () => {
  it("orders the segments tables, dialect, request", () => {
    expect(
      buildSuggestPrompt({
        prompt: "everyone who signed up today",
        dialect: "postgres",
        schema: [
          { schema: "public", name: "users" },
          { schema: null, name: "audit" },
        ],
      }),
    ).toBe(
      "Tables:\n- public.users\n- audit\n\nDialect: postgres\n\nRequest: everyone who signed up today",
    );
  });

  it("states an empty introspection rather than skipping the block", () => {
    // "There are none" stops the model inventing a plausible table;
    // silence does not.
    expect(buildSuggestPrompt({ prompt: "anything", schema: [] })).toBe(
      "Tables:\n(no tables introspected)\n\nRequest: anything",
    );
  });

  it("omits the block when the caller did not look", () => {
    // `undefined` is a different prompt from `[]`, byte for byte the one
    // callers got before ADR-0028 Decision 8 landed.
    expect(buildSuggestPrompt({ prompt: "anything" })).toBe("Request: anything");
  });
});

// ADR-0028 Decision 9: when the caller prefetched per-table descriptions
// they replace the terse name list. The rendering is desktop's
// `render_table_schema` byte for byte — a prompt hint, not valid DDL, so
// `declared_type` and `default_value` are passed through as the engine's
// raw text and a missing type is omitted rather than guessed.
describe("buildSuggestPrompt with full_schema", () => {
  const column = (
    name: string,
    declared_type: string | null,
    nullable: boolean,
    ordinal: number,
    default_value: string | null = null,
    primary_key = false,
  ) => ({ name, declared_type, nullable, primary_key, ordinal, default_value });

  it("renders each table as a compact CREATE TABLE, preferring it over the names", () => {
    expect(
      buildSuggestPrompt({
        prompt: "everyone who signed up today",
        dialect: "postgres",
        // Both halves may be on the wire; the full one wins.
        schema: [{ schema: "public", name: "users" }],
        full_schema: [
          {
            table: { schema: "public", name: "users" },
            columns: [
              column("id", "integer", false, 1, "nextval('users_id_seq'::regclass)", true),
              column("email", "character varying", false, 2),
              column("nickname", null, true, 3),
            ],
            primary_key: ["id"],
          },
        ],
      }),
    ).toBe(
      "Tables:\n" +
        "CREATE TABLE public.users (\n" +
        "  id integer NOT NULL DEFAULT nextval('users_id_seq'::regclass),\n" +
        "  email character varying NOT NULL,\n" +
        "  nickname,\n" +
        "  PRIMARY KEY (id)\n" +
        ");\n\n" +
        "Dialect: postgres\n\n" +
        "Request: everyone who signed up today",
    );
  });

  it("omits the primary-key line when the table has none", () => {
    expect(
      buildSuggestPrompt({
        prompt: "anything",
        full_schema: [
          {
            table: { schema: null, name: "audit_log" },
            columns: [column("entry", "TEXT", true, 1)],
            primary_key: [],
          },
        ],
      }),
    ).toBe("Tables:\nCREATE TABLE audit_log (\n  entry TEXT\n);\n\nRequest: anything");
  });

  it("keeps a composite key in key order rather than column order", () => {
    expect(
      buildSuggestPrompt({
        prompt: "anything",
        full_schema: [
          {
            table: { schema: null, name: "memberships" },
            columns: [
              column("team_id", "uuid", false, 1, null, true),
              column("user_id", "uuid", false, 2, null, true),
            ],
            // Declared (user_id, team_id) — the reverse of ordinal order,
            // which is exactly what filtering `columns` would lose.
            primary_key: ["user_id", "team_id"],
          },
        ],
      }),
    ).toBe(
      "Tables:\n" +
        "CREATE TABLE memberships (\n" +
        "  team_id uuid NOT NULL,\n" +
        "  user_id uuid NOT NULL,\n" +
        "  PRIMARY KEY (user_id, team_id)\n" +
        ");\n\n" +
        "Request: anything",
    );
  });

  it("separates several tables with a single newline", () => {
    expect(
      buildSuggestPrompt({
        prompt: "anything",
        full_schema: [
          {
            table: { schema: null, name: "a" },
            columns: [column("x", "int", true, 1)],
            primary_key: [],
          },
          {
            table: { schema: null, name: "b" },
            columns: [column("y", "int", true, 1)],
            primary_key: [],
          },
        ],
      }),
    ).toBe(
      "Tables:\n" +
        "CREATE TABLE a (\n  x int\n);\n" +
        "CREATE TABLE b (\n  y int\n);\n\n" +
        "Request: anything",
    );
  });

  it("falls back to the terse names when the prefetch produced nothing", () => {
    // An empty list means the fan-out came back with no usable
    // description — not that the connection has no tables.
    expect(
      buildSuggestPrompt({
        prompt: "anything",
        schema: [{ schema: null, name: "users" }],
        full_schema: [],
      }),
    ).toBe("Tables:\n- users\n\nRequest: anything");
  });

  it("falls back all the way to the empty statement when both halves are empty", () => {
    expect(buildSuggestPrompt({ prompt: "anything", schema: [], full_schema: [] })).toBe(
      "Tables:\n(no tables introspected)\n\nRequest: anything",
    );
  });

  it("renders the block even when the caller sent no terse list at all", () => {
    expect(
      buildSuggestPrompt({
        prompt: "anything",
        full_schema: [
          {
            table: { schema: null, name: "a" },
            columns: [column("x", "int", true, 1)],
            primary_key: [],
          },
        ],
      }),
    ).toBe("Tables:\nCREATE TABLE a (\n  x int\n);\n\nRequest: anything");
  });

  it("omits the block when neither half was sent", () => {
    expect(buildSuggestPrompt({ prompt: "anything", full_schema: [] })).toBe("Request: anything");
  });
});
