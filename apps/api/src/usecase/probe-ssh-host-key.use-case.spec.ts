import { describe, expect, it, vi } from "vitest";
import { ConnectionError } from "../domain/errors";
import { DEFAULT_SSH_PORT } from "../domain/ssh";
import { ProbeSshHostKey } from "./probe-ssh-host-key.use-case";
import type { SshHostKeyProbe } from "./ssh-host-key-probe.port";

function prober(fingerprint = `SHA256:${"A".repeat(43)}`): SshHostKeyProbe {
  return { probe: vi.fn().mockResolvedValue(fingerprint) };
}

describe("ProbeSshHostKey", () => {
  it("answers with the fingerprint the host presented", async () => {
    const probe = prober("SHA256:abc");

    const output = await new ProbeSshHostKey(probe).execute({ host: "bastion", port: 2222 });

    expect(output).toEqual({ fingerprint: "SHA256:abc" });
    expect(probe.probe).toHaveBeenCalledWith("bastion", 2222);
  });

  it("probes port 22 when the form's port box is empty", async () => {
    // The same default `resolveSshTunnelConfig` applies, and it has to be
    // the same one: a fingerprint fetched from :22 and then pinned against
    // a tunnel dialled at :2222 would compare two different hosts' keys and
    // refuse a connection the operator set up correctly.
    const probe = prober();

    await new ProbeSshHostKey(probe).execute({ host: "bastion" });

    expect(probe.probe).toHaveBeenCalledWith("bastion", DEFAULT_SSH_PORT);
  });

  it("lets an unreachable host surface as the transport reported it", async () => {
    // Not swallowed into an empty fingerprint. A blank box the user then
    // saves is a pin against nothing, which ADR-0069 exists to prevent.
    const probe: SshHostKeyProbe = {
      probe: vi.fn().mockRejectedValue(new ConnectionError("ssh host bastion:22: timed out")),
    };

    await expect(new ProbeSshHostKey(probe).execute({ host: "bastion" })).rejects.toThrowError(
      ConnectionError,
    );
  });
});
