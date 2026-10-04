# Release configuration

One command produces the version bumps and the changelog together, so the two
cannot disagree. See `docs/releasing.md` for the procedure.

**`@changesets/cli` is the tool.** The unscoped `changeset` package on npm is an
unrelated LevelDB JSON-diff library, last released in 2021, and installs with no
release functionality at all.

## Decisions recorded here

- **`fixed: []` and `linked: []`.** Nine packages, three of which are adapters
  over one core. Fixed versioning republishes all nine whenever any one changes,
  which at a pre-1.0 line spends version numbers on releases that did not change
  most consumers' code. Versions move independently.
- **`access: "public"`.** The tool's own default is `restricted`, which makes a
  first publish fail with an unpublishable-package error. Every package here is
  public.
- **`ignore: ["@ax-kit/tsconfig"]`.** Names the never-published package in one
  place instead of leaving it to be inferred from a `private` flag. Measured:
  removing this line does **not** put `@ax-kit/tsconfig` in
  `changeset publish-plan`, because `privatePackages.version` below already
  excludes it. It is here for visibility, not for effect — so do not describe it
  as the thing keeping the package out of the release set.
- **`privatePackages: { version: false, tag: false }`.** These are the tool's
  own defaults. Stated so the guarantee does not depend on knowing them, and so
  a second private package added later is excluded without anyone re-reading
  this file. This is what actually keeps a private package out of the release
  set.
- **`updateInternalDependencies: "patch"`.** `@ax-kit/core` is a **devDependency**
  of the adapters and is bundled into their output — the built adapters contain
  no runtime import of it. Bumping the adapters' devDependency range is what
  forces a rebuild against the new core; leaving it alone would let a published
  adapter keep shipping the old core.
