# The audit and the bridge, side by side

Two tools in this repository look at the same page and answer different
questions.

`ax-kit audit <url>` reads the page's `document.modelContext` and grades the
contract it declares: is every tool typed, are the annotations coherent, is the
page within its character budgets, does the feature policy admit it. It says so
in every report, names its lane, and refuses to print an unqualified readiness
score. That much was already true.

The bridge — the daemon, the extension's service worker, and the page they
reach — decides what an agent may actually see and invoke. It decides exposure
against the page's own origin, requires a browser-asserted document identity
before approving anything consequential, and minimises arguments against what
the tool's schema declared.

Nothing connected the two. A page could score a clean audit and expose nothing;
a page could score badly on a character budget and be entirely invokable.
Neither is a defect in either tool. Both are a failure to say which is which,
and a reader who cannot tell will stop trusting the audit.

This document is the record of what the two actually say about the same pages.
Every line below is an observation from
`packages/cli/test/audit-vs-bridge.test.ts`, which drives the audit's own
collector and scorer against the shipped `PageBridge` over a real loopback
transport, with the shipped extension loaded into a real Chromium, on one page
in one browser session. Nothing in it is simulated, and nothing in it is
inferred from reading either source.

Run it:

```sh
# This suite drives the real bridge, so the daemon has to be built first. On a
# fresh checkout `dist/` is absent and Vitest has no build hook of its own - it
# resolves `@ax-kit/daemon` through that export and fails before collecting a
# single test. `--filter=@ax-kit/cli...` builds the cli and everything it
# depends on, which now includes the daemon.
pnpm turbo run build --filter=@ax-kit/cli... &&
	pnpm --filter @ax-kit/cli exec vitest run test/audit-vs-bridge.test.ts
```

## What each side is actually asking

| | audit | bridge |
|---|---|---|
| Subject | the in-page contract | one invocation at a time |
| Decides | quality of what the page declares | whether a specific call may run |
| Knows about the browser | no | yes — it is in one |
| Sees `exposedTo` | no, and the listing does not carry it | no, and says so in a comment |
| Failure means | the page is scored poorly | nobody was asked, or the page was refused |

## The disagreements

Seven. Each is a page in `packages/cli/test/fixtures.ts`, and each is asserted
in the test file by the name given here.

### 1. `typed` fails on a tool the bridge runs with no arguments at all

*Direction: the bridge exposes it, the audit penalises it.*

The `untyped` fixture registers `bareTool` with no `inputSchema`.

- audit: `typed` fails — "missing or invalid input schema".
- bridge: `tools/list` returns `bareTool`. The worker's boundary check
  (`validateFrameTool`) requires a name, a description, an origin and a
  definition version; a schema is not among them. `executeTool` runs it.

The audit is right that something is wrong and wrong about what. The bridge
derives its argument allow-list from the schema's properties
(`declaredKeys`), so a tool with no schema declares no keys, every argument is
dropped by `applyArgAllowList`, and the page's `execute` is called with `{}`. The
tool is reachable and does nothing a caller asked for.

**This is why `typed` is labelled `enforced`** and the budget checks are not. It
is the one per-tool check whose failure means the tool cannot honour a call.

### 2. Four character budgets that nothing enforces

*Direction: cosmetic.*

The `overlong` fixture registers a tool with a 38-character name and a
600-character description.

- audit: `naming-budget` fails (38/30) and `description-budget` fails (600/500).
- bridge: `tools/list` returns the tool. `validateFrameTool` requires
  `description.length > 0` and says nothing at all about length.

The budgets are quoted from platform guidance. They are real advice and they are
not enforced by the bridge, the core, or the platform. **Advisory.**

### 3. `read-only-sanity` fails on a tool the bridge protects *more* than asked

*Direction: cosmetic, and in the safe direction.*

The `inverted` fixture registers `refundOrder` with both `readOnlyHint: true`
and `consequentialHint: true`.

- audit: `read-only-sanity` fails — "read-only and consequential together is
  inverted".
- bridge: the tool is listed, and an invocation takes the confirmation path,
  because the worker reads `consequentialHint` and that is what selects the
  branch. The person is asked.

The audit is correct that the page asserts two contradictory things about its
own consequence. The consequence for an agent is that the tool is *harder* to
reach, not easier. **Labelled `enforced`** anyway, because the annotation the
audit grades is the same one the bridge branches on — a page that disagrees with
itself here is disagreeing with the control, not merely with a style guide.

### 4. `exposure` passes on a page that registered four origins

*Direction: the audit passes a check it never got the data for. This is a
defect in the audit, and it is the sharpest one found.*

The `overBroad` fixture registers one tool with
`exposedTo: ["http://127.0.0.1:1", "http://localhost:2", "http://127.0.0.1:3",
"http://127.0.0.1:4"]`. The core accepts all four as potentially trustworthy and
stores them.

- audit: `exposure` **passes**, detail "exposure narrow".
- bridge: `tools/list` returns `wideTool`.

The audit is not wrong about the bridge here — the bridge admits the page's own
origin and nothing else, so four declared origins are not four reachable
callers. It is wrong about itself. `collectContext` reads
`record.exposedOrigins` off each entry of `getTools()`, and the shipped core's
`collectRegisteredTools` does not put `exposedOrigins` in a registered tool at
all. The field is absent, the collector sees an empty list, and the check grades
an absence of information as a narrow exposure.

**On any page installed by the shipped core, the audit's `exposure` check cannot
fail.** The only fixture in the suite where it fails is `forged`, which
fabricates an `exposedOrigins` array on a context the core never created.

Not fixed here, deliberately. The two honest fixes are to have the core's
listing carry the declared set, or to have the check say "no declared origins
were reported" instead of "exposure narrow". The first is a change to the core's
public surface and the second changes what the audit claims about a page it has
not inspected; both are decisions for the owner of those surfaces rather than for
the place this record was written from. Until one of them happens, a page told
"exposure narrow" was told nothing.

### 5. A destructive tool the audit passes, which the bridge runs unattended

*Direction: the audit approves of a tool the bridge will not ask anyone about.
The audit's defect, per the rule that says so.*

The `noConsequential` fixture registers `deleteEverything` — "Delete every
record for this account. Irreversible." — with an empty schema and no
annotations.

- audit: every per-tool check **passes**. The only failure is
  `consequential-coverage: site` — "0/1 consequential annotated" — a score over
  the page, not a property of the tool.
- bridge: `tools/list` returns it, and `tools/call` **executes it**, returning
  the tool's own result. Nobody is asked, because the worker selects the
  confirmation branch on `consequentialHint` and this page set none.

The audit's only complaint here is a page-level proportion. A reader who fixed
it would raise the page's proportion; a reader who did not would ship a tool
that deletes every record without a confirmation, and the exit code would not
have differed. `consequential-coverage` is the check that most looks like a
safety verdict and is least like one. **Advisory.**

The honest audit finding for this page does not exist yet, and it would be a
per-tool one: a tool whose description declares an irreversible effect and
whose annotations deny it. The audit has no check that compares what a page
says a tool does against what it says the tool will do.

### 6. A page the audit scores and the bridge will not describe

*Direction: the bridge refuses; the audit keeps grading.*

The `forged` fixture installs no context and defines an impostor on the
document with two entries, neither of which carries an `origin`.

- audit: reads both entries and produces findings — `typed: totallySafe` fails
  ("missing or invalid input schema", because the entry claims the string
  `"not-a-schema"`), `exposure: wildClaim` fails ("exposure over-broad:
  wildcard").
- bridge: `tools/list` **rejects the entire listing** with `bad origin`.
  `validateFrameTool` calls `checkOrigin("")`, which rejects. One bad entry
  takes the whole page's tool list with it.

Every score the audit produced is about two tools no agent can see, and the
reason it gave for each is not the reason the bridge gave. The bridge's reason
names a field — `origin` — that the audit never reads.

### 7. "No tools" and "no context" are the same report

*Direction: the audit cannot distinguish two different pages.*

`noContext` installs nothing. `empty` installs a context and registers nothing.

- audit: identical. `tools: []` for both, and both report
  `consequential-coverage: site` with the detail "no tools to annotate".
- bridge: both list nothing, for the same reason — `listToolsInPage` finds no
  `document.modelContext`, or finds one whose `getTools()` returns `[]`.

The bridge's two reasons are different even though its two answers are the
same: one page never exposed anything, the other exposed nothing on purpose. The
collector cannot see the difference, because it reads `document.modelContext`
either not at all or successfully and both paths return `{ tools: [] }`.

This costs wall clock as well as meaning: auditing a page with no context spends
the driver's full 5-second context wait before it can report that the page has
no context. Measured at 5.2 s for that one page in the suite.

## The ones that agree

Recorded so the record is not only the failures.

- **`clean`.** Two typed tools, one consequential. Audit: no findings. Bridge:
  both listed; `viewCart` executes and returns its own value; `placeOrder`
  answers `requiresConfirmation: true` and executes nothing.
- **`empty` and `noContext`.** Both list nothing. Both fail
  `consequential-coverage`. The disagreement between them is #7, not the answer.
- **A tool the audit approves of and the bridge *does* refuse**: only
  `placeOrder`, and the bridge does not refuse it — it asks. Every refusal
  observed in this comparison (`noSuchTool`, a mislabelled origin) is a refusal
  of something the audit never scored.

## What the labels mean, and why they are in the output

Each check now carries `advisory` or `enforced`, and the report prints it on
every line plus a count in the summary. The classification is the table in
`packages/cli/src/scoring.ts`, and every entry in it is one of the observations
above:

| check | label | observation |
|---|---|---|
| `typed` | enforced | #1 — arguments cannot survive to the page |
| `read-only-sanity` | enforced | #3 — the bridge branches on this annotation |
| `policy` | enforced | the platform's own gate; nothing is exposed when it denies |
| `naming-budget` | advisory | #2 |
| `description-budget` | advisory | #2 |
| `param-description-budget` | advisory | #2 |
| `output-budget` | advisory | #2 |
| `exposure` | advisory | #2, #4 — and #4 says the check cannot fail at all |
| `consequential-coverage` | advisory | #5 — a page score, not a gate |
| `consequential-annotated` | advisory | cannot fail by construction |

The exit code still counts every finding, advisory included. That is
deliberate and it is stated in the report on every run: the code is a verdict on
the in-page contract, and the labels are what tell a reader how much of it
predicts an agent. Changing what the exit code counts is a user-visible change
to a documented contract, and nothing in this comparison requires it.

## What this does not do

The audit's lane is unchanged. It scores an in-page contract and the bridge's
answers never enter its score — asserted directly, by taking a clean page's
audit before and after a bridge call the audit has no opinion about and getting
byte-identical findings.

This document is not a site verdict. It says nothing about whether a page's
tools are *safe*, only about which of the audit's complaints the bridge acts on.
Four of the seven observations are cases where the audit is right and the bridge
is indifferent; that is not the bridge being wrong. A character budget is advice
and the bridge declines to enforce advice.

## Not verified

- Only Chromium at `channel: "chromium"`, headless, over loopback HTTP. The
  observations above say nothing about a secure origin reached over TLS, where
  `installModelContext`'s secure-context gate has a different answer, nor about
  a cross-origin frame, where exposure is the interesting case and none of
  these fixtures reach it.
- The `policy` row is labelled `enforced` from the core's code path, not from an
  observation. The audit only believes a denial when
  `document.permissionsPolicy.features()` lists `"tools"`, and Chromium does not
  implement that feature, so in this browser `policy` always passes and its
  label is untested in practice.
- A single Chromium build. No claim is made about any other version.