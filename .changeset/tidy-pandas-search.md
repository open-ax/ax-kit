---
"@ax-kit/core": minor
"@ax-kit/playwright": patch
---

Follow the 9 October 2026 draft's execution-error taxonomy. `executeTool`
no longer rejects with `UnknownError`: unknown tools, origin mismatches, and
unexposed tools reject with `NotFoundError`, cross-traversable targets with
`InvalidStateError`, bad input with `DataError`, callback failures and
unserializable results with `OperationError`, and target unload with
`AbortError`. The declarative section left the draft for a separate explainer,
so the imperative-only scope note names the removal rather than a TODO.
