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
