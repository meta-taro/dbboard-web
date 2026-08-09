import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { SSL_MODES, type SslMode } from "../../domain/ssl-mode";
import { SshTunnelDto } from "./ssh-tunnel.dto";

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

  // No @IsNotEmpty, on the same terms as `password`: a Turso edit form
  // never prefills the token box either, so "" is how it says "untouched".
  @IsOptional()
  @IsString()
  authToken?: string;

  // D1's two path ids. Unlike the token these are not credentials, so a
  // blank one is an ordinary cleared box — `createD1Adapter` refuses it,
  // which is the same answer registration gives.
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  databaseId?: string;

  // The same block registration accepts, and the same reason for declaring
  // it: stripped by the whitelist, an edit that puts a live connection
  // behind a bastion reads as a rename, and the connection keeps going
  // direct — precisely what the operator was editing it to stop.
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SshTunnelDto)
  ssh?: SshTunnelDto;
}
