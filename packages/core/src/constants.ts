// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Pinned upstream draft this package implements.
 *
 * WebMCP Draft Community Group Report, 15 October 2026, from the W3C Web
 * Machine Learning Community Group (https://webmachinelearning.github.io/webmcp/).
 * This is a draft report, not a W3C Standard and not on the Standards Track.
 *
 * `commit` is the revision the published document carries, not the last commit
 * to touch the specification's text. That revision advances on every re-date
 * even when the text is unchanged, which is why a commit that only adds an
 * explainer can still be the right pin. Here it is the revision that re-dated
 * the draft past the declarative removal (#338), the execution-error taxonomy
 * (#339), and the post-serialization re-checks (#337, #345, #347), so the pin
 * and the code describe the same event.
 */
export const SPEC_VERSION = {
	draft: "Draft Community Group Report, 15 October 2026",
	commit: "3279798",
} as const;
