# 5. Brand assets and application layout

Date: 2026-10-04
Status: Accepted

## Context

`docs/` had accumulated three unrelated jobs at the same path:

| Path | What it held | Who points at it |
|---|---|---|
| `docs/adr/` | decision records | `AGENTS.md` "Where things live" |
| `docs/agents/` | agent and tracker documentation | `AGENTS.md`, and it is local-only |
| `docs/assets/` | two brand marks | `README.md` |

A directory that means three things cannot be extended. Adding a documentation
site into that same path would have made it four, and the next reader would have
no way to tell which `assets` was meant — the brand marks or the site's own.

`docs/adr/` and `docs/agents/` are named in the repository's own guidance, so
neither can move without breaking a documented path. The brand marks are
referenced from exactly one file and are the only thing here that has no
documented home of its own.

## Decision

**One meaning per directory, and the brand marks get their own root directory.**

| Path | Holds | Rule |
|---|---|---|
| `assets/` | repository-level images referenced from `README.md` | brand marks only |
| `docs/adr/` | decision records | do not rename; documented in `AGENTS.md` |
| `docs/agents/` | agent and tracker documentation | local-only, not committed; documented in `AGENTS.md` |
| `docs/` | documentation of record | no site content and no images |

**An application's own assets live inside the application.** A documentation
site serves its images and downloads from its own `public/` directory under
`applications/docs-site/`; a storefront keeps its own likewise. Nothing an
application serves is added to the repository root, and `assets/` is never
extended to hold one. That is the collision being closed, not merely relocated:
a root-level `assets/` only stays unambiguous while it stays small and
repository-level.

### Why `assets/` at the root

It is unambiguous next to `docs/`, `packages/` and `applications/`, and it
deliberately does not reuse a name a framework already owns. Astro and most
static site generators serve from `public/`; calling the repository-level
directory `static/` or `public/` would have put two different meanings on one
word again.

### Why the marks moved but `docs/adr/` did not

The decision records and the agent documentation are referenced by name from
`AGENTS.md`, and `docs/agents/` is gitignored. Renaming either breaks a
documented path to buy tidiness that costs nothing to leave. The brand marks
were referenced from one line of one file, so moving them was free.

## Consequences

- `README.md` points at `assets/ax-mark-{dark,light}.png`. Both are tracked and
  both resolve.
- The layout rule for applications is settled before the first application
  exists, so the documentation site is created into a path that already means
  one thing.
- The `required files are present` guard now lists both marks, so deleting or
  moving either one fails the build. What it still cannot catch is a `README.md`
  path that points somewhere else: the guard checks that the marks exist where
  they are expected, not that every relative reference in the repository
  resolves. There is no link checker, and a reference that is moved without
  being updated stays green until someone looks at the rendered page.

## Revisit when

- An application needs an image that is shared between applications rather than
  owned by one. That is a different question from a brand mark, and it is
  where a root `assets/` directory would first come under pressure.
- A documentation check is added that resolves repository-relative links and
  images across tracked markdown, at which point the manual resolution pass
  that verified this move can stop being manual.
