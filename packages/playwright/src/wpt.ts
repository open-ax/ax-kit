// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The pinned upstream test suite.
 *
 * Web Platform Tests, directory `webmcp/`. The revision is pinned because an
 * unpinned suite changes underneath a run and turns green red for reasons that
 * have nothing to do with this implementation.
 *
 * This revision is the one that matches our pinned draft. `SPEC_VERSION.commit`
 * is `d61d0e6` in webmachinelearning/webmcp, "Remove origin-keyed agent cluster
 * requirement (#330)", merged 2026-09-30. The corresponding WPT commit is
 * `fe52996`, "[WebMCP] Remove origin-keyed agent cluster requirement", committed
 * the same day. They are the same change in the two halves of the suite, so a
 * run at this revision tests the draft we claim to implement.
 */
export const WPT_SHA = "fe52996d4465f23617bce91927bdd58e6ce8f541";

const RAW_BASE = `https://raw.githubusercontent.com/web-platform-tests/wpt/${WPT_SHA}`;

/** The vendor integration file. Overridden by the runner, by design. */
export const HARNESS_REPORT_PATH = "resources/testharnessreport.js";
export const HARNESS_PATH = "resources/testharness.js";

/**
 * How to obtain the suite, so the next person does not rediscover it:
 *
 *   The tests live in the web-platform-tests repository, under `webmcp/`, not
 *   in the proposal repository. The proposal repository holds only `index.bs`
 *   and prose.
 *
 *   Browse:  https://github.com/web-platform-tests/wpt/tree/<SHA>/webmcp
 *   Raw:     https://raw.githubusercontent.com/web-platform-tests/wpt/<SHA>/<path>
 *
 *   To move the pin, find the WPT commit whose message names the same change as
 *   the new `SPEC_VERSION.commit`, put its full SHA above, and update the
 *   comment. Do not float the pin to a branch.
 */
export function rawUrl(path: string): string {
	return `${RAW_BASE}/${path}`;
}

/**
 * Fetch a suite file at the pinned revision, caching it on disk so a repeat run
 * is reproducible and does not depend on the network. A cached file is only
 * reused when it is non-empty, so a truncated download cannot become the pin.
 */
export async function fetchSuiteFile(
	cacheDir: string,
	path: string,
): Promise<string> {
	mkdirSync(cacheDir, { recursive: true });
	const cached = join(cacheDir, `${WPT_SHA}-${path.replace(/[\\/]/g, "__")}`);
	if (existsSync(cached)) {
		const contents = readFileSync(cached, "utf8");
		if (contents.length > 0) {
			return contents;
		}
	}
	const response = await fetch(rawUrl(path));
	if (!response.ok) {
		throw new Error(
			`wpt: ${path} not available at ${WPT_SHA}: ${response.status}`,
		);
	}
	const contents = await response.text();
	if (contents.length === 0) {
		throw new Error(`wpt: ${path} was empty at ${WPT_SHA}`);
	}
	writeFileSync(cached, contents);
	return contents;
}
