/**
 * Split a `.sql` script into individual statements — Layer 1 of the restore
 * pipeline (desktop ADR-0051), the web mirror of
 * `crates/dbboard-core/src/restore/split.rs`.
 *
 * This is the *raw* splitter. It scans the script's lexical structure
 * (string literals, quoted identifiers, dollar-quoted bodies, comments) so
 * that a `;` living inside any of those does not split a statement. It
 * classifies nothing — whether a resulting statement is a `CREATE`, an
 * `INSERT`, or garbage is `plan.ts`'s job.
 *
 * Being lexical rather than grammatical, it is robust to *any* `.sql` we
 * might be handed, which is what ADR-0051 scoped the feature to: dbboard's
 * own dumps, `pg_dump` output (dollar-quoted function bodies, `E'…'` escape
 * strings) and `sqlite3 .dump` output (back-tick identifiers) all split
 * correctly. It never parses, so it cannot reject or rewrite; it only finds
 * statement boundaries.
 *
 * Two things worth stating before reading the scanner:
 *
 * **A backslash is an escape character only inside a Postgres `E'…'` string.**
 * In a standard literal (`standard_conforming_strings`, the `pg_dump` default
 * since PostgreSQL 9.1, and SQLite always) a backslash is an ordinary
 * character and the only in-string quote escape is a doubled `''`. Honouring
 * backslash everywhere would mis-scan `'a\'` — a complete two-character
 * string — as an unterminated one, swallowing the rest of the script.
 *
 * **Indexing is by UTF-16 code unit, not by code point.** Desktop collects a
 * `Vec<char>`; the same move in JavaScript is an array of one-character
 * strings, which for a multi-megabyte script costs an order of magnitude more
 * memory than the script itself. Every delimiter this scanner recognises is
 * ASCII, and no half of a surrogate pair can equal one, so scanning code units
 * is exact for all of them. The single Unicode-sensitive spot is the
 * identifier test for dollar-quote tags: an astral-plane letter in a `$tag$`
 * ends the tag scan early, which makes the `$` an ordinary character rather
 * than a quote opener. That is a boundary this splitter would find anyway if
 * the tag were absent, and no engine's dump emits such a tag.
 */

/**
 * Split `sql` into its constituent statements, dropping the `;` delimiters
 * and any segment that is only whitespace and comments.
 *
 * Each returned string is one statement's source text, trimmed of surrounding
 * whitespace but otherwise verbatim (interior comments are preserved — every
 * supported engine tolerates them). A trailing statement with no terminating
 * `;` is still returned. Unterminated strings, identifiers and dollar quotes
 * consume to end of input rather than throwing: this layer reports no
 * diagnostics.
 */
export function splitStatements(sql: string): string[] {
  const n = sql.length;
  const statements: string[] = [];
  let start = 0;
  let hasContent = false;
  let i = 0;

  while (i < n) {
    const c = sql[i] as string;
    if (c === "-" && sql[i + 1] === "-") {
      // Line comment `-- … ⏎`. A lone `-` (subtraction, negative literal)
      // falls through to the content branch below.
      i += 2;
      while (i < n && sql[i] !== "\n") i += 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i);
    } else if (c === "'") {
      i = skipSingleQuoted(sql, i, isEscapeStringOpener(sql, i));
      hasContent = true;
    } else if (c === '"' || c === "`") {
      i = skipDelimited(sql, i, c);
      hasContent = true;
    } else if (c === "$") {
      hasContent = true;
      const opened = tryOpenDollarQuote(sql, i);
      i = opened === null ? i + 1 : findDollarClose(sql, opened.bodyStart, opened.delim);
    } else if (c === ";") {
      if (hasContent) statements.push(sql.slice(start, i).trim());
      i += 1;
      start = i;
      hasContent = false;
    } else {
      if (!isWhitespace(c)) hasContent = true;
      i += 1;
    }
  }

  if (hasContent) statements.push(sql.slice(start, n).trim());
  return statements;
}

/**
 * Is the `'` at `quote` the opening quote of a Postgres `E'…'` escape string?
 *
 * True when the immediately preceding character is a word-boundary `E`/`e` —
 * an `E` that is not the tail of a longer identifier, so that `type '\'` is
 * read as a standard string rather than as `e'\''`.
 */
function isEscapeStringOpener(sql: string, quote: number): boolean {
  if (quote === 0) return false;
  const prev = sql[quote - 1];
  if (prev !== "e" && prev !== "E") return false;
  return quote < 2 || !isIdentChar(sql[quote - 2] as string);
}

/**
 * Advance past a single-quoted string. `escapes` enables backslash escapes
 * (Postgres `E'…'` only); the doubled-quote escape `''` always applies.
 * Starts at the opening quote, returns the index just past the closing one.
 */
function skipSingleQuoted(sql: string, open: number, escapes: boolean): number {
  const n = sql.length;
  let i = open + 1;
  while (i < n) {
    const c = sql[i];
    if (escapes && c === "\\" && i + 1 < n) {
      i += 2;
      continue;
    }
    if (c === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return n;
}

/**
 * Advance past a `delim`-quoted identifier (`"…"` or `` `…` ``) whose only
 * escape is the doubled delimiter. Starts at the opener, returns just past
 * the closer.
 */
function skipDelimited(sql: string, open: number, delim: string): number {
  const n = sql.length;
  let i = open + 1;
  while (i < n) {
    if (sql[i] === delim) {
      if (sql[i + 1] === delim) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return n;
}

/**
 * Advance past a block comment, honouring Postgres nesting. Starts at the
 * opening `/`, returns just past the outermost closer.
 */
function skipBlockComment(sql: string, open: number): number {
  const n = sql.length;
  let depth = 1;
  let i = open + 2;
  while (i < n) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      depth += 1;
      i += 2;
    } else if (sql[i] === "*" && sql[i + 1] === "/") {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return n;
}

interface DollarQuoteOpen {
  bodyStart: number;
  delim: string;
}

/**
 * If a dollar quote opens at `dollar` (`$tag$` with an identifier-shaped or
 * empty tag), return the body-start index and the full `$tag$` delimiter.
 *
 * A bare `$1` parameter placeholder — a `$` not closed by a second `$` after
 * a valid tag — returns `null`, because a non-empty tag cannot start with a
 * digit.
 */
function tryOpenDollarQuote(sql: string, dollar: number): DollarQuoteOpen | null {
  const n = sql.length;
  let j = dollar + 1;
  if (j < n && isTagStartChar(sql[j] as string)) {
    j += 1;
    while (j < n && isIdentChar(sql[j] as string)) j += 1;
  }
  if (j < n && sql[j] === "$") {
    return { bodyStart: j + 1, delim: sql.slice(dollar, j + 1) };
  }
  return null;
}

/**
 * Find the closing dollar quote `delim` at or after `from`, returning the
 * index just past it — or end of input if unterminated.
 */
function findDollarClose(sql: string, from: number, delim: string): number {
  const at = sql.indexOf(delim, from);
  return at === -1 ? sql.length : at + delim.length;
}

const TAG_START = /\p{Alphabetic}/u;
const IDENT_CHAR = /[\p{Alphabetic}\p{N}_]/u;
const WHITESPACE = /\s/u;

function isTagStartChar(c: string): boolean {
  return c === "_" || TAG_START.test(c);
}

function isIdentChar(c: string): boolean {
  return IDENT_CHAR.test(c);
}

function isWhitespace(c: string): boolean {
  return WHITESPACE.test(c);
}
