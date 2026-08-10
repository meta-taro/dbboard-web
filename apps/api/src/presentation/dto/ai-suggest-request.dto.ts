import { Type } from "class-transformer";
import { IsArray, IsNotEmpty, IsOptional, IsString, ValidateNested } from "class-validator";

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

  // Which configured provider answers (0032 slice B) — see
  // AiExplainRequestDto for why existence is not checked here.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  provider?: string;
}
