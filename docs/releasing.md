# Releasing

How a version gets made and published. Read this before your first release; it
is written for someone who did not write the code.

- [What gets released](#what-gets-released)
- [Recording a change](#recording-a-change)
- [Making a release](#making-a-release)
- [Publishing without a long-lived secret](#publishing-without-a-long-lived-secret)
- [Checks that must fail the build](#checks-that-must-fail-the-build)
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
pnpm run release -- --dry-run     # version, then print what would be published
```

The dry run stops one step short of publishing. Use it, not `pnpm release`, to
find out what would happen.

### Packing without publishing

To produce the exact tarballs a release would ship and inspect them:

```sh
pnpm exec changeset pack --out-dir <dir>
```

**The tarballs land in `<dir>/packages/`, not `<dir>/`.** This surprised the
first rehearsal, so it is written down. The same command also writes
`<dir>/publish-plan.json`.

Inspect the tarballs rather than the working tree: a file present in the
checkout but missing from `files` never ships, and that is invisible until you
unpack. At minimum, for each tarball, confirm the exact file list, that every
path in `main`, `module`, `types`, `exports` and `bin` exists inside it, that
both `dist/index.d.mts` and `dist/index.d.cts` ship next to `dist/index.mjs` and
`dist/index.cjs`, and that any declared binary starts with a shebang.

### One caveat about the size gate locally

`pnpm size` can report a **stale success** after the budget in a package's
`package.json` changes, because the task runner serves a cached result whose log
still shows the previous limit. It looks exactly like the gate passing:

    @ax-kit/core:size: cache hit, replaying logs a5ec589af63f0ed2
    @ax-kit/core:size:   Size limit: 5 kB        <- the old limit, replayed
    exit 0

The gate itself is sound — run the package's task directly, or bypass the cache,
and it refuses:

    pnpm --filter @ax-kit/core run size
      Package size limit has exceeded by 3.82 kB
      Exit status 1

    pnpm size --force
      Tasks: 9 successful, 14 total
      Failed: @ax-kit/core#size

Continuous integration is not affected: the cache directory is gitignored, so a
fresh checkout has no cache and the task always runs. This matters locally when
you *tighten* the budget, because that is exactly when you want to see it fail.
Use `--force` after changing a limit.

`changeset version` rewrites the package manifests, the lockfile, and adds a
`CHANGELOG.md` under each released package. **Review that diff before
committing it** — it is the actual release, and the changelog entries come from
whatever the changesets said.

Publishing needs registry credentials and is **not reversible**. Do not run
`pnpm release` to "see what happens"; run `pnpm changeset publish-plan` instead.

The two halves are also available separately, and the release workflow uses the
second one:

| Command | Does |
|---|---|
| `pnpm release` | version, then publish. The one-shot for a human. |
| `pnpm release:version` | `changeset version` alone |
| `pnpm release:publish` | `changeset publish` alone |

## Publishing without a long-lived secret

`.github/workflows/release.yml` publishes by presenting an identity token that
the registry checks against a **trusted publisher** configured per package. No
token is stored in this repository, and none is written to the runner.

The workflow asks for one elevated permission, `id-token: write`, plus
`contents: read`. That is the whole grant: it identifies the run and produces
provenance, and it cannot write to this repository.

Three things about it are load-bearing and are easy to get wrong:

- **The workflow filename is part of the binding.** The trusted publisher names
  this repository *and* `release.yml`. Renaming the file breaks publishing with
  an error that does not mention file names. Change the trusted publisher in the
  same commit.
- **Staged publishing is the usual first-run surprise.** A newly created trusted
  publisher may default to a mode that authenticates successfully and publishes
  nothing. The run reports success, because it genuinely did succeed at
  authenticating. Check the mode is set to publish, not stage.
- **Only a merged commit can publish.** The workflow triggers on a push to `main`
  and on manual dispatch. A feature-branch push does not match the trigger, and
  the registry holds no trusted publisher for an unmerged branch.

### Registry setup, once, by a human

This cannot be done from the repository; it needs an account with access to the
`@ax-kit` scope. For **each** of the nine packages — `@ax-kit/cli`, `core`,
`daemon`, `extension`, `playwright`, `react`, `svelte`, `vue`, `zod`:

1. Create a trusted publisher on the package, configured for **GitHub Actions**.
2. Set the organization to `open-ax` and the repository to `ax-kit`.
3. Set the workflow filename to `release.yml`.
4. **Set the publishing mode to publish, not stage.**
5. Confirm the package's `repository.url` matches the repository exactly. It is
   `https://github.com/open-ax/ax-kit.git`, and
   `node .github/ci/check-manifests.mjs` fails the build if it drifts.

`@ax-kit/tsconfig` gets none of this: it is private and is never published.

Provenance is produced by the publishing run from the same identity token and is
verifiable from the published artifact. Nothing in this repository asserts it.

## Checks that must fail the build

A gate that reports a problem and blocks nothing is worse than no gate, because
it reads as coverage. Two checks were audited for this:

- **`publint` runs with `--strict`.** Without it, `publint` prints warnings and
  exits 0. A malformed `repository.url` — the field publishing authentication
  binds to — was reported and the build stayed green. `--strict` promotes every
  warning to an error, and all nine packages pass it.
- **`attw` runs with `--profile node16` deliberately.** attw's own default is
  `strict`, which also analyses legacy `node10` resolution. These packages use
  subpath `exports`, and `node10` cannot resolve subpaths at all, so under
  `strict` every subpath entry reports `NoResolution`. The `node10` rows shown
  under `node16` are marked *ignored* because the packages do not claim that
  resolution mode, not because a real finding was suppressed. `node16` does
  block: a broken `exports` types path fails it.

## What the tool will not do for you

- **It does not check that the release is safe to make.** The release workflow
  does this for you: it runs typecheck, lint, test, the size gate, both packaging
  checks and the manifest check before it publishes. When publishing by hand,
  run the same set first.
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
