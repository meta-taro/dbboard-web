import type { ConnectionParts } from "../domain/connection-parts";
import type { SshParts } from "../domain/ssh";
import type { ConnectionRegistry } from "./connection-registry.port";

export interface ConnectionView {
  id: string;
  label: string;
  driver: string;
  // Absent when the connection has no address to describe. `ConnectionParts`
  // has no password member, which is what lets this cross the wire at all
  // (0027 slice F).
  parts?: ConnectionParts;
  // Absent when the connection is direct. `SshParts` names the tunnel's
  // credential only by kind, which is what lets this cross the wire
  // (0031 slice F).
  ssh?: SshParts;
}

export interface ListConnectionsOutput {
  connections: ConnectionView[];
}

// Projects the registry records into the public view shape. Drops the
// adapter instance and the credential — `GET /connections` must never
// expose a password or a full connection string. What it does carry, since
// 0027 slice F, is the non-secret half, so the edit form has something to
// open with; the record itself never held the rest.
export class ListConnections {
  constructor(private readonly registry: ConnectionRegistry) {}

  execute(): ListConnectionsOutput {
    return {
      connections: this.registry.list().map(({ id, label, driver, parts, ssh }) => ({
        id,
        label,
        driver,
        // Spread rather than assigned, so a connection with nothing to
        // describe answers with no key instead of a null the caller has to
        // interpret. Named explicitly — a `...rest` here would forward
        // whatever the record gains next, which is how the adapter would
        // eventually cross out.
        ...(parts && { parts }),
        ...(ssh && { ssh }),
      })),
    };
  }
}
