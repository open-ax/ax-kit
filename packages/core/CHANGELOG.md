# @ax-kit/core

## 0.1.0

### Minor Changes

- 351bf41: Stop refusing to operate on a document that is not origin-keyed. The 2 October
  2026 draft removed the agent cluster precondition from `registerTool`,
  `getTools` and `executeTool`, so a page whose `document.domain` has drifted is
  now served normally instead of rejecting with a `SecurityError` and logging a
  `WebMCP unavailable` warning. `ax-kit audit` no longer reports an
  `origin-keyed cluster` finding, because a conformant site was being failed for a
  requirement that no longer exists. Origin restrictions on which origins may see
  and invoke a given tool are a separate mechanism and are unchanged.
- 2dcd1a2: Add `@ax-kit/core/auto`, an entry point that installs the tool surface against
  the ambient document when it is imported. It is for server-rendered
  applications, where the one place a polyfill belongs is the framework's client
  entry hook, and marking the whole component tree client-side just to get the
  import to run in a browser throws away server rendering.
  
  Importing it does nothing where there is no `document`, so it is safe to
  evaluate in an environment that renders on a server. A repeated import does
  nothing at all: an existing native or polyfilled `document.modelContext` is
  preserved rather than replaced, because a polyfill that overwrites a native
  implementation makes the platform look broken.
  
  It is a separate entry point rather than part of the root one, and separately
  for bytes — the root entry is measured against a hard 5 KB gzip budget, and an
  install-on-import side effect is opt-in behaviour a conformant consumer has no
  reason to pay for. The root and `/ax` entries remain free of import side
  effects; this one declares itself in `sideEffects`.
  
  ```js
  // client-entry.js, which runs before hydration
  import "@ax-kit/core/auto";
  ```
- e11bee4: Follow the 9 October 2026 draft's execution-error taxonomy. `executeTool`
  no longer rejects with `UnknownError`: unknown tools, origin mismatches, and
  unexposed tools reject with `NotFoundError`, cross-traversable targets with
  `InvalidStateError`, bad input with `DataError`, callback failures and
  unserializable results with `OperationError`, and target unload with
  `AbortError`. The declarative section left the draft for a separate explainer,
  so the imperative-only scope note names the removal rather than a TODO.

### Patch Changes

- 2df6b8d: Follow the 15 October 2026 draft.
  
  - `executeTool` rejects a detached target with `InvalidStateError`. Previously
    every failing target collapsed into `NotFoundError`, so a target that had been
    removed from its navigable was reported as a missing tool - a different fact,
    and one a caller could act on wrongly.
  - `registerTool` re-checks, before writing the tool, that the document is still
    fully active and that the name is still free. Everything between the opening
    gate and that write reads a caller-supplied object - the schema's `toJSON`,
    `title`, `execute`, `annotations`, `signal`, `exposedTo`, and the signal's own
    `addEventListener` - and each can run page script. Without the re-checks a
    registration could silently overwrite one made during its own conversion. The
    re-checks run twice: once where the draft places them, so that a name squatted
    during serialization reports `InvalidStateError` rather than the abort reason
    of a signal that same script aborted, and once as the last thing before the
    write, so nothing caller-controlled runs inside the window they guard.
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
