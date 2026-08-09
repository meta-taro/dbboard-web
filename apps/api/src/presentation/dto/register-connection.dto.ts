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

// Body schema for POST /connections. 0003 persisted label + driver.
// 0004 adds the optional postgres connection fields — class-validator
// drops anything else via the global `whitelist: true` pipe, so the
// envelope stays small and predictable.
//
// Cross-field validation ("postgres needs connectionString or host") is
// deferred to the adapter factory: it surfaces CapabilityError (404) so
// the route reports the same shape whether the driver is unknown or the
// config is incomplete. The DTO stays declarative.
export class RegisterConnectionDto {
  @IsString()
  @IsNotEmpty()
  label!: string;

  @IsString()
  @IsNotEmpty()
  driver!: string;

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

  @IsOptional()
  @IsString()
  password?: string;

  // The form's TLS select, as a field rather than a query parameter, so
  // the split-fields path can express it at all — it composes no URL and
  // has nowhere to write `?sslmode=`. On the connectionString path it
  // outranks whatever the URL says, because the select must report the
  // choice it actually makes.
  //
  // Spelled camelCase to match `connectionString`; libpq's own spelling
  // is `sslmode`, and that one still works where libpq's conventions
  // apply — inside a pasted connection string.
  //
  // Exactly the two values the select offers. `prefer` is refused here
  // even though the resolver hardens it inside a URL: as a field it
  // claims the select was on an option that does not exist. Stricter
  // modes are refused because honouring them would need a CA this API
  // has nowhere to accept, and resolving them down to `require` would
  // promise a verification it does not perform.
  @IsOptional()
  @IsIn(SSL_MODES)
  sslMode?: SslMode;

  // Turso's bearer token (0031 slice A). A field of its own rather than a
  // reuse of `password` — see `AdapterConfig.authToken`. Declared here for
  // the same reason every other config field is: the global
  // `whitelist: true` pipe strips what is not declared, so an undeclared
  // token would be dropped silently and the connection would register
  // unauthenticated.
  @IsOptional()
  @IsString()
  authToken?: string;

  // D1 addresses a database by two ids in the REST path (0031 slice B).
  // Declared for the same whitelist reason as everything above; the format
  // is checked in `createD1Adapter`, which is where knowing what a
  // Cloudflare path segment may contain belongs.
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  databaseId?: string;

  // The bastion in front of this connection (0031 slice D). The whitelist
  // trap the fields above describe, at its worst: an undeclared `ssh` block
  // is stripped before the factory sees it, so the connection registers —
  // with no error anywhere — going straight at the database the operator was
  // tunnelling to reach.
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SshTunnelDto)
  ssh?: SshTunnelDto;
}
