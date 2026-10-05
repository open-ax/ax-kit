# Conformance baseline

Conformance here means one thing: zero unexpected failures against the pinned
draft named below. It never means blanket green, because the reference browser
itself does not pass the whole official suite.

Pinned draft: WebMCP Draft Community Group Report, 2 October 2026
(upstream `d61d0e6`), exported as `SPEC_VERSION` from `@ax-kit/core`.

## Layers

- Fast layer (`happy-dom`): pure logic — name validation, schema rejection,
  serialization edges, sorting, gate wiring.
- Browser layer (real Chromium via Vitest Browser Mode): everything touching
  `document.modelContext` - `EventTarget` semantics, `AbortSignal` races, the
  error taxonomy, Permissions Policy gating, origin logic, per-frame
  isolation. Run with `pnpm test`; the `chromium` project needs a Playwright
  Chromium install (`pnpm exec playwright install chromium`).
- Official layer (WPT `/webmcp`): the specification's own suite, run against the
  built bundle on every engine this project claims results for. Scored as zero
  *unexpected* failures against a per-browser expected-failure list. Run with
  `pnpm test:conformance`; see [Official layer](#official-layer-wpt-webmcp)
  below. This is separate from `pnpm test` because it takes minutes rather than
  seconds and needs all three engines installed
  (`pnpm exec playwright install chromium firefox webkit`).

## Decided behaviors

- Omitted `executeTool` arguments default to `{}`. Verified 2026-09-28
  against upstream `webmcp/imperative/object-arguments.https.html`, which
  asserts the default alongside array acceptance and `TypeError` for
  primitives, null, and `toJSON`-yields-undefined objects.
- Change notification is queued as a task, never fired synchronously, so
  listeners cannot run inside the registering call. Decided 2026-09-28 from
  review: the draft queues one task per target on its task source.
  `MessageChannel` posts a real task without timers; where the platform hides
  it, a microtask is the closest ordering available (graceful degradation,
  still never synchronous).
- Handler attributes (`ontoolchange` and siblings) follow standard
  `EventHandler` semantics via one internal wrapper per event type:
  non-functions collapse to null, and explicit listeners are never disturbed.
  Decided 2026-09-28 from review.
- An unrecognized Permissions Policy feature does not deny installation;
  only a recognized-but-denied `tools` feature does. Decided 2026-09-28 from
  review: `allowsFeature` reports false for unknown features too.
- Allow-list entries that serialize to the opaque origin are rejected with
  `SecurityError`, so a file-scheme entry can never match an opaque caller.
  Deliberately fail-closed: file and opaque origins are indistinguishable at
  comparison time, so nothing with a `null` serialization is listable.
  Same-document tools are unaffected (exposure is skipped for the owner).
  Decided 2026-09-28 from review.
- Execution re-checks the target document's gates; a target that lost
  eligibility rejects with `UnknownError`. Target-only unload aborts the
  callback signal while the caller still observes `UnknownError`. Decided
  2026-09-28 from review.

## Official layer (WPT `/webmcp`)

The specification's own suite lives in the **web-platform-tests** repository,
under `webmcp/` — not in the proposal repository, which holds only `index.bs`
and prose.

Pinned revision: **`fe52996d4465f23617bce91927bdd58e6ce8f541`**, recorded in
`WPT_SHA` in `packages/playwright/src/wpt.ts`. That WPT commit is
*"[WebMCP] Remove origin-keyed agent cluster requirement"*, committed
2026-09-30 — the same change, on the same day, as `SPEC_VERSION.commit`
`d61d0e6` in the proposal repository. The two halves of the suite move
together, so a run at this revision tests the draft this package claims.

How to obtain it, so it is not rediscovered:

    browse  https://github.com/web-platform-tests/wpt/tree/<SHA>/webmcp
    raw     https://raw.githubusercontent.com/web-platform-tests/wpt/<SHA>/<path>

To move the pin, find the WPT commit whose message names the same change as the
new `SPEC_VERSION.commit`. Do not float the pin to a branch.

Files are fetched at that immutable revision and cached on disk in one directory
shared by every run and every engine, keyed by the pin, so a repeat run is
byte-identical and needs no network. No test file is edited, wrapped or
reordered. The one change made to a served document is a `<script>` tag inserted
into each HTML document so that the bundle is installed before the document's own
scripts; it is described under [Reading a run](#reading-a-run). Integration goes
through `resources/testharnessreport.js`, which upstream documents as the file
"intended for vendors to implement code needed to integrate testharness.js tests
with their own test systems".

### Reading a run

`harness status` is the harness's own completion code and reads **0 even when
every subtest fails**. It is not a pass aggregate. The verdict is per subtest,
and a file is reported failing when any subtest it reported is not `PASS`.

The bundle is injected into every document the runner serves, ahead of the
document's own scripts, rather than through a browser-context init script alone.
That is not a preference. A context init script reaches subframes inconsistently
across engines — measured, Firefox intermittently left a same-origin child
document without the surface — and a suite whose results depend on which
mechanism won the race is not a suite. The response injection is also what makes
a `window.open` document and a cross-origin frame document instrumented at all.

Two files are substituted, and both are files upstream designates for the job:
`resources/testharnessreport.js`, described in its own header as "intended for
vendors to implement code needed to integrate testharness.js tests with their own
test systems", and `common/get-host-info.sub.js`, a template the WPT server fills
in with the ports and hostnames of whichever machine runs the suite. The three
origins it names are all loopback, which the platform also treats as potentially
trustworthy, so a secure context is what those names still describe. No test file
is edited, wrapped or reordered.

### The measured result

Every runnable file in the pinned revision, on every engine this project claims,
against the built bundle:

| Engine | Build | Units run | Files passing | Subtests passing | Expected failures |
|---|---|---|---|---|---|
| Chromium | 153.0.8010.12 | 48 | 22 | 64 | 78 |
| Firefox | 155.0 | 48 | 22 | 64 | 78 |
| WebKit | 26.6 | 48 | 22 | 64 | 78 |

72 files are runnable at this revision. 24 are excluded with a written reason
and 48 are run. The three lists are separate and each carries its own engine and
version, because a browser that fails what another passes has a different
expectation and one shared list would hide that. **They currently agree.** That
is a measured fact about this revision and this implementation, not a shortcut:
the accounting is per browser, so an engine that diverges produces a red run
rather than a silently shared entry.

The claim this repository makes is therefore narrow and is the only one
available: **zero unexpected failures against the pinned revision, on each named
engine.** It is not "the suite is green". It is not "fully conforming". The
reference browser does not pass the whole suite either, and neither does this.

### Known gaps

These are the draft describing something this implementation does not do. They
are listed so that they cannot be mistaken for conformance, and each carries its
reason in `packages/playwright/conformance/expected-failures.json`. Three of
them account for most of the list.

**The registry is per realm, so tools are not shared across documents.** The
draft requires `getTools()` to resolve to "a list of registered tools from this
document and its descendants that are exposed to this document". The registry is
a `WeakMap` held inside the installed script, and each document that evaluates
the bundle gets its own. A frame therefore registers a tool the parent never
learns of. This is the largest single cause of failure in the list, and it is
also why three files do not complete at all: they wait for a `toolchange` that
the other document's registry cannot raise.

**The interface objects the draft's IDL declares are absent.** The draft declares
`interface ModelContext : EventTarget`, `interface ToolActivatedEvent` and
`interface ToolCancelEvent`, so each is a global constructor. This project
exposes the surface on `document.modelContext` and dispatches plain `Event`
objects. The behaviour the event files assert is implemented; the named types
the draft declares for it are not.

**`modelContext` is an own property, not a prototype accessor.** The draft reads
`partial interface Document { [SecureContext, SameObject] readonly attribute
ModelContext modelContext; }`. An ordinary attribute is an accessor on
`Document.prototype`. This project installs an own, non-writable,
non-configurable data property on the document instance, which the
interface-definition harness reports as a missing prototype member.

One entry is an **upstream gap** rather than ours. `imperative/object-arguments`
asserts that a tool returning the JavaScript string `"Success"` makes
`executeTool` resolve to `"Success"`. The draft's algorithm says "Let
serializedResult be the result of serializing a JavaScript value to a JSON
string", and the IDL return type is `Promise<DOMString>`, so the correct value
is `"\"Success\""`. This implementation encodes. **The upstream assertion
contradicts the draft's text** and belongs in an issue against the proposal's
test suite, not here as a change to the source. Three other files assert the
same thing incidentally.

The list's vocabulary also admits a `runner-limitation` kind, for a test the
harness cannot express in this environment. **No entry currently uses it**: the
three candidates for it when this was first measured — a `window.open` document,
a frame's initial `about:blank`, and a same-origin subframe — became runnable
once the bundle was injected through the response.

### A caveat about a passing file

`imperative/exposedTo-defaults-cross-origin` passes, and it is worth saying why
that is weaker evidence than it looks. It asserts that a cross-origin frame sees
**no** tools from its embedder. The registry gap above makes every frame see no
tools from any other document, so the assertion is true for the wrong reason. A
passing file is only evidence when a working implementation would also pass it,
and this one would not distinguish the two.

### Expected failures

`packages/playwright/conformance/expected-failures.json`, one list per browser,
each entry keyed on a unit and a subtest name and each carrying a kind and a
reason. Reasons are held once in a `causes` table and referenced, because the
interface-definition harness alone produces two dozen failures from a single
cause and twenty-four copies of a paragraph would rot the first time one of them
was edited. A reference that resolves to nothing is a typed failure, so an entry
cannot lose its explanation quietly.

Four kinds, because "the proposal contradicts itself" and "we do not do this
yet" call for different responses and a list that cannot tell them apart is a
list nobody can act on:

| Kind | Meaning |
|---|---|
| `upstream-gap` | The draft has no text, or the upstream assertion contradicts the text that exists. The fix belongs in the proposal. |
| `known-gap` | The draft describes it and this implementation does not do it. A real divergence, listed so it is visible. |
| `accepted-deviation` | The implementation deliberately differs, or cannot differ, and the difference is recorded as a decision. |
| `runner-limitation` | The harness cannot express the test here. Unused at present. |

Five rules govern the list, and each is a check rather than a convention:

- A failure with no entry is **unexpected** and fails the run.
- A listed failure that **starts passing** is reported, not removed. The list has
  gone stale and someone has to decide whether the entry or the implementation
  moved.
- The engine build is recorded and **asserted**. A different browser build can
  produce different results, so the response to a Playwright upgrade is to
  re-derive the list, not to accept a run it was never written for.
- An entry with **no subtest** covers a failure of its unit *as a unit*, which is
  what a file that never reported has. It does not cover a named subtest: if such
  a file starts completing and reporting, it has a different expectation, and the
  run says so rather than absorbing the new failure behind the old entry.
- The same unit and subtest cannot be listed **twice** in one browser. Coverage is
  keyed on that pair, so a repeat entry changes no verdict and only inflates the
  count this list is read for.

So the count above is the number of distinct entries, and it is also the number of
subtests the run actually failed. A list that reported a larger number would be
reporting duplicates.

Re-deriving means: run `pnpm test:conformance`, read the report, and decide each
new failure. Nothing derives the list automatically, on purpose — a list written
by the thing it is meant to check is not evidence.

### Files not run

23 declarative files and `imperative/non-secure.html`, each with a written reason
in the list. The declarative reason is the draft's own: section 4.3 reads, in
full, "This section is entirely a TODO." There is no normative text to implement
against and nothing for a run to measure. The other is environmental: every
origin the runner serves is a loopback address, which the platform classifies as
potentially trustworthy, so a non-secure context is not reachable without a
resolver override the runner does not implement.

Excluded is not the same as passing, and neither is the same as expected to fail.
An expected failure is a claim that a failure is understood. An exclusion is a
claim that there is nothing to measure.

## Upgrade path

When the draft re-dates, `SPEC_VERSION` moves with it in the same commit as any
behaviour change, `WPT_SHA` moves to the suite revision that carries the same
change, the expected-failure lists are re-derived on every engine, and the
release note names the new draft. The scheduled drift job
(`.github/workflows/spec-drift.yml`) opens an issue when the published document
changes; the baseline hash lives in `.github/spec-drift.sha256`. If the draft
looks wrong, that is an upstream issue, never a rename in the source.
