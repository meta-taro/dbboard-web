import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator";

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
}
