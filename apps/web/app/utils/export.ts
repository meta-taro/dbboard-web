/**
 * Result-set export (mirrors desktop ADR-0035): serialization of a query
 * result to delimited text — CSV for a downloaded file, TSV for the
 * clipboard. Pure and I/O-free, so the wire format is unit-tested without a
 * grid, a clipboard, or a download.
 *
 * Both formats use the same RFC 4180 quoting (a field is quoted only when it
 * must be), which is what a spreadsheet expects whether it is parsing a pasted
 * TSV or opening a CSV. Records are separated, not terminated: no trailing
 * newline, so a paste does not leave a dangling empty row.
 *
 * Desktop's `next_available_name` has no counterpart here on purpose. It
 * exists because a native save dialog would silently overwrite; the browser's
 * download manager already de-duplicates names itself.
 */
import type { Column, Value } from "../composables/useQueryExecution";
import { formatValue } from "./format-value";

/**
 * UTF-8 byte-order mark. Excel on Windows assumes the system ANSI code page
 * (Shift-JIS on Japanese Windows) for a BOM-less CSV and renders UTF-8 as
 * mojibake; a leading BOM makes it auto-detect UTF-8. Harmless to BOM-aware
 * parsers and to the spreadsheet's own re-save.
 */
export const UTF8_BOM = "﻿";

/** RFC 4180 CSV — comma-delimited, `\r\n` records. For a downloaded file. */
export function toCsv(columns: ReadonlyArray<Column>, rows: ReadonlyArray<ReadonlyArray<Value>>) {
  return delimited(columns, rows, ",", "\r\n");
}

/**
 * {@link toCsv} with a leading BOM — the form to *write to a file*. The
 * clipboard path stays BOM-less: the clipboard carries Unicode natively, and
 * the BOM would appear as a stray glyph when pasting into a plain-text target.
 */
export function toCsvWithBom(
  columns: ReadonlyArray<Column>,
  rows: ReadonlyArray<ReadonlyArray<Value>>,
) {
  return UTF8_BOM + toCsv(columns, rows);
}

/** TSV — tab-delimited, `\n` records. Pastes into Excel / Sheets with columns intact. */
export function toTsv(columns: ReadonlyArray<Column>, rows: ReadonlyArray<ReadonlyArray<Value>>) {
  return delimited(columns, rows, "\t", "\n");
}

function delimited(
  columns: ReadonlyArray<Column>,
  rows: ReadonlyArray<ReadonlyArray<Value>>,
  delimiter: string,
  newline: string,
): string {
  const header = record(
    columns.map((c) => c.name),
    delimiter,
  );
  const body = rows.map((row) => record(row.map(fieldText), delimiter));
  return [header, ...body].join(newline);
}

function record(fields: ReadonlyArray<string>, delimiter: string): string {
  return fields.map((field) => escapeField(field, delimiter)).join(delimiter);
}

/**
 * One cell as a delimited-file field. NULL becomes empty — what a spreadsheet
 * expects — rather than the literal "NULL" the grid shows so an empty cell is
 * not read as a bug. Everything else reuses the grid's own formatter, so a
 * blob still exports its `<blob: N chars>` placeholder; round-tripping binary
 * through CSV is out of scope.
 */
function fieldText(value: Value): string {
  return value === null ? "" : formatValue(value).text;
}

/**
 * Quote only when the field carries the delimiter, a quote, or a line break;
 * double any embedded quote. A bare `\r` counts: a value pasted in from a
 * Windows clipboard can carry one without a `\n`, and unquoted it would split
 * the record in a strict parser.
 */
function escapeField(field: string, delimiter: string): string {
  const mustQuote =
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes("\n") ||
    field.includes("\r");
  return mustQuote ? `"${field.replaceAll('"', '""')}"` : field;
}
