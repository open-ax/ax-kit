# 6. Conformance is a gate, not a report

Date: 2026-10-07
Status: Accepted

## Context

This project makes exactly one claim: zero unexpected failures against a pinned
draft of the WebMCP proposal, measured by the proposal's own test suite. That
claim was true when it was written and there was a mechanism that should have
kept it true.

The mechanism was the `spec-drift` workflow. It fetches the published
specification daily, hashes it, compares against
`.github/spec-drift.sha256`, and opens an issue when they differ. It fired on
2026-09-30, the day upstream PR #330 removed the origin-keyed agent cluster
precondition, and it did its job: the change was noticed the same day.

It then sat unanswered for seven days. The hash moved three times while triage
was pending — the workflow helpfully commented each new value onto issue #10 —
and meanwhile this repository's conformance claim was wrong, because the code
still implemented a precondition the draft no longer had. The correction landed
on 2026-10-04. Between the change and the correction, the repository published
a claim it did not meet.

The suite itself was never the problem. `pnpm test:conformance` exists, it
runs the proposal's suite against the built bundle on all three engines, and it
scores zero *unexpected* failures against a per-engine expected-failure list.
On 2026-10-07 it passes: 48 units run, 24 excluded with reasons, 22 files
passing, 64 subtests passing, 78 expected failures, and no failure without an
entry.

The suite was not run by anything that could stop a merge. It was a command a
mainer could type, and a claim in a document that a reader could check by
reading. Both are opt-in.

## Decision

**The conformance suite runs on every change and fails the build.**

`conformance` is a job in `.github/workflows/ci.yml`, separate from `toolchain`
because it needs all three engines rather than one and takes minutes rather
than seconds. It is a required status check on `main`, so a conformance
failure cannot be merged around.

Three things are deliberately absent, and their absence is the decision:

- No `continue-on-error`.
- No allow-failure condition.
- No skip flag reachable from a pull request.

A contributor cannot make this green. Making it green means changing
`packages/playwright/conformance/expected-failures.json` in a reviewed
change, beside the diff that caused the new failure. That is the property worth
having: the list is a claim about upstream and about this implementation, so
editing it deserves the same scrutiny as editing the code, and gets it.

### The drift detector stays, and keeps its shape

The scheduled job is unchanged. It watches upstream and opens an issue, because
detection is a different job from enforcement and the detector is genuinely good
at detection — it caught the change the same day it happened.

What changes is what a *detected* drift now costs. Before this decision, an
open drift issue was a line in an issue list. After it, an open drift issue is a
build that has been red since the next push, which is a fact that gets
attended to. The detector's weakness was never that it was silent; it was that
being loud had no consequence.

### A required check, not a documented one

The job is a required status check with `strict: true`, so it also has to pass
against the current tip of `main` rather than against a stale merge base. A
green run from last week does not satisfy a pull request whose base has moved
on.

## Consequences

- `main` now requires three checks: `guard / Repository guard`, `toolchain /
  Toolchain`, `conformance / Conformance suite`.
- The suite runs on all three engines on every pull request. That is minutes of
  CI and a real download of the pinned suite on a cold cache, paid for by every
  contributor on every change.
- The gate is proven, not asserted. On 2026-10-07 the sort in
  `getTools()` was commented out and the suite run: it failed with exit code 1
  and named the unexpected failure — `webmcp/imperative/getTools.https.html >
  getTools should return all tools sorted in lexicographical order` — which is
  an entry the list does not contain. The change was reverted and the working
  tree returned to clean. A gate that has never been observed failing is not
  known to work.
- Expected-failure entries are now load-bearing in a way they were not. A new
  failure blocks the build rather than appearing in a report somebody might
  read. That is the intended cost and it is the point.

## Revisit when

- The suite exceeds about fifteen minutes of CI. At that point the honest
  options are a scheduled authoritative run plus a faster subset on pull
  requests, or a matrix that drops an engine. Neither is free, and both weaken
  a claim that is currently cheap to keep exact.
- The upstream suite stops being pinnable to a revision that matches a draft
  re-date. Today the pin moves by finding the WPT commit naming the same change
  as the new `SPEC_VERSION.commit`; if that correspondence stops holding, the
  pinning strategy needs rethinking before the gate does.