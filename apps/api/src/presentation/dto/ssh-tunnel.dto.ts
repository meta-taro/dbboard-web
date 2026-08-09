import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator";

/**
 * The `ssh` block of a connection body (0031 slice D).
 *
 * Shared by registration and editing, because putting a connection behind a
 * bastion and registering one already behind it are the same statement.
 *
 * Declared as a class, and mounted with `@ValidateNested()`, for the reason
 * every other config field is declared: the global `whitelist: true` pipe
 * strips what it does not know. A plain `@IsObject() ssh?: object` would keep
 * the block but let anything through inside it — including a `privateKeyPath`
 * this shape deliberately does not have (see `SshTunnelConfig`: web takes key
 * *material*, because a path field would make the API process read files off
 * the server on request).
 *
 * Only per-field shape is checked here. The pairing rules — exactly one of
 * privateKey/password, exactly one of fingerprint/knownHosts (ADR-0069) —
 * belong to `resolveSshTunnelConfig`, which enforces them for every caller
 * rather than only for the ones that arrived over HTTP.
 */
export class SshTunnelDto {
  // Required, unlike most of what a connection body carries: an `ssh` block
  // naming no bastion is malformed at the shape level rather than a
  // cross-field question, and 422 says that more clearly than the 404 the
  // domain resolver would answer with.
  @IsString()
  @IsNotEmpty()
  host!: string;

  // Absent means 22 — the default `resolveSshTunnelConfig` applies. An
  // integer here like the connection's own `port`, so the two boxes on the
  // form behave the same way.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsString()
  @IsNotEmpty()
  user!: string;

  // PEM text, not a path. Optional because the password branch is the other
  // half of the pair, and which one is present is the domain's question.
  @IsOptional()
  @IsString()
  privateKey?: string;

  @IsOptional()
  @IsString()
  passphrase?: string;

  @IsOptional()
  @IsString()
  password?: string;

  // The pin the operator confirmed, and the `known_hosts` text as the other
  // way of expressing one. Neither is validated for format here — both are
  // compared, not parsed, by `verifyHostKey`.
  @IsOptional()
  @IsString()
  fingerprint?: string;

  @IsOptional()
  @IsString()
  knownHosts?: string;
}
