import type { SshHostKeyProbe } from "../usecase/ssh-host-key-probe.port";
import { probeHostKey, type SshTunnelDeps } from "./ssh-tunnel";

/**
 * `probeHostKey` behind the port the use case depends on (0031 slice D).
 *
 * Thin on purpose — the interesting part (capture the key, then refuse it, so
 * the session never reaches auth) is in `probeHostKey`, where the transport
 * lives. `deps` is the same seam the tunnel takes, so a test can drive this
 * without an ssh2 client.
 */
export class SshHostKeyProber implements SshHostKeyProbe {
  constructor(private readonly deps: SshTunnelDeps = {}) {}

  async probe(host: string, port: number): Promise<string> {
    return probeHostKey(host, port, this.deps);
  }
}
