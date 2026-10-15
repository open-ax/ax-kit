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

The draft also adds re-checks to `registerTool` for script that runs while a
caller-supplied tool object is being read. Those are implemented too, and
placed immediately before the tool map is written rather than after the
`inputSchema` step: `registerTool` reads `title`, `execute`, `annotations`,
`signal` and `exposedTo` after serializing, and each of those can run page
script too. Without the re-checks a registration could silently overwrite one
made during its own conversion. See `docs/adr/0011`.