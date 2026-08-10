import type { ExplainRequest, SuggestRequest } from "../domain/ai/ai-provider.port";
import type { TableInfo } from "../domain/values/table-info";
import type { TableSchema } from "../domain/values/table-schema";

// What we ask, kept in one place and shared by every adapter.
//
// Desktop grew a prompt pair per provider crate, and they have drifted:
// `dbboard-anthropic` and `dbboard-openai` word the same instruction
// differently. Web has one prompt layer and keeps it that way on
// purpose — switching provider must change which model answers, not
// what it was asked, or two rows of the same history log would be
// describing different questions. It also means ADR-0028's `full_schema`
// half has one builder to extend rather than one per provider.

export const EXPLAIN_SYSTEM =
  "You are a database expert. Explain SQL queries concisely in plain English.";

export const SUGGEST_SYSTEM =
  "You are a database expert. Translate the user's natural-language request into a single SQL query. Return only the SQL — no prose, no fenced code block, no commentary.";

export function buildExplainPrompt({ sql, dialect }: ExplainRequest): string {
  const dialectLine = dialect ? `Dialect: ${dialect}\n\n` : "";
  return `${dialectLine}Explain the following SQL query:\n\n${sql}`;
}

// Desktop's `qualify`: a schema-qualified name when the table has one,
// the bare name when it does not.
export function qualify(table: TableInfo): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

/**
 * One table rendered as compact `CREATE TABLE`-ish text (desktop
 * `render_table_schema`, ADR-0028 Decision 8).
 *
 * This is a prompt hint, not valid DDL — fidelity beats parseability, so
 * `declared_type` and `default_value` go through as the engine's raw
 * text and a missing type is simply omitted rather than guessed. The
 * primary key is emitted as its own trailing line from `primary_key`
 * rather than derived by filtering `columns`, because deriving it loses
 * the key order a composite key depends on.
 */
function renderTableSchema(schema: TableSchema): string {
  const lines = schema.columns.map((column) => {
    let line = `  ${column.name}`;
    if (column.declared_type !== null) line += ` ${column.declared_type}`;
    if (!column.nullable) line += " NOT NULL";
    if (column.default_value !== null) line += ` DEFAULT ${column.default_value}`;
    return line;
  });
  if (schema.primary_key.length > 0) {
    lines.push(`  PRIMARY KEY (${schema.primary_key.join(", ")})`);
  }
  return `CREATE TABLE ${qualify(schema.table)} (\n${lines.join(",\n")}\n);`;
}

// Mirrors desktop's `build_suggest_request` ordering — tables, then
// dialect, then the request — with one case desktop cannot have. Desktop
// always passes a (possibly empty) list, so it always emits the block;
// web's `schema` is optional, and when it is absent the block is omitted
// entirely so a caller that cannot introspect gets the prompt it got
// before ADR-0028 Decision 8 landed, byte for byte.
export function buildSuggestPrompt({
  prompt,
  dialect,
  schema,
  full_schema,
}: SuggestRequest): string {
  const segments: string[] = [];
  if (full_schema !== undefined && full_schema.length > 0) {
    // ADR-0028 Decision 9: the full descriptions replace the names when
    // the caller prefetched them. An empty list falls through instead —
    // it means the fan-out produced nothing usable, and the names we do
    // have are worth more than an empty block.
    segments.push(`Tables:\n${full_schema.map(renderTableSchema).join("\n")}`);
  } else if (schema) {
    // An empty list is stated, not skipped: "there are none" stops the
    // model inventing a plausible table, which silence does not.
    const body =
      schema.length === 0
        ? "(no tables introspected)"
        : schema.map((table) => `- ${qualify(table)}`).join("\n");
    segments.push(`Tables:\n${body}`);
  }
  if (dialect) {
    segments.push(`Dialect: ${dialect}`);
  }
  segments.push(`Request: ${prompt}`);
  return segments.join("\n\n");
}
