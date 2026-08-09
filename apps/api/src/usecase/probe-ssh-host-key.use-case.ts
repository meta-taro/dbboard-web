import { DEFAULT_SSH_PORT } from "../domain/ssh";
import type { SshHostKeyProbe } from "./ssh-host-key-probe.port";

export interface ProbeSshHostKeyInput {
  host: string;
  port?: number;
}

export interface ProbeSshHostKeyOutput {
  fingerprint: string;
}

/**
 * Fetches the fingerprint a bastion presents, so the operator can look at it
 * and decide whether to pin it (ADR-0076).
 *
 * The web half of desktop's `probe_ssh_host_key`. Two properties make it safe
 * to expose, and both live one layer down in `probeHostKey`: it never
 * authenticates — the key is captured and then refused, so no credential
 * reaches a host whose identity is still unverified — and it never writes.
 * The answer fills a form field; saving it stays a deliberate act rather than
 * trust-on-first-use behind the operator's back.
 *
 * This layer adds one thing: the same port default the tunnel itself uses. A
 * fingerprint fetched from one port and pinned against a tunnel dialled at
 * another would compare two hosts' keys and refuse a connection that was set
 * up correctly.
 */
export class ProbeSshHostKey {
  constructor(private readonly prober: SshHostKeyProbe) {}

  async execute(input: ProbeSshHostKeyInput): Promise<ProbeSshHostKeyOutput> {
    const fingerprint = await this.prober.probe(input.host, input.port ?? DEFAULT_SSH_PORT);
    return { fingerprint };
  }
}
