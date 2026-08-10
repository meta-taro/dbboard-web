import { IsNotEmpty, IsOptional, IsString } from "class-validator";

// Body schema for POST /ai/explain (web-only — not in
// docs/api-contract.md). Same 422-on-semantic-failure contract as
// QueryRequestDto: the global ValidationPipe in main.ts surfaces
// missing/wrong fields as 422 (errorHttpStatusCode pinned).
export class AiExplainRequestDto {
  @IsString()
  @IsNotEmpty()
  sql!: string;

  // Free-form dialect tag (e.g. "postgres", "sqlite"). The use-case
  // hands it straight to the AI provider which threads it into the
  // prompt; the API does not interpret it.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  dialect?: string;

  // Which configured provider answers (0032 slice B). Omitted means the
  // deployment's default. Only the shape is checked here — whether the
  // name exists is the registry's question, and answering it twice
  // would mean two places deciding what is configured.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  provider?: string;
}
