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
};
