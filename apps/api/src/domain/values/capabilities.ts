// Adapter-discovery capabilities, per docs/api-contract.md § Capabilities
// and desktop ADR-0012. Forward-compat: clients tolerate additional flags
// — adding a flag is non-breaking, renaming or removing one is breaking.

export interface Capabilities {
  has_views: boolean;
  has_functions: boolean;
  has_auth: boolean;
  has_storage: boolean;
  has_realtime: boolean;
  // Added after the original five, each by the desktop ADR that gave the
  // flag something to promise. Kept here rather than in a second type so
  // the wire object stays flat — see `docs/api-contract.md` § Capabilities.
  has_describe_table: boolean; // desktop ADR-0028
  has_table_ddl: boolean; // desktop ADR-0049 (dump)
  has_execute: boolean; // desktop ADR-0051 (restore)
  has_atomic_restore: boolean; // desktop ADR-0051 (restore)
  has_foreign_keys: boolean; // desktop ADR-0054 (relationship discovery)
  has_list_indexes: boolean; // desktop ADR-0152 (schema comparison)
  has_list_databases: boolean; // desktop ADR-0162 (every database a connection can see)
  has_history: boolean; // desktop ADR-0165 (the history a versioned database keeps)
  // Desktop only: a person approving an agent's change happens in the
  // desktop window and never over HTTP (ADR-0176), so web reports it false
  // for good. It is still on the wire so the object has one shape.
  has_review: boolean; // desktop ADR-0176
}

// Used by NullAdapter and as the Phase-2 baseline: every adapter ships
// with every flag false, and later phases set flags alongside the
// endpoints that implement them.
export const NULL_CAPABILITIES: Capabilities = {
  has_views: false,
  has_functions: false,
  has_auth: false,
  has_storage: false,
  has_realtime: false,
  has_describe_table: false,
  has_table_ddl: false,
  has_execute: false,
  has_atomic_restore: false,
  has_foreign_keys: false,
  has_list_indexes: false,
  has_list_databases: false,
  has_history: false,
  has_review: false,
};
