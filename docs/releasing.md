# Releasing

How a version gets made and published. Read this before your first release; it
is written for someone who did not write the code.

- [What gets released](#what-gets-released)
- [Recording a change](#recording-a-change)
- [Making a release](#making-a-release)
- [What the tool will not do for you](#what-the-tool-will-not-do-for-you)
- [After the first release](#after-the-first-release)

## What gets released

Nine packages, versioned **independently**. `@ax-kit/tsconfig` is private and is
never published. There is no fixed or linked versioning, so a change to one
adapter does not bump the other eight.

| Package | Notes |
|---|---|
| `@ax-kit/core` | the polyfill; zero runtime dependencies; carries the size gate |
| `@ax-kit/cli` | ships the `ax-kit` binary |
| `@ax-kit/daemon` | ships the `ax-kit-daemon` binary |
| `@ax-kit/extension` | trusted-tier bridge |
| `@ax-kit/playwright` | peer-depends on `@playwright/test` |
| `@ax-kit/react` | peer-depends on `react` |
| `@ax-kit/svelte` | peer-depends on `svelte` |
| `@ax-kit/vue` | peer-depends on `vue` |
| `@ax-kit/zod` | the only package with a runtime dependency |

`@ax-kit/core` is a **devDependency** of the four adapters and is bundled into
their output — a built adapter contains no runtime import of it. That is why
releasing the core does not bump the adapters: there is no runtime edge to widen.
If that ever changes, the bump behaviour changes with it.

## Recording a change

Anything user-visible needs a changeset, committed alongside the code change:

```sh
pnpm changeset
```

Pick the affected packages, the bump type, and write one sentence from a user's
point of view. That sentence is what ends up in the changelog, so write it for
the person reading the release notes, not for the person reading the diff.

Use `pnpm changeset --empty` for a change that needs no release — a refactor, a
test, a CI fix. An empty changeset records the decision; omitting one leaves the
release tool reporting that packages changed without a changeset.

Do not run `npx changeset`. The unscoped `changeset` package on npm is an
unrelated LevelDB JSON-diff library, last released in 2021; `npx` would install
it and you would get a tool with no release functionality. The release tool is
`@changesets/cli`, pinned in the root `devDependencies`.

## Making a release

```sh
pnpm install --frozen-lockfile   # the lockfile must match, or CI is already red
pnpm release                     # versions, changelogs, then publishes
```

`pnpm release` runs `changeset version` and then `changeset publish`. With no
pending changesets it prints a message and **exits 0** — the underlying
`changeset version` exits 1 in that case, which is right for the tool and wrong
for a pipeline, because a red check nobody can explain gets ignored.

To see what a release would do without doing any of it:

```sh
pnpm changeset publish-plan     # which packages would be published, and at what version
```

`changeset version` rewrites the package manifests, the lockfile, and adds a
`CHANGELOG.md` under each released package. **Review that diff before
committing it** — it is the actual release, and the changelog entries come from
whatever the changesets said.

Publishing needs registry credentials and is **not reversible**. Do not run
`pnpm release` to "see what happens"; run `pnpm changeset publish-plan` instead.

## What the tool will not do for you

- **It does not check that the release is safe to make.** Run the full suite
  first: `pnpm typecheck lint test build size publint attw`. In particular
  `pnpm size` — the core size gate is a hard failure and must never be raised to
  make a build pass.
- **It does not pick the bump type.** A wrong bump type is a wrong public
  version number, and it cannot be withdrawn.
- **It does not publish `@ax-kit/tsconfig`.** Check `publish-plan` if in doubt.
- **It does not fail when there is nothing to do**, by design here. "No packages
  were published" is a legitimate outcome, not a silent failure.

## After the first release

`changeset version` writes `CHANGELOG.md` under each released package and does
not touch the root `CHANGELOG.md`. From the first release onward the per-package
files are the source of truth and the root file is an index linking to them.

Decisions that shaped this setup, and why, are in
[`.changeset/README.md`](../.changeset/README.md).
