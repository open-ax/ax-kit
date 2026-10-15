---
"@ax-kit/core": patch
---

Follow the 15 October 2026 draft: unregistering from an inactive document no
longer notifies.

The draft removes the tool definition first and then returns without notifying
when the document is no longer fully active, because the notification algorithm
finds documents by walking the node navigable and an unloaded document has none
to walk from. Removal is unconditional; only the notification is suppressed.

The observable outcome was already correct before this change, because
document discovery skipped a document with no window. It was correct by
accident rather than by rule, and a future change to that walk would have
silently reintroduced the notification. The rule is now stated where the draft
states it.

`SPEC_VERSION` moves to the 15 October 2026 re-date (`3279798`) in the same
change as the conformance baseline and the drift baseline. The draft's
interface definitions are byte-identical across the range, verified by
extracting and comparing every IDL block. See `docs/adr/0011`.

The draft also adds re-checks to `registerTool` after `inputSchema`
serialization, for script that a `toJSON()` method can run. Those are not
implemented here because they are unreachable: the schema validator refuses a
function value before `JSON.stringify` can call one, so no script runs during
serialization in this implementation. The reason is recorded in the decision log
rather than papered over with unreachable code.