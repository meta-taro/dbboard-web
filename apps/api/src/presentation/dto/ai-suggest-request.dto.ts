import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

// One introspected table, as the panel already knows it. Mirrors the
// domain `TableInfo` rather than reusing it because a wire DTO needs
// decorators and a domain value must not carry them.
export class AiTableInfoDto {
  // Absent and null both mean "unqualified" — the caller may simply not
  // have a schema concept (SQLite, D1). `@IsOptional` skips null as well
  // as undefined, so a wrong *type* is still a 422. The controller
  // normalises the absent case to null before it reaches the domain.
  @IsOptional()
  @IsString()
  schema?: string | null;

  @IsString()
  @IsNotEmpty()
  name!: string;
}

// One described column, mirroring the domain `ColumnInfo` (ADR-0028
// Decision 9). snake_case on the wire because these fields *are* the
// wire: the panel round-trips what GET /connections/:id/table-schema
// answered, and renaming them here would mean the browser translating a
// shape it received intact.
//
// The full shape is required, not best-effort. The only producer is that
// route, so a partial column is a hand-rolled body, and a 422 naming the
// missing field beats prompting the model with a column described half
// way — a nullable flag read off a missing key would state the opposite
// of the schema.
export class AiColumnInfoDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  // Null is a real value here ("the engine reports no type"), so it is
  // `@IsOptional` — which skips null — rather than a required string.
  @IsOptional()
  @IsString()
  declared_type?: string | null;

  @IsBoolean()
  nullable!: boolean;

  @IsBoolean()
  primary_key!: boolean;

  @IsInt()
  ordinal!: number;

  @IsOptional()
  @IsString()
  default_value?: string | null;
}

export class AiTableSchemaDto {
  // `@IsDefined` is load-bearing: `@ValidateNested` alone skips an
  // absent value, so without it a `{columns, primary_key}` entry with no
  // table at all would validate and then render as `CREATE TABLE
  // undefined`.
  @IsDefined()
  @ValidateNested()
  @Type(() => AiTableInfoDto)
  table!: AiTableInfoDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AiColumnInfoDto)
  columns!: AiColumnInfoDto[];

  // Key order matters for a composite key and is lost if a reader
  // derives it from the per-column flags, so it travels separately.
  @IsArray()
  @IsString({ each: true })
  primary_key!: string[];
}

// Body schema for POST /ai/suggest (web-only — not in
// docs/api-contract.md). Twin of AiExplainRequestDto with `prompt`
// in place of `sql`.
export class AiSuggestRequestDto {
  @IsString()
  @IsNotEmpty()
  prompt!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  dialect?: string;

  // The table list, optional at every layer (desktop ADR-0028 Decision 8).
  // No separate size cap: the 64 KiB body limit already bounds it, and a
  // second limit here would be a second number to keep in step.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AiTableInfoDto)
  schema?: AiTableInfoDto[];

  // The described tables, when the panel prefetched them (ADR-0028
  // Decision 9). Additive: both halves may arrive together and the
  // prompt builder prefers this one when it is non-empty. Same reasoning
  // on the size cap as `schema` above — the body limit already bounds it.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AiTableSchemaDto)
  full_schema?: AiTableSchemaDto[];

  // Which configured provider answers (0032 slice B) — see
  // AiExplainRequestDto for why existence is not checked here.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  provider?: string;
}
