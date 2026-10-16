# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
This file was the hand-maintained record of what existed before the first
published release. The first release shipped 2026-10-16; manual entries here
are no longer permitted.

After the first release this file stops being the source of truth. Changesets
writes a CHANGELOG.md per package, under packages/<name>/, and never touches
this one — verified, not assumed. So from the first release onward:

  - packages/<name>/CHANGELOG.md  generated; do not hand-edit
  - this file                      an index, linking the per-package changelogs

To record a change that needs a release, add a changeset:

    pnpm changeset
    # choose the packages affected, the bump type, and write one sentence
    # describing the change from a user's point of view

Then commit the generated `.changeset/*.md` file. `pnpm changeset` runs the
pinned devDependency. Do not write `npx changeset`: the unscoped `changeset`
package on npm is an unrelated LevelDB JSON-diff library last released in 2021,
so `npx` would fetch that instead of the release tool.

See docs/releasing.md for the full procedure.
-->

## First published release — 2026-10-16

Per-package changelogs are the source of truth. This file is the index:

- [@ax-kit/core](packages/core/CHANGELOG.md) — 0.1.0
- [@ax-kit/cli](packages/cli/CHANGELOG.md) — 0.1.0
- [@ax-kit/daemon](packages/daemon/CHANGELOG.md) — 0.1.0
- [@ax-kit/extension](packages/extension/CHANGELOG.md) — 0.1.0
- [@ax-kit/react](packages/react/CHANGELOG.md) — 0.1.0
- [@ax-kit/vue](packages/vue/CHANGELOG.md) — 0.1.0
- [@ax-kit/svelte](packages/svelte/CHANGELOG.md) — 0.1.0
- [@ax-kit/zod](packages/zod/CHANGELOG.md) — 0.1.0
- [@ax-kit/playwright](packages/playwright/CHANGELOG.md) — 0.0.1

The cohort implements WebMCP Draft Community Group Report, 15 October 2026 (`SPEC_VERSION` in `@ax-kit/core`).
