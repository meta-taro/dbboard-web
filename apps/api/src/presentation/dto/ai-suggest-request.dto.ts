import { IsNotEmpty, IsOptional, IsString } from "class-validator";

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
}
