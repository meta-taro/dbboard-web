import { Type } from "class-transformer";
import { Allow, IsArray, IsNotEmpty, IsOptional, IsString, ValidateNested } from "class-validator";
import type { Value } from "../../domain/values";

// Body schema for POST /connections/:id/rows — the service's only write
// surface (desktop ADR-0042, as shipped in ADR-0063). Mirrors the shape of
// desktop's `update_row` command inputs: `KeyColumnInput { column, value }`
// and `CellEditInput { column, value: Option<String> }`.
//
// The division of labour is deliberate: **this DTO validates shape, and
// `domain/write-back.ts` validates meaning.** An empty `key`, an empty
// `edits`, or a blob identity value are all well-formed JSON asking for
// something impossible, and the domain refuses each by name — "no columns
// were edited", "no row-identity columns to key the update on", 'identity
// column "id" has an unsupported (blob) value'. Re-gating them here would
// replace those messages with a generic 422 on `edits`, so it does not.

/** One identity column paired with the row's **original** value. */
export class KeyColumnDto {
  @IsString()
  @IsNotEmpty()
  column!: string;

  // Whatever the row held: number, text, null, or the contract's `$blob`
  // envelope. Typed rather than coerced to text so the WHERE clause can
  // encode each by its real type — `@Allow()` keeps it through the global
  // pipe's `whitelist: true` without narrowing what a column may contain.
  @Allow()
  value!: Value;
}

/** One column the editor changed, with its new value. */
export class CellEditDto {
  @IsString()
  @IsNotEmpty()
  column!: string;

  // Text, or null/absent for SQL NULL. `@IsOptional()` skips validation for
  // both, so the two spellings of "cleared" behave identically and anything
  // else — a number, an object — is a 422 rather than a silent coercion.
  //
  // `""` is a value, not an absence: an empty string and NULL are different
  // rows, and the editor can produce either on purpose.
  @IsOptional()
  @IsString()
  value?: string | null;
}

export class UpdateRowDto {
  @IsString()
  @IsNotEmpty()
  table!: string;

  // Optional; omitted means "the engine's default", which the adapter
  // resolves. Present-but-empty is rejected for the same reason
  // TableSchemaQueryDto rejects it — a lost value, not an omitted one.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  schema?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KeyColumnDto)
  key!: KeyColumnDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CellEditDto)
  edits!: CellEditDto[];
}
