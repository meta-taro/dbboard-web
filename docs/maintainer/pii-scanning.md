# PII / secret leak scanning (operator guide)

dbboard-web is developed against real, business-identifying databases but
shipped as a public repository. This is the **preventive** guard that keeps real
customer/store names, credentials, and maintainer PII out of the public repo —
on every commit, on every commit message, and once a day in CI.

The scanner is ported from the desktop client, where it was introduced as
ADR-0055 and extended to commit identity as ADR-0084. Both repositories are
public under the same account and share the same exposure: fixtures full of
connection strings, and commit metadata nobody was checking. See the
`2026-08-03` entry in [`.claude/decisions.md`](../../.claude/decisions.md) for
why it was brought over.

## What runs where

| Trigger                                             | Command                                                                          | Blocks?                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| pre-commit hook                                     | `pii-scan.sh --staged --reveal`                                                  | yes — staged content **and `git config user.email`**      |
| commit-msg hook                                     | `pii-scan.sh --message <file> --reveal`                                          | yes — the message text                                    |
| CI push/PR/daily (`.github/workflows/pii-scan.yml`) | `--selftest`, `--tree`, `--range origin/main..HEAD`, `--identity <pushed range>` | yes — tracked files, commit messages, new commit identity |

The hooks live in `.husky/` and are installed by the `prepare` script on
`pnpm install`. `--reveal` is passed locally (private terminal) but **never** in
CI — a public Actions log must not echo the very strings the scanner hides.

The pre-commit hook runs **after** `lint-staged`, so the scan sees exactly the
bytes that will be committed (lint-staged reformats and re-stages files).

## Two severities

The scanner splits rules by how much a database client's own test suite trips
them — it is full of synthetic connection strings and example emails.

- **BLOCKING** (fails the commit / CI):
  - **denylist literals** — the real names/PII from `.pii-denylist` (below).
    This is the primary mechanism; matched exactly and **redacted** in output.
  - **private-key** — PEM `BEGIN … PRIVATE KEY` blocks.
  - **aws-access-key-id** — a real-looking `AKIA…` key id.
  - **identity** — an author/committer address that is not a GitHub noreply
    address. Blocking rather than advisory because, unlike a string in a file,
    it cannot be corrected by a later commit (see below).
- **ADVISORY** (printed in the `--tree` / `--range` scan, never fails):
  - **passworded-db-url**, **personal-email**, **windows-home-path**.

  By project invariant real credentials reach the API through environment
  variables and are never written to a tracked file, so a passworded URL in the
  tree is a fixture — worth a glance, not a build break. A genuinely new
  personal email still surfaces here. To make a specific known value blocking,
  add it to the denylist.

## The denylist (the real strings)

Real customer/store names, the maintainer's personal email / full name / OS
username, and any production hostnames go in a **denylist that is never
committed**:

- **Locally:** copy [`.pii-denylist.example`](../../.pii-denylist.example) to
  `.pii-denylist` at the repo root (gitignored) and fill it in, one literal per
  line. Fixed strings, case-insensitive.
- **In CI:** put the same lines in the `PII_DENYLIST` repo secret (Settings →
  Secrets and variables → Actions). The workflow materializes it into
  `.pii-denylist` for the run and shreds it afterwards.

Creating both is a **maintainer action** — per baseline §15 no AI agent touches
secrets. Until they exist the scan degrades to generic rules only: it does not
fail, it just loses literal-name detection.

Keep the two in sync.

## False positives — the allowlist

`scripts/pii-scan.allow` holds narrow EREs for known-safe shapes (placeholder
emails, example connection strings, `C:\Users\<placeholder>` docs paths). The
web-specific entries at the bottom cover the two DSN shapes this repo's fixtures
use — the testcontainers template `postgresql://test:test@${host}:${port}/test`
and the single-letter controller placeholder `postgres://x:y@h/d`.

When an advisory shape rule hits a genuine fixture, add a **narrow** regex
there. Section markers in that file are load-bearing: only entries under
`# === BLOCKING` apply to the blocking tier, so a broad advisory entry can never
silence a real key. Never add a real name or credential to the allowlist — the
denylist takes precedence and cannot be allowlisted anyway.

## Running it by hand

```sh
sh scripts/pii-scan.sh --selftest                        # prove the rules fire
sh scripts/pii-scan.sh --tree                            # tracked files at HEAD
sh scripts/pii-scan.sh --tree --reveal                   # ... showing matches
sh scripts/pii-scan.sh --range origin/main..HEAD         # commit messages
sh scripts/pii-scan.sh --identity origin/develop..HEAD   # author / committer
sh scripts/pii-scan.sh --message .git/COMMIT_EDITMSG
```

Exit status: `0` clean, `1` a blocking leak, `2` usage error.

## When a commit is blocked

1. Read the finding. A denylist hit prints the rule id, the location, and
   `(match redacted)` — the `<sha8>` in `[denylist#<sha8>]` identifies which
   denylist entry matched without printing the entry itself. Generic blocking
   hits (`private-key`, `aws-access-key-id`) print the rule and location; run
   with `--reveal` locally to see the text.
2. If it is a **real leak**: remove it. Real names belong only in your private
   notes and the untracked `.pii-denylist` — never in a tracked file, a commit
   message, or a PR body.
3. If it is a **false positive**: add a narrow regex to `scripts/pii-scan.allow`.
4. There is **no sanctioned `--no-verify` bypass** in this repository. Baseline
   §20 is explicit that a deadline is a reason to shrink scope, not to skip a
   gate.

## Commit identity

On a public repository the author and committer address of every commit is
visible to anyone. Unlike a leaked string in a file, it **cannot be fixed by a
later commit** — the address is part of the commit object, so changing it
rewrites that hash and every descendant. `git grep` reads trees, so it
structurally cannot see this class of leak at all.

Set it once, per clone:

```sh
# NOT --global. The exact address is on GitHub → Settings → Emails.
git config user.email "<id>+<login>@users.noreply.github.com"
git config user.email          # confirm
```

Turning on **Settings → Emails → Keep my email addresses private** on GitHub
makes the same noreply address apply to commits made through the web UI.

**That second step is not optional, and `git config` alone does not cover it.**
Merging a PR from the GitHub web UI creates a commit this clone never authored —
the "Squash and merge" button stamps it with the account's primary address, not
with `git config user.email`. A repo whose local commits are all clean therefore
still publishes a personal address on every merge. The desktop repo hit exactly
this on 2026-07-31: the branch commits of its PR #127 were noreply, the squash
commit they produced on `develop` was not, and CI went red on a range that clone
did not write.

The pre-commit hook refuses to commit when `user.email` is not a noreply
address, and CI re-checks the commits each push or PR introduced. Neither
touches existing history — see below.

## History rewrite

CI scans HEAD, commit **messages** across the whole history (all ~130 are
verified clean), and the **identity** of only the commits each push or PR
introduces. It deliberately does not scan the identity of existing history.

**The 129 commits between the root commit and `develop` as of 2026-08-03 all
carry the maintainer's personal address in the author and committer fields.**
The repo-local `user.email` was switched to the GitHub noreply address the same
day, so nothing new joins that set — but the published ones stay until someone
rewrites them. Scanning them on every run would be permanently red and would
bury the live signal.

Fixing them is a **maintainer decision, not an AI one** (baseline §6: push is
the human's; §32: a public-repo history rewrite needs approval), and it is the
same decision as the desktop repo's own pending rewrite of 428 commits. The
shape of the work:

```sh
# 1. Take a backup clone first. This is destructive.
# 2. Rewrite author/committer on the affected range, e.g. with git-filter-repo:
git filter-repo --mailmap ../mailmap.txt
# 3. Verify no personal address survives:
sh scripts/pii-scan.sh --identity <root>..HEAD
# 4. Force-push, then every other clone must re-clone (rebasing onto the
#    rewritten history reintroduces the old commits).
```

Caveats that make this a one-shot decision rather than routine hygiene: forks,
GitHub's cached dangling commits, and anyone who already cloned keep the old
objects. Coordinate the two repositories so it is done once, together.
