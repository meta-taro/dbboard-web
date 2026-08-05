import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator";
import { SSL_MODES, type SslMode } from "../../domain/ssl-mode";

// Body schema for PATCH /connections/:id (0027 slice G).
//
// Deliberately not `PartialType(RegisterConnectionDto)`. Two fields differ,
// and both differences are the point:
//
//   * `driver` is absent. It is not editable — see UpdateConnection.
//   * `password` accepts the empty string, where registration does not.
//     A form that round-trips its inputs sends "" for a box nobody typed
//     in, and that has to reach the use case as "keep what you have"
//     rather than being rejected at the door (ADR-0080).
//
// Everything else mirrors RegisterConnectionDto field for field, including
// the reasons — see that file for why `sslMode` is a field rather than a
// query parameter and why only two modes are accepted.
export class UpdateConnectionDto {
  // Optional like every other field, because PATCH may say nothing about a
  // name. Still rejected when blank: an unnamed connection is unfindable in
  // the sidebar, and no form has a reason to submit one.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  label?: string;

  @IsOptional()
  @IsString()
  connectionString?: string;

  @IsOptional()
  @IsString()
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsString()
  database?: string;

  @IsOptional()
  @IsString()
  user?: string;

  // No @IsNotEmpty: blank is the whole vocabulary of "I did not touch this".
  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsIn(SSL_MODES)
  sslMode?: SslMode;
}
