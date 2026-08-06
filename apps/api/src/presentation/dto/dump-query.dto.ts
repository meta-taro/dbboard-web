import { IsIn, IsOptional } from "class-validator";

// Query schema for GET /connections/:id/dump.
//
// `confirm` is the client's answer to the size gate (ADR-0049 Decision 8,
// warn-and-allow). Desktop asks in a modal and proceeds on OK; web has no
// modal in the request path, so the first request is refused naming the
// row count and the client re-sends with `confirm=true`.
//
// Only the two spellings are accepted. Silently reading anything else as
// "not confirmed" would turn `?confirm=1` or `?confirm=yes` into the size
// refusal a second time, and the caller would have no way to tell that the
// value — rather than the database — was the problem.
export class DumpQueryDto {
  @IsOptional()
  @IsIn(["true", "false"])
  confirm?: string;
}
