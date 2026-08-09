import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { resolveSshTunnelConfig, type SshTunnelInput } from "../../domain/ssh";
import { SshTunnelDto } from "./ssh-tunnel.dto";

const KEY_MATERIAL = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";

function validate(payload: unknown) {
  const dto = plainToInstance(SshTunnelDto, payload);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: false }) };
}

describe("SshTunnelDto", () => {
  it("is what the domain resolver accepts, not merely something like it", () => {
    // The assertion that matters here is the assignment, and it is checked by
    // `tsc` rather than at runtime: the DTO is the only thing that ever
    // reaches `resolveSshTunnelConfig` over HTTP, so the two shapes drifting
    // apart is a break in the wiring even when every test still passes. It
    // did drift once — see this file's sibling commit.
    const { dto, errors } = validate({
      host: "bastion.example.com",
      user: "deploy",
      privateKey: KEY_MATERIAL,
      fingerprint: "SHA256:abc123",
    });
    expect(errors).toHaveLength(0);

    const input: SshTunnelInput = dto;

    expect(resolveSshTunnelConfig(input)).toEqual({
      host: "bastion.example.com",
      port: 22,
      user: "deploy",
      auth: { kind: "private-key", privateKey: KEY_MATERIAL },
      hostKey: { kind: "fingerprint", fingerprint: "SHA256:abc123" },
    });
  });
});
