---
"@ax-kit/core": minor
---

Add `@ax-kit/core/auto`, an entry point that installs the tool surface against
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