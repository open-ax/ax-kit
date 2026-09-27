# 1. Runtime and toolchain baseline

Date: 2026-09-27
Status: Accepted

## Context

A toolchain baseline was needed before the first manifest lands, so the
supported range and the contributor default are recorded here rather than
discovered by accident later.

Versions below were verified against nodejs.org/dist and the npm registry on
2026-09-27.

### Verified against nodejs.org/dist on 2026-09-27

| Fact | Value |
|---|---|
| Active LTS line | **24.x, codename "Krypton"** |
| Newest 24.x | **24.21.0** (2026-09-07) |
| 24.20.0 | 2026-08-26 — real, one patch behind newest |
| 24.19.0 | 2026-08-03 — real, two patches behind newest |
| Maintenance LTS | 22.x "Jod" |
| Current (non-LTS) | 26.x |

### Verified against the npm registry on 2026-09-27

| Fact | Value |
|---|---|
| `pnpm` `dist-tags.latest` | **12.6.0** |
| Newest 12.x | 12.7.0 |
| Newest 10.x | 10.34.5 |

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
questions and conflating them produces friction.

| Concern | Value | Where |
|---|---|---|
| Supported Node range | `>=24.19.0 <25` | `package.json` `engines.node` |
| Node we develop and test on | `24.21.0` | `.nvmrc` |
| pnpm | **not pinned yet** | decided when the toolchain lands |

### Why `>=24.19.0` and not `>=24.20.0`

The narrower floor would exclude a working install for a one-patch difference,
with no compatibility justification found. A floor that excludes a working
contributor install is friction that buys nothing.

### Why `.nvmrc` is 24.21.0

`.nvmrc` is the version CI uses and the version a new contributor should get.
Declaring an older patch would bake a stale patch into every future checkout.
Declaring 24.21.0 is correct, and `engines` is deliberately loose enough that a
one-patch lag locally is not a blocker.

### Why pnpm is not pinned yet

There is no `package.json`. A pin has nowhere to live. Pinning now would break
the first install for a decision that has no consumer yet.

When the root manifest lands, pin the version and verify the three unverified
claims above first. Note: `pnpm/action-setup@v4` reads `packageManager` (or an
explicit `version` input), not `devEngines.packageManager`; align the manifest
field with what the workflow actually reads.

## Consequences

- When `.npmrc` lands with the root manifest: `engine-strict=true`, so a
  genuinely unsupported Node fails at install rather than at runtime, plus
  `strict-peer-dependencies=true` and `save-exact=true` for reproducibility.
- Three toolchain claims are unverified and must be checked before the
  toolchain is configured. They are recorded here so they are not mistaken
  for settled.

## Revisit when

- The first `package.json` lands — pin pnpm, and settle the three unverified
  claims.
- Node 25 reaches Active LTS.
- Any package needs a Node feature absent from 24.

## Deferred, not forgotten

One repository-level file was deliberately **excluded** from the first
commit, because at this point it configures a tool that is not installed yet
and therefore does nothing:

- **`.npmrc`** — `engine-strict=true`, `strict-peer-dependencies=true`,
  `save-exact=true`. All three are wanted and all three are inert without a
  `package.json`. They ship with the commit that creates the root manifest.
- **`.nvmrc`** — kept, because CI reads it via `node-version-file` as soon as
  the toolchain job activates, and it is a single line with no settings to
  misread.
