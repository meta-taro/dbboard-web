import { IsNotEmpty, IsString } from "class-validator";

// Body schema for POST /query and POST /connections/:id/query.
// Per the contract, semantic failures (missing/wrong-type sql) are 422 —
// the global ValidationPipe in main.ts is configured to surface this
// class as 422 (errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY).
// Malformed JSON falls through to Nest's default 400 before this DTO
// is ever instantiated, which is exactly what the contract calls for.
export class QueryRequestDto {
  @IsString()
  @IsNotEmpty()
  sql!: string;
}
