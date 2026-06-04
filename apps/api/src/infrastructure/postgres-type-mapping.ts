import { Logger } from "@nestjs/common";
import { encodeBlob, type Value } from "../domain/values/value";

// pg_type.oid → contract `Value` decoder. Source for the mapping table is
// `.claude/issues/0004-postgres-adapter.md` § Type mapping. The pool is
// configured (see postgres-adapter.ts) so every column comes back as raw
// text — that keeps the inputs to this function fully deterministic and
// the unit tests don't have to mirror pg-types' parser branches.

const logger = new Logger("PostgresTypeMapping");

const PG_OID = {
  BOOL: 16,
  BYTEA: 17,
  CHAR: 18,
  NAME: 19,
  INT8: 20,
  INT2: 21,
  INT4: 23,
  TEXT: 25,
  JSON: 114,
  FLOAT4: 700,
  FLOAT8: 701,
  BPCHAR: 1042,
  VARCHAR: 1043,
  DATE: 1082,
  TIME: 1083,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  NUMERIC: 1700,
  UUID: 2950,
  JSONB: 3802,
} as const;

const OID_TO_NAME: Readonly<Record<number, string>> = Object.freeze({
  [PG_OID.BOOL]: "bool",
  [PG_OID.BYTEA]: "bytea",
  [PG_OID.CHAR]: "char",
  [PG_OID.NAME]: "name",
  [PG_OID.INT8]: "int8",
  [PG_OID.INT2]: "int2",
  [PG_OID.INT4]: "int4",
  [PG_OID.TEXT]: "text",
  [PG_OID.JSON]: "json",
  [PG_OID.FLOAT4]: "float4",
  [PG_OID.FLOAT8]: "float8",
  [PG_OID.BPCHAR]: "bpchar",
  [PG_OID.VARCHAR]: "varchar",
  [PG_OID.DATE]: "date",
  [PG_OID.TIME]: "time",
  [PG_OID.TIMESTAMP]: "timestamp",
  [PG_OID.TIMESTAMPTZ]: "timestamptz",
  [PG_OID.NUMERIC]: "numeric",
  [PG_OID.UUID]: "uuid",
  [PG_OID.JSONB]: "jsonb",
});

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIG = BigInt(Number.MIN_SAFE_INTEGER);

export function pgOidToName(oid: number): string | null {
  return OID_TO_NAME[oid] ?? null;
}

export function pgOidToValue(oid: number, raw: unknown): Value {
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  switch (oid) {
    case PG_OID.INT2:
    case PG_OID.INT4:
      return Number(s);
    case PG_OID.INT8: {
      // int8 exceeds Number.MAX_SAFE_INTEGER by design. BigInt parse first,
      // then narrow to number only when it round-trips losslessly.
      const big = BigInt(s);
      if (big >= MIN_SAFE_BIG && big <= MAX_SAFE_BIG) return Number(big);
      return s;
    }
    case PG_OID.FLOAT4:
    case PG_OID.FLOAT8:
      return Number(s);
    case PG_OID.NUMERIC: {
      // Numeric is arbitrary-precision; surface as Text when the Number
      // round-trip would silently truncate or rename ("1.20" → "1.2").
      const n = Number(s);
      if (Number.isFinite(n) && String(n) === s) return n;
      return s;
    }
    case PG_OID.BOOL:
      return s === "t" || s === "true" ? 1 : 0;
    case PG_OID.BYTEA: {
      // Postgres 9.0+ defaults to hex output ('\x...'). The else-branch
      // keeps legacy escape-format bytes intact — unlikely on modern
      // servers but cheap to support.
      const bytes = s.startsWith("\\x") ? Buffer.from(s.slice(2), "hex") : Buffer.from(s, "binary");
      return encodeBlob(new Uint8Array(bytes));
    }
    case PG_OID.TEXT:
    case PG_OID.VARCHAR:
    case PG_OID.CHAR:
    case PG_OID.BPCHAR:
    case PG_OID.NAME:
    case PG_OID.UUID:
    case PG_OID.JSON:
    case PG_OID.JSONB:
      return s;
    case PG_OID.TIMESTAMP:
      return s.replace(" ", "T");
    case PG_OID.TIMESTAMPTZ:
      // Postgres emits "+00" / "-05"; ISO 8601 strict wants "+HH:MM".
      return s.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    case PG_OID.DATE:
    case PG_OID.TIME:
      return s;
    default:
      logger.log(`unknown Postgres OID ${oid}, falling back to Text`);
      return s;
  }
}
