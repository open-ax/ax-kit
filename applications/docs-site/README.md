# ax-kit documentation site

Static documentation that **runs the polyfill in the reader's browser**. For a
library that modifies a global in someone else's page, the only meaningful
question — *does this work, in my browser, on my page* — is answered by running
it, and installation is exactly the step that deters evaluation.

```sh
pnpm --filter @ax-kit/docs-site dev            # http://localhost:4322
pnpm --filter @ax-kit/docs-site build          # generate, build, gate
pnpm --filter @ax-kit/docs-site test           # vocabulary, sources
pnpm --filter @ax-kit/docs-site test:browser   # the built output, real browser
```

`build` runs four things in order, and the last two can fail it:

| Step | Fails on |
|---|---|
| `generate-llms.mjs` | — |
| `astro build` | A page that will not compile |
| `verify-reference.mjs` | A public signature changed without the reference changing |
| `verify-links.mjs` | A broken internal link, a malformed `security.txt`, a `llms.json` entry the build did not produce |

## Three things this site does that a template does not

**The reference is generated and gated.** `scripts/public-interface.mjs` reads the
published `.d.mts` declarations and produces a committed report under
`src/data/api-report.json`. A change to a public signature fails the build. The
gate has been observed failing — a probe type exported from `@ax-kit/core` turned
it red with the offending name printed, and was reverted.

**475 internal links are checked against the built output.** Not the sources.
`scripts/verify-links.mjs` reads `dist/` and resolves every `href`/`src` against
what will actually be served. That check found 65 broken links in a build that was
reporting success.

**Every page names the draft it describes**, in the footer, because the proposal
is re-dated and a reader comparing this site with the specification needs to know
whether they are reading the same document.

## What the gate does not check

Prose. A page whose claim has gone stale is a documentation defect, and no
signature comparison catches it. What the gate catches is the case that is not a
defect at all: a reference describing a signature that no longer exists.

## Three findings worth knowing

Recorded because each cost real time and each would be invisible in the source.

**A build can succeed and ship nothing.** The documentation framework filters
entries to those explicitly marked `draft: false` in production. A page without
it is omitted silently — 11 pages became 1, and the build said `Complete!`. Found
by counting the generated HTML rather than by reading the log.

**An island's JavaScript is not in a `<script src>`.** It is fetched at runtime by
the `astro-island` custom element, so a page with a working island and a page with
no island carry the *same* script tags. "Pages with no interactive example load no
framework runtime" is asserted by looking for `<astro-island` in the served HTML.

**`astro preview` is a daemon.** It registers an instance, refuses to start a
second against the same directory, and leaves the registration behind when a run
is interrupted. The browser tests serve `dist/` with thirty lines of Node instead
— which is also a better check, since it is a second implementation of the same
thing.

## Honest about what it is not

- **Not deployed.** `pnpm build && pnpm preview` is what the tests run against.
  No deployment, no claim of one.
- **The live demonstration uses React** because a hydrated component needs a
  renderer. Exactly one component carries `client:load`; every other page ships no
  island, and that is asserted rather than assumed.
- **The search index is built by the framework's own indexer**, which runs at build
  time against the static output — so a reader's query never leaves their machine.
  Asserting "local" without checking where the index is built would be a claim
  rather than a fact.

## The security material

`/security/threat-model/`, `/security/whitepaper/` and `/security/reporting/`
are written from public primary sources, every one linked and opened at the point
of writing. **Divergences from the current draft are stated**, in a table, because
a library that behaves differently from the specification in a way it can defend
is more useful to an adopter than one that hides it.

Private vulnerability reporting is enabled on the repository and served in the
standard machine-readable form at `/.well-known/security.txt` — checked from the
site root by the build, not only from the page that documents it.