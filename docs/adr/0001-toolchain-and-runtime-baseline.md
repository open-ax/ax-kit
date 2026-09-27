# 1. Runtime and toolchain baseline

Date: 2026-09-27
Status: Accepted

## Context

A toolchain baseline was recorded for this project. The machine did not match
it, so the first question was whether to upgrade the machine or relax the pin.

This ADR records what was actually verified, because the recorded pins and the
live registries disagreed in a way that was worth writing down.

### Verified against nodejs.org/dist on 2026-09-27

| Fact | Value |
|---|---|
| Active LTS line | **24.x, codename "Krypton"** |
| Newest 24.x | **24.21.0** (2026-09-07) |
| 24.20.0 | 2026-08-26 — the previously recorded pin. Real, but one patch behind. |
| 24.19.0 | 2026-08-03 — what this machine had. Not a security release. |
| Maintenance LTS | 22.x "Jod" |
| Current (non-LTS) | 26.x |

The recorded claim that 24.20.0 is the Active LTS line is **correct in kind and
stale in patch**. The line is right; the exact patch is two behind.

### Verified against the npm registry on 2026-09-27

| Fact | Value |
|---|---|
| `pnpm` `dist-tags.latest` | **12.6.0** |
| Newest 12.x | 12.7.0 |
| Newest 10.x | 10.34.5 |
| This machine | 10.15.0 |

The recorded pnpm pin of 12.6.0 is accurate — it is the current `latest`.

### Could not be verified

Three claims are **not** checked, because they have no consumer yet and no code
to check them against:

1. That pnpm 12 is a Rust rewrite.
2. That Turborepo 2.11 deprecates `packageManager` in favour of
   `devEngines.packageManager`.
3. That pnpm 12 replaced `onlyBuiltDependencies` with `allowBuilds`.

All three are checkable at the moment the toolchain lands, and all three should
be checked then rather than configured now on the strength of an unsourced note.

## Decision

**Separate what we develop on from what we support.** These are different
questions and conflating them is what produced the mismatch.

| Concern | Value | Where |
|---|---|---|
| Supported Node range | `>=24.19.0 <25` | `package.json` `engines.node` |
| Node we develop and test on | `24.21.0` | `.nvmrc` |
| Node on this machine | 24.19.0 | below the floor only in patch, not in minor |
| pnpm | **not pinned yet** | decided when the toolchain lands |

### Why `>=24.19.0` and not `>=24.20.0`

The previous floor excluded the version actually installed, for a one-patch
difference, with no security or compatibility justification. A floor that
excludes a working developer install is friction that buys nothing.

24.18.1 and 24.21.0 are security releases; 24.19.0 is not itself one, but it is
not known to be vulnerable either. There is no reason to refuse it.

### Why `.nvmrc` is 24.21.0 while the machine runs 24.19.0

`.nvmrc` is the version CI uses and the version a new contributor should get.
Declaring 24.19.0 would bake a stale patch into every future checkout. Declaring
24.21.0 is correct, and `engines` is deliberately loose enough that the local
lag is not a blocker. Bringing the machine forward is a one-command change and
is recommended, not required.

### Why pnpm is not pinned yet

There is no `package.json`. A pin has nowhere to live. Declaring 12.6.0 the
moment a manifest appears would immediately conflict with the installed 10.15.0
and break the first install — friction created for a decision that has no
consumer yet.

When the root manifest lands, pin through corepack in `devEngines.packageManager`
and verify the three unverified claims above first.

## Consequences

- `engine-strict=true` in `.npmrc`, so a genuinely unsupported Node fails at
  install rather than at runtime. The range is satisfied by what is installed,
  so this is free today.
- `save-exact=true`, because a published library that installs a different
  transitive version tomorrow than it tested today is a reproducibility problem.
- The machine should move to 24.21.0. Nothing blocks it until it does.
- Three toolchain claims are unverified and must be checked before the
  toolchain is configured. They are recorded here so they are not mistaken
  for settled.

## Revisit when

- The first `package.json` lands — pin pnpm, and settle the three unverified
  claims.
- Node 25 reaches Active LTS.
- Any package needs a Node feature absent from 24.

## Deferred, not forgotten

Two repository-level files were deliberately **excluded** from the first
commit, because at this point both configure a tool that is not installed yet
and therefore do nothing:

- **\.npmrc\** — \ngine-strict=true\, \strict-peer-dependencies=true\,
  \save-exact=true\. All three are wanted and all three are inert without a
  \package.json\. They ship with the commit that creates the root manifest.
- **\.nvmrc\** — kept, because CI reads it via \
ode-version-file\ as soon as
  the toolchain job activates, and it is a single line with no settings to
  misread.
