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
- The abort listener is attached only once a registration is known to be
  accepted, so a rejected registration no longer leaves a closure holding the
  document and the tool name.
- `unregisterRecord` returns without notifying when the document is no longer
  fully active, as the draft states. The observable outcome was already correct
  here, because document discovery skips a document with no window - it was
  correct by accident rather than by rule.

`SPEC_VERSION` moves to the 15 October 2026 re-date (`3279798`) in the same
change as the conformance baseline and the drift baseline. The draft's
interface definitions are byte-identical across the range, verified by
extracting and comparing every IDL block. See `docs/adr/0011`.
