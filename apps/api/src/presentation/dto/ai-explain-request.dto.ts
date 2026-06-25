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
}
