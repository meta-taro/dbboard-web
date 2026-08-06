import { IsIn, IsOptional } from "class-validator";

// Query schema for POST /connections/:id/restore.
//
// The two options travel as query parameters because the body is already
// spoken for: it carries the `.sql` script verbatim, so there is nowhere in
// it to put a flag.
//
// `confirmed` is the caller's answer to the empty-target gate (ADR-0051).
// `on_error` only affects the per-statement path — an atomic batch is
// all-or-nothing by construction.
//
// Both are strict about spelling, which is a deliberate divergence from
// desktop: `on_error_from` there reads anything that is not `"continue"` as
// stop, because it is parsing a string its own frontend just produced. Over
// HTTP the caller is not us. Reading `?confirmed=1` as "not confirmed" would
// hand back the empty-target refusal a second time with no way to tell that
// the value — rather than the target — was the problem, and reading
// `?on_error=abort` as stop would quietly run under a policy nobody asked
// for. Same defaults as desktop; only a malformed value is treated
// differently, and 422 says which one it was.
export class RestoreQueryDto {
  @IsOptional()
  @IsIn(["true", "false"])
  confirmed?: string;

  @IsOptional()
  @IsIn(["stop", "continue"])
  on_error?: string;
}
