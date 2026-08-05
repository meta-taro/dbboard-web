import type { DatabaseAdapter } from "../domain/database-adapter.port";
import type { SslMode } from "../domain/ssl-mode";

// Open bag of driver-config fields. The "null" branch ignores everything;
// the "postgres" branch (0004) reads the connection bits. Keeping this
// open (vs. a discriminated union) lets the factory stay driver-agnostic
// — each branch picks what it needs and validates the shape.
export interface AdapterConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  // 0027 slice B. Typed rather than `string` so a driver that later grows
  // its own TLS handling inherits the two-mode vocabulary instead of
  // inventing a third spelling of the same choice.
  sslMode?: SslMode;
}

// Constructs an adapter from a driver discriminator + per-driver config.
// RegisterConnection calls this; the use case stays driver-agnostic.
// 0003 supplied a StaticAdapterFactory that only knew "null"; 0004 adds
// "postgres". An unknown driver raises CapabilityError so the
// `POST /connections` route 404s rather than hard-erroring.
export interface AdapterFactory {
  create(driver: string, config: AdapterConfig): DatabaseAdapter;
}

export const ADAPTER_FACTORY = Symbol("ADAPTER_FACTORY");
