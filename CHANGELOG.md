# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
Manual entries under [Unreleased] are permitted until the first release;
after that this file will be maintained by Changesets.
Do not edit released sections by hand beyond this scaffolding entry.

To record a change after the toolchain lands, add a changeset:

    npx changeset
    # choose the packages affected, the bump type, and write one sentence
    # describing the change from a user's point of view

Then commit the generated `.changeset/*.md` file.
-->

## [Unreleased]

### Added

- `@ax-kit/core`: `document.modelContext` with tool registration, filtered
  discovery, invocation, lifecycle events, and unloading cleanup, plus an
  opt-in `@ax-kit/core/ax` entry with removal, lookup, parsed-result, and
  change-diff conveniences. Pinned draft (`SPEC_VERSION`): Draft Community
  Group Report, 29 September 2026.
- `@ax-kit/react`: `useAxTool` (full definition or name plus handler),
  `AxProvider`, and `isAxSupported` for lifecycle-native tool registration
  with namespacing and execution middleware.
- `@ax-kit/vue`: `useAxTool`, `vAxTool`, and `isAxSupported` for
  composable plus directive tool registration with client mount lifecycle.
- `@ax-kit/svelte`: `axTool`, `axToolEffect`, and `isAxSupported` for
  element binding plus rune tool registration with update and destroy
  teardown.
- `@ax-kit/react`: `dispatchAxClick` for fallback-wrapped click dispatch
  against React-managed nodes with native bubbling fallback.
- `@ax-kit/playwright`: overriding `page` fixture installing the page-side
  bundle through a single init script before any test navigation, with a
  runner-realm `page.ax` companion offering `getAvailableTools`,
  `waitForTool`, `expectTool`, and `executeTool`. Waits ride the change
  hint with a bounded guard and match by name in code-unit order; execution
  resolves a fresh handle per call and parses the string result at the
  boundary. Pinned draft (`SPEC_VERSION`): Draft Community Group Report,
  29 September 2026.
- `@ax-kit/extension`: worker-side bridge driving `document.modelContext`
  from a service worker over injection-only transport with enumerated
  handlers, side-panel confirmation bound to tab, document, frame, tool
  name, and argument hash, default-deny manifest posture, and a
  worker-held audit trail.

No published package yet. Entries above describe the in-tree API; versioned
releases will be cut with Changesets.
