import { describe, expect, it } from "vitest";
import type { Column, Value } from "../app/composables/useQueryExecution";
import { UTF8_BOM, toCsv, toCsvWithBom, toTsv } from "../app/utils/export";

// Mirrors desktop ADR-0035's `export` module, assertion for assertion, so the
// two clients hand a spreadsheet the same bytes. The cases below are the
// desktop test suite plus the two the web has and desktop does not: blobs come
// across the wire as `{ $blob }` rather than a `Value::Blob`, and a lone `\r`
// has to quote as well (a Windows clipboard paste can produce one).

function col(name: string): Column {
  return { name, declared_type: null };
}

function rows(...records: Value[][]): Value[][] {
  return records;
}

describe("result export", () => {
  it("writes a header and one record per row", () => {
    const columns = [col("id"), col("name")];
    expect(toCsv(columns, rows([1, "Alpha"], [2, "Beta"]))).toBe("id,name\r\n1,Alpha\r\n2,Beta");
  });

  it("uses tabs and newline records for TSV", () => {
    expect(toTsv([col("id"), col("name")], rows([1, "Beta"]))).toBe("id\tname\n1\tBeta");
  });

  // The grid shows "NULL" so an empty cell is not mistaken for a bug. A
  // spreadsheet wants the opposite: the literal word would import as text.
  it("writes NULL as an empty field, not the word", () => {
    expect(toCsv([col("a"), col("b")], rows([null, 7]))).toBe("a,b\r\n,7");
  });

  it("quotes fields containing the delimiter, a quote, or a line break", () => {
    const out = toCsv([col("note")], rows(["a,b"], ['say "hi"'], ["line1\nline2"], ["cr\rhere"]));
    expect(out).toBe('note\r\n"a,b"\r\n"say ""hi"""\r\n"line1\nline2"\r\n"cr\rhere"');
  });

  // A tab is only special in TSV, and a comma only in CSV: quoting on the
  // wrong delimiter would be noise in every exported file.
  it("quotes per delimiter, not per format", () => {
    expect(toTsv([col("note")], rows(["a\tb"]))).toBe('note\n"a\tb"');
    expect(toTsv([col("note")], rows(["a,b"]))).toBe("note\na,b");
    expect(toCsv([col("note")], rows(["a\tb"]))).toBe("note\r\na\tb");
  });

  // Records are separated, not terminated: a trailing newline pastes into
  // Excel as a dangling empty row.
  it("emits the header alone when there are no rows", () => {
    expect(toCsv([col("id"), col("name")], [])).toBe("id,name");
    expect(toTsv([col("id")], [])).toBe("id");
  });

  it("never ends with a newline", () => {
    expect(toCsv([col("id")], rows([1]))).toBe("id\r\n1");
    expect(toTsv([col("id")], rows([1]))).toBe("id\n1");
  });

  it("exports a blob as its display placeholder, not its bytes", () => {
    expect(toCsv([col("payload")], rows([{ $blob: "abcd" }]))).toBe("payload\r\n<blob: 4 chars>");
  });

  it("renders numbers without quoting", () => {
    expect(toCsv([col("x")], rows([1.5], [-0], [1e21]))).toBe("x\r\n1.5\r\n0\r\n1e+21");
  });

  // Excel on Windows assumes the system ANSI code page for a BOM-less CSV and
  // shows UTF-8 as mojibake. The clipboard path stays BOM-less deliberately —
  // there the BOM would paste as a stray glyph.
  it("prefixes the byte-order mark for the download path only", () => {
    const columns = [col("id")];
    const body = toCsv(columns, rows([1]));
    const withBom = toCsvWithBom(columns, rows([1]));

    expect(withBom.startsWith(UTF8_BOM)).toBe(true);
    expect(withBom.slice(UTF8_BOM.length)).toBe(body);
    expect(new TextEncoder().encode(withBom).slice(0, 3)).toEqual(
      new Uint8Array([0xef, 0xbb, 0xbf]),
    );
    expect(toTsv(columns, rows([1])).startsWith(UTF8_BOM)).toBe(false);
  });

  it("quotes a column name that needs it", () => {
    expect(toCsv([col('we"ird'), col("a,b")], [])).toBe('"we""ird","a,b"');
  });
});
