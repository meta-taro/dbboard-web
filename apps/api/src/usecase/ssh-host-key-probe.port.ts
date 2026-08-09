/**
 * Reads a bastion's host-key fingerprint without authenticating.
 *
 * A port rather than a direct call into `infrastructure/ssh-tunnel`, on the
 * same terms as `AdapterFactory`: the use case says what it needs, and the
 * suite can supply it without a bastion to dial.
 */
export interface SshHostKeyProbe {
  /**
   * @returns the fingerprint in `SHA256:<base64>` form.
   * @throws {ConnectionError} if the host presented no key. Never an empty
   * string — the caller is about to offer this for pinning.
   */
  probe(host: string, port: number): Promise<string>;
}

export const SSH_HOST_KEY_PROBE = Symbol("SSH_HOST_KEY_PROBE");
