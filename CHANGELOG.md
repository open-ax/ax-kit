# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
This file will be maintained by Changesets once the first package lands.
Do not edit it by hand beyond this scaffolding entry.

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
  Group Report, 26 September 2026.
- `@ax-kit/react`: `useAxTool`, `useAxAction`, `AxProvider`, and
  `isAxSupported` for lifecycle-native tool registration with namespacing
  and execution middleware.

No published package yet. Entries above describe the in-tree API; versioned
releases will be cut with Changesets.
