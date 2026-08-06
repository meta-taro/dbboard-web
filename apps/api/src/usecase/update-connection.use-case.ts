import { connectionPartsOf } from "../domain/connection-parts";
import { CapabilityError } from "../domain/errors";
import type { AdapterConfig, AdapterFactory } from "./adapter-factory.port";
import type { ConnectionRegistry } from "./connection-registry.port";
import type { ConnectionView } from "./list-connections.use-case";

export interface UpdateConnectionInput extends AdapterConfig {
  label?: string;
}

// Every field of `AdapterConfig`, as a value the runtime can iterate. A
// `Record` keyed by the type rather than an array because it is exhaustive
// by construction: a field added to `AdapterConfig` and not listed here is a
// compile error, not a box the edit form silently cannot change.
const CONNECTION_FIELDS: Record<keyof AdapterConfig, true> = {
  connectionString: true,
  host: true,
  port: true,
  database: true,
  user: true,
  password: true,
  sslMode: true,
  authToken: true,
};

/**
 * Re-points or renames a registered connection.
 *
 * The web half of desktop's `update_connection` (ADR-0080 decision 4). Two
 * rules carry over, and both exist to keep an edit from destroying something
 * the user did not mention:
 *
 * **A blank password means keep**, never remove. That decision lives in
 * `carryCredential`, one layer down, because the graft is per-driver — but
 * it is the reason this use case can accept an edit that names no
 * credential at all.
 *
 * **The connection details are replaced as a set, not merged field by
 * field.** The form submits every box it rendered, so a field that is absent
 * was cleared, and merging would make an emptied user or database box
 * unsavable. The exception is a body that mentions no connection detail at
 * all — a rename — which leaves the live pool alone rather than dropping
 * every open socket to re-authenticate with identical settings.
 *
 * The driver is not editable. Swapping it under a live id would keep the
 * label while changing what the connection is; delete and add says that out
 * loud.
 */
export class UpdateConnection {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly adapterFactory: AdapterFactory,
  ) {}

  async execute(id: string, input: UpdateConnectionInput): Promise<ConnectionView> {
    const record = this.registry.get(id);
    if (!record) {
      // Matches ExecuteQuery's unknown-connection path: 404, not 500. A tab
      // left open on a connection someone else deleted is ordinary.
      throw new CapabilityError(`unknown connection: ${id}`);
    }

    const { label, ...config } = input;
    const next = { ...record, ...(label !== undefined && { label }) };

    if (namesConnectionDetail(config)) {
      // Build before tearing down. The factory validates, so an edit that
      // names no host must cost the user nothing — least of all the
      // connection they were in the middle of editing.
      next.adapter = this.adapterFactory.rebuild(record.adapter, record.driver, config);
      await closeQuietly(record.adapter);

      const parts = connectionPartsOf(config);
      if (parts === undefined) delete next.parts;
      else next.parts = parts;
    }

    // An upsert — `add` replaces by id and keeps the record's position, so a
    // renamed connection does not move to the bottom of the sidebar.
    this.registry.add(next);

    const { id: recordId, label: recordLabel, driver, parts } = next;
    return { id: recordId, label: recordLabel, driver, ...(parts && { parts }) };
  }
}

function namesConnectionDetail(config: AdapterConfig): boolean {
  const fields = Object.keys(CONNECTION_FIELDS) as Array<keyof AdapterConfig>;
  // `!== undefined` rather than key presence: a field the DTO declared and
  // the body omitted may arrive either way depending on the transformer, and
  // "present but undefined" is not a statement about the connection.
  return fields.some((field) => config[field] !== undefined);
}

async function closeQuietly(adapter: { close?: () => Promise<void> }): Promise<void> {
  if (!adapter.close) return;
  try {
    await adapter.close();
  } catch {
    // Same reading as DeleteConnection: the caller asked for the connection
    // to point somewhere else, the replacement is already live, and a pool
    // that will not shut down cleanly is not their problem.
  }
}
