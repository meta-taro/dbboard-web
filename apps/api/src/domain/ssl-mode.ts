// How a connection is protected in transit. Two values, because those are
// the two the connection form offers and the two this API can honestly
// deliver (ADR-0078 Decision 2).
//
// `prefer` is deliberately absent: it is the mode that attempts TLS and
// continues in plaintext when the server refuses, which is the failure
// this type exists to make unrepresentable. `verify-ca` and `verify-full`
// are absent for the opposite reason — they promise more than `require`,
// and delivering them needs a CA the caller can nominate, which there is
// nowhere to accept yet.
//
// This lives in `domain` rather than beside the Postgres adapter because
// it is not a Postgres detail. Desktop applies the same two-mode rule to
// MySQL (ADR-0078), and a second adapter that reinvented the vocabulary
// would give the same choice two spellings.
//
// Kept as a runtime array because the DTO's validator needs the values,
// not just the type. Deriving the type from the array rather than
// declaring both means the wire check and the resolver cannot drift.
export const SSL_MODES = ["require", "disable"] as const;

export type SslMode = (typeof SSL_MODES)[number];

// Everything that is not an explicit opt-out becomes `require`: nothing at
// all, `prefer`, an unrecognised mode, or a stricter mode we cannot
// express. No input can quietly land on plaintext.
//
// Mirrors desktop's `harden_ssl_mode`. The asymmetry is deliberate — a
// connection the user believes is encrypted and is not is worse than one
// they knowingly turned off, so only the knowing case gets through.
export function hardenSslMode(supplied: string | null | undefined): SslMode {
  return supplied === "disable" ? "disable" : "require";
}
