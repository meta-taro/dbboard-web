import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator";

/**
 * Body schema for the host-key probe (0031 slice D).
 *
 * The bastion half of `SshTunnelDto` and nothing else: the probe reads a key
 * before any credential exists to send, so a body carrying one would be a
 * secret with nowhere to go.
 */
export class ProbeSshHostKeyDto {
  @IsString()
  @IsNotEmpty()
  host!: string;

  // Absent means 22, resolved in the use case. Out of range is refused here
  // rather than clamped — a probe of the wrong port pins the wrong key.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;
}
