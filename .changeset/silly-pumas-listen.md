---
"@ax-kit/core": patch
---

Follow the 15 October 2026 draft.

- `executeTool` rejects a detached target with `InvalidStateError`. Previously
  every failing target collapsed into `NotFoundError`, so a target that had been
  removed from its navigable was reported as a missing tool - a different fact,
  and one a caller could act on wrongly.
- `registerTool` re-checks, immediately before writing the tool, that the
  document is still fully active and that the name is still free. Everything
  between the opening gate and that write reads a caller-supplied object -
  the schema's `toJSON`, `title`, `execute`, `annotations`, `signal`,
  `exposedTo` - and each can run page script. Without the re-checks a
  registration could silently overwrite one made during its own conversion.
- The abort listener is attached before those re-checks rather than after them.
  Signal validation duck-types rather than testing the prototype, so
  `addEventListener` is a method the caller supplied and calling it runs caller
  script; attached last, it ran in the window the re-checks exist to close. A
  rejected registration now detaches the listener it attached.
- `unregisterRecord` returns without notifying when the document is no longer
  fully active, as the draft states. The observable outcome was already correct
  here, because document discovery skips a document with no window - it was
  correct by accident rather than by rule.

`SPEC_VERSION` moves to the 15 October 2026 re-date (`3279798`) in the same
change as the conformance baseline and the drift baseline. The draft's
interface definitions are byte-identical across the range, verified by
extracting and comparing every IDL block. See `docs/adr/0011`.
