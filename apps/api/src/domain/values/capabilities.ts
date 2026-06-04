// Adapter-discovery capabilities, per docs/api-contract.md § Capabilities
// and desktop ADR-0012. Forward-compat: clients tolerate additional flags
// — adding a flag is non-breaking, renaming or removing one is breaking.

export interface Capabilities {
  has_views: boolean;
  has_functions: boolean;
  has_auth: boolean;
  has_storage: boolean;
  has_realtime: boolean;
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
};
