# 0027 — The connection form: parts, and a TLS choice that is not a lie

**Status:** open (2026-08-05) · **Opened:** 2026-08-05 · **Rung 5** of
[`../parity-ledger.md`](../parity-ledger.md)

## Purpose

Rung 5 is the connection form. It mirrors five desktop ADRs:

| Desktop         | Subject                                                       | Ledger status                  |
| --------------- | ------------------------------------------------------------- | ------------------------------ |
| ADR-0073        | Credentials entered as parts, not a hand-written DSN          | `todo`                         |
| ADR-0078 / 0079 | TLS is a form choice, defaulting to required                  | `todo` — **security-relevant** |
| ADR-0080        | The edit form asks what the add form asks                     | `todo`                         |
| ADR-0074        | Unsupported kinds disabled in the list, not refused on submit | `todo`                         |

Re-deriving the rows against both codebases (baseline §19: the shipped code is
the authority, the ledger row is a hypothesis) changed four of the five. One of
the corrections is a live security divergence that no row records, and it
reorders the slices. The corrections are below in full, because they are the
more useful artifact.

## What the survey got wrong

### Web does not merely lack a TLS control — it defaults to plaintext

Not in the ledger at all, and it is the reason this rung exists.

`resolvePostgresPoolOptions` (`apps/api/src/infrastructure/postgres-connection-config.ts`)
defaults an unspecified `sslmode` to `prefer`, and `createPostgresAdapter`
resolves `prefer` to `ssl: false`. Web therefore does not attempt TLS at all
unless the host ends in `.neon.tech` or `.supabase.co`, or the caller wrote
`sslmode=require` by hand. The code says so plainly:

```ts
// require → TLS, disable/prefer → no TLS
ssl: opts.sslmode === "require" ? { rejectUnauthorized: false } : false,
```

Desktop does the opposite. `harden_ssl_mode` rewrites sqlx's unspecified
default **up** to `Required` in both the MySQL and Postgres adapters, on the
stated ground that "a connection the user believes is encrypted and is not is
worse than one they knowingly turned off" (ADR-0078 § Context).

This is not a cosmetic gap, and it makes the obvious slice order wrong.
ADR-0078 Decision 3 says `require` should emit **no** query parameter, because
"the adapter's hardening supplies the mode". Web has no hardening to lean on.
Mirroring that decision first would ship a form whose default option reads
**Required** and whose composed URL produces a plaintext connection — a control
that reports the opposite of what it does, which is worse than the missing
control it replaces.

**So the adapter is hardened before the form gains a control, not after.** Same
shape as rung 4's finding, one layer down: a row can name the right destination
and be silent about what has to already be true for it to mean anything.

### The API already takes parts; only the form does not

Ledger row for ADR-0073 reads `todo`, which implies work on both sides. Half of
it is already shipped.

`RegisterConnectionDto` has carried `host` / `port` / `database` / `user` /
`password` since 0004, and `resolvePostgresPoolOptions` has a split-fields
branch that hands them to `pg.Pool` individually. The gap is entirely in
`apps/web/app/pages/connections/index.vue`, which collects one
`connectionString` box.

That changes what web should build. Desktop composes a DSN in the frontend
(`composeDsn`, with percent-encoding and IPv6 bracketing "in one place, under
test") **because its adapters parse a DSN** — there is no parts-shaped path
into sqlx. Web has one already. Sending parts as parts means no DSN is
assembled from user input at all, so the failure mode ADR-0073 exists to fix —
a password containing `@`, `/`, `#` or `?` cutting the authority at the wrong
character — cannot occur rather than being handled correctly. Adding
`composeDsn` to web would be re-introducing the bug in order to solve it.

The URL escape hatch stays: Neon, Supabase and Aurora DSQL hand out ready-made
URLs, and pasting one must keep working.

### ADR-0074 has no web counterpart as written

Desktop's rule is about kinds declared in `connections.toml` that have no
in-app form (Aurora DSQL IAM is the only one). Web has no `connections.toml`,
no keyring, and no kind whose credential cannot be typed. The rule is not
applicable and this rung does not mirror it.

Its transferable half is a real defect, though, and it is cheap. The driver
`<select>` hard-codes `postgres` and `null` in the template while
`StaticAdapterFactory` owns the actual list. The two agree today by
coincidence. Adding a driver to the factory without editing the template hides
it; offering one the factory does not have produces a 404 `CapabilityError`
banner **on submit** — precisely the "correct rule, wrong presentation" that
ADR-0074 removes. The fix is to derive the options from the factory instead of
restating them.

### ADR-0080 is blocked on the same thing desktop was blocked on

Web has no edit at all: `POST` / `GET` / `DELETE` only. So there is no divergence
in the ADR's own sense (two buttons leading to two different forms) — there is a
missing route.

The interesting part is that web is blocked for exactly the reason desktop was:

> The blocker was never the form. It was that the process holding the
> credential refused to say anything at all about it, including the parts that
> are not secret. — ADR-0080 § Context

`RegisterConnection` destructures the config, hands it to the factory and drops
it; `ConnectionRecord` keeps `{ id, label, driver, adapter }`. The credential
lives only inside the adapter instance, which 0004 chose deliberately and
pinned with a `GET /connections` leak test. Nothing can prefill an edit form
because nothing remembers the host.

Desktop's answer transfers intact, including the part that makes it safe: a
parts type **with no password field**, so "a prefill payload built from it
cannot leak one by oversight, because there is nowhere to put one". That is how
web satisfies the leak test and the edit form at the same time, rather than
trading one against the other.

### What is contract-visible

Nothing. `/connections/*` is a web-only unilateral surface (PR #7), so
`docs/api-contract.md` is not edited and no handoff is owed — the same posture
rungs 3 and 4 confirmed. The rung must leave that file with a zero diff.

## Slices

| Slice | What                                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------- |
| A     | Harden TLS in the adapter: unspecified and `prefer` both resolve to `require`; only an explicit `disable` is off. |
| B     | `sslMode` becomes an accepted registration field, so the choice can reach the adapter from either entry mode.     |
| C     | The form collects parts (host / port / user / password / database) with a URL escape hatch, in 11 locales.        |
| D     | The TLS select: two options, default Required, outside the entry-mode branch; in URL mode a view of the URL text. |
| E     | Driver options come from the factory, so an unsupported driver is never offered.                                  |
| F     | Non-secret parts are stored on the record and returned by `GET /connections`; the password is not.                |
| G     | `PATCH /connections/:id` with keep-the-stored-password semantics, and the edit form.                              |

Slice A lands before everything else because every later slice's honesty
depends on it.

## Acceptance

- [ ] An unspecified `sslmode` resolves to `require`, on both the
      `connectionString` and split-fields paths.
- [ ] An explicit `sslmode=prefer` in a pasted URL is rewritten up to `require`
      rather than honoured as plaintext, and `prefer` is no longer an
      expressible outcome of the resolver.
- [ ] An explicit `sslmode=disable` is honoured on every host, including
      `*.neon.tech` and `*.supabase.co` — a knowing opt-out is not overridden.
- [ ] `POST /connections` accepts `sslMode` with exactly the two values the
      form can express, and rejects anything else at the DTO.
- [ ] The form submits `host` / `port` / `user` / `password` / `database` as
      separate fields, with 5432 filled in for a blank port, and no DSN
      composed in the browser.
- [ ] A pasted provider URL still registers, through the escape hatch.
- [ ] The TLS select is visible in both entry modes, defaults to Required, and
      in URL mode reports what the typed URL actually says.
- [ ] The driver options are the drivers the factory supports; adding one to
      the factory adds it to the form with no template edit.
- [ ] `GET /connections` returns the non-secret parts and no password, pinned
      by an extended leak test.
- [ ] `PATCH /connections/:id` with a blank password keeps the stored one; the
      edit form opens with the same inputs the add form renders.
- [ ] `docs/api-contract.md` has a zero diff across the whole rung.
- [ ] 11-locale parity holds for every key added.

## Notes

**The integration suite will need `?sslmode=disable`, and that is the feature
working.** `apps/api/test/postgres-integration.spec.ts` connects to a
`postgres:16-alpine` testcontainer, which has no TLS configured. After slice A
it must opt out explicitly. This is desktop's tunnelled-MySQL case exactly —
"the database on the far side is very often a `127.0.0.1` MySQL with TLS never
configured" — and the explicit opt-out is the intended answer, not a workaround
for it.

**Three documents carry plaintext localhost DSNs** and need the same opt-out
once slice A lands: `.env.example`, `apps/api/README.md`, and the curl example
in `0004-postgres-adapter.md`. Leaving them would hand a new contributor a
config that fails on first run.

**Two existing tests pin the behaviour slice A reverses** —
`defaults sslmode to 'prefer' when not specified` and `auto-upgrades to
'require' for *.neon.tech even if caller passed sslmode=disable`. They are
rewritten, not deleted (baseline §7): the first inverts, the second becomes its
own opposite and gains a note saying why a knowing opt-out outranks a
host-suffix guess.

**The field is `sslMode`, not `sslmode`.** camelCase, matching
`connectionString` and the rest of the envelope. libpq's own spelling keeps
working where libpq's conventions apply — inside a pasted connection
string — so both appear, each in its own place. The two are also validated
differently on purpose: the field rejects `prefer` while the URL merely
hardens it, because a field is a claim about which option the select was
on and the select has no such option.

**The two-mode vocabulary lives in `domain`, not beside the Postgres
adapter.** `AdapterConfig` is a usecase-layer type and must not import
infrastructure (§9), and the rule is not Postgres-specific — desktop
applies the same one to MySQL. `domain/ssl-mode.ts` holds the values, the
type derived from them, and `hardenSslMode`.

**`defaultPortFor` lives in `app/utils`, not in `useConnections`.** It is not
HTTP I/O — it decides nothing about the request, only what the form shows
before one is made. And `useConnections` reaches for `#imports` at module
scope, so the page test mocks the whole module; anything exported beside it
can only be exercised through that mock, which would have made the 5432
default a property of the test double rather than of the app.

**Slice C settled a standing Prettier/ESLint conflict.** Prettier rewrites
`<input>` to `<input />` in Vue templates and `vue/html-self-closing`
defaults to warning about exactly that, so the warning could not be acted
on — satisfying it fails `pnpm format:check`. Three such warnings predated
this rung and the parts fieldset would have added six more. `void: "any"`
in `apps/web/eslint.config.mjs` gives Prettier the void-element spelling
and leaves `normal` and `component` enforced. `pnpm -r lint` is now at zero
warnings, which is what makes the next warning worth reading.

**The host-suffix list becomes dead.** `SSL_REQUIRED_HOST_SUFFIXES` exists to
force TLS on Neon and Supabase. Once the default is `require`, it can only ever
do one thing the default does not: override an explicit `disable`. Slice A
stops doing that on purpose, which leaves the list with no behaviour, so it
goes.

**The driver list is a route, not a shared constant.** Slice E could have
exported the list from a package both sides import, which is how the two
copies of `hardenSslMode` are kept honest. That works for a rule; it does not
work here, because the question is not "what does the vocabulary say" but
"what can _this running server_ build". A constant compiled into the browser
bundle answers the first and only looks like it answers the second — it would
go stale the moment an API deploy adds a driver, which is precisely the drift
the slice removes. So the browser asks.

**It is `GET /connections/drivers`, not a field on `GET /capabilities`.**
`/capabilities` is mirrored from desktop (`docs/api-contract.md`) and answers
what the _current_ adapter can do; the drivers list is what adapters exist,
which is a different question and one desktop does not ask over HTTP at all.
Nesting it under the already-unilateral `/connections/*` prefix (PR #7) is what
keeps the contract at a zero diff. The handler is declared above `@Delete(":id")`
so a literal segment is never read as an id — nothing routes `GET /connections/:id`
today, but slice G adds a sibling that would.

**`StaticAdapterFactory` dispatches through a `Map`.** The switch became a
lookup table so `supported()` and `create` read the same source — two lists
that must agree is the bug being fixed, and rebuilding it one layer down
would be no better. A `Map` rather than an object literal because `driver`
arrives from the request body: on a plain object, `create("constructor", …)`
finds a function on the prototype and calls it. Pinned by a test.

**`Driver` is now `string`.** The union `"postgres" | "null"` was a
closed-world claim the browser is not in a position to make — the API can
gain a driver without the web being rebuilt, and the compiler would then
reject a value the server had just called valid. The two places that reason
about a specific driver (`defaultPortFor`, the credential-fields branch) keep
working on names and fall through to a safe answer for one they do not
recognise.

**An unloadable driver list disables the form rather than guessing.** If the
fetch fails the select is empty, the submit button is disabled, and the
banner says why. Falling back to `["postgres"]` would put an option in front
of the user that this build may not support — the same defect in a smaller
font.

**The password is unrepresentable rather than filtered.** Slice F's parts type
has no `password` member and no `connectionString` member, and the function
that builds it takes a parameter type that names neither. So the split-fields
branch cannot read a credential even if handed one — there is nothing to read
it into. Only the URL branch has to discard anything, and it discards
everything it is not explicitly asked for: host, port, database, user and
`sslmode`, with the password and every other query parameter left behind. A
filter over a wider shape would have been the alternative, and it fails the
first time someone adds a field to the record and forgets the filter.

**Parts are `undefined`, not `{}`, when there are none.** They are different
facts. A `null`-driver connection has no address, and an empty object is a
claim that there is a connection to describe with nothing in it. `GET
/connections` therefore omits the key rather than sending `{}` or `null`, which
also spares the browser a third case to branch on.

**Parts mirror `resolvePostgresPoolOptions`' precedence exactly, and have to.**
A `connectionString` supplants the split fields wholesale (libpq's rule, which
the resolver already follows); an explicit `sslMode` outranks the URL's,
because it is a claim about which option the select was on. Parts that resolved
the same conflict differently would describe a connection nobody made — the
prefilled edit form would then disagree with the live adapter.

**`sslmode=prefer` in a pasted URL comes back as `require`.** The parts report
the mode the connection will actually use, not the one that was typed. Slice A
removed `prefer` as a possible outcome, so echoing it back would prefill a
select with a mode the adapter does not implement — the same class of lie as
the pre-slice-A default, one layer up.

**A mode is reported only when one was stated.** Neither the field nor a URL
parameter means no `sslMode` in the parts, even though the adapter will harden
to `require`. Storing `require` unconditionally would attach a TLS claim to the
`null` driver, which negotiates nothing.

**The HTTP-level guard asserts both halves on one fixture.** "No password" and
"the parts come back" are one property. Checked in separate tests, a response
that satisfies neither still passes whichever half was written first — so the
existing sentinel test in `test/http-contract.spec.ts` gained the parts
assertions rather than getting a sibling.

**The web's `ConnectionParts` is a type declaration with no test.** It mirrors
the API's shape so `ConnectionView` describes what the server actually sends;
nothing observable changes until slice G reads it. Recorded here rather than
covered by a test that would only be asserting a mock's own shape.

## Log

_(open)_
