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

/** The root of the suite inside the repository. */
export const SUITE_ROOT = "webmcp";

/**
 * The interface-definition harness, which is a *script* and not a page.
 *
 * It is a separate dimension from the test files: it asserts against the
 * proposal's own generated interface definitions, so it grows every time an
 * interface is added upstream and no new test file appears. A result report
 * keyed only on test file names silently under-reports.
 */
export const IDL_HARNESS_PATH: string = `${SUITE_ROOT}/idlharness.https.window.js`;

/**
 * The three interface definitions the harness above asks for, by the names it
 * passes to `idl_test`. Served from `/interfaces/`, which is where
 * `resources/idlharness.js` fetches them from.
 */
export const INTERFACE_PATHS: readonly string[] = [
	"interfaces/webmcp.idl",
	"interfaces/html.idl",
	"interfaces/dom.idl",
];

/**
 * Suite support files, fetched at the same pin and served from the same origin
 * so that the suite's own relative and absolute references resolve.
 */
/** The path the runner serves the install script from. Runner-owned. */
export const INSTALL_SCRIPT_PATH: string = "/__ax-install.js";

export const SUPPORT_PATHS: readonly string[] = [
	HARNESS_PATH,
	"resources/idlharness.js",
	// The parser `resources/idlharness.js` expects as a `WebIDL2` global. WPT
	// builds it from webidl2.js and vendors the result here; `build.sh` beside
	// it records which version.
	"resources/webidl2/lib/webidl2.js",
	// `common/blank.html` is an empty file upstream. A blank document is the
	// point of it, so an empty body is the correct content, not a failed fetch.
	"common/blank.html",
];

const CONTENTS_API = `https://api.github.com/repos/web-platform-tests/wpt/contents`;

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
	options: { readonly allowEmpty?: boolean } = {},
): Promise<string> {
	mkdirSync(cacheDir, { recursive: true });
	const cached = join(cacheDir, `${WPT_SHA}-${path.replace(/[\\/]/g, "__")}`);
	if (existsSync(cached)) {
		const contents = readFileSync(cached, "utf8");
		if (contents.length > 0 || options.allowEmpty === true) {
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
	if (contents.length === 0 && options.allowEmpty !== true) {
		throw new Error(`wpt: ${path} was empty at ${WPT_SHA}`);
	}
	writeFileSync(cached, contents);
	return contents;
}

/**
 * Fetch many files at the pin, a bounded number at a time.
 *
 * Sequential fetching of the suite dominates the runtime of a run on a cold
 * cache, and a run that is slower than it needs to be is a run people stop
 * waiting for. `common/blank.html` is fetched with `allowEmpty` because a blank
 * document is the point of it.
 */
export async function fetchSuiteFiles(
	cacheDir: string,
	paths: readonly string[],
	concurrency = 8,
): Promise<Map<string, string>> {
	const bodies = new Map<string, string>();
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next;
			next += 1;
			const path = paths[index];
			if (path === undefined) {
				return;
			}
			bodies.set(
				path,
				await fetchSuiteFile(cacheDir, path, {
					allowEmpty: path.endsWith("blank.html"),
				}),
			);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, paths.length) }, worker),
	);
	return bodies;
}

interface ContentsEntry {
	readonly type: string;
	readonly path: string;
}

async function listDirectory(path: string): Promise<readonly ContentsEntry[]> {
	const response = await fetch(`${CONTENTS_API}/${path}?ref=${WPT_SHA}`, {
		headers: { accept: "application/vnd.github+json" },
	});
	if (!response.ok) {
		throw new Error(
			`wpt: cannot enumerate ${path} at ${WPT_SHA}: ${response.status}`,
		);
	}
	const body: unknown = await response.json();
	if (!Array.isArray(body)) {
		throw new Error(`wpt: ${path} did not enumerate to a list`);
	}
	return body.map((entry: unknown) => {
		const record = entry as Partial<ContentsEntry> | null;
		if (
			record === null ||
			typeof record !== "object" ||
			typeof record.type !== "string" ||
			typeof record.path !== "string"
		) {
			throw new Error(`wpt: malformed directory entry under ${path}`);
		}
		return { type: record.type, path: record.path };
	});
}

/**
 * Every file in the pinned suite directory, enumerated through the contents API.
 *
 * The recursive *tree* API is not usable here. WPT is far larger than a single
 * tree response, so it comes back truncated and silently omits whole
 * directories. An enumeration built on it reports zero files, and a run with
 * zero files has zero unexpected failures, which looks green. This walks the
 * contents API instead, and `assertSuiteEnumeration` refuses a listing that
 * cannot be the real one.
 */
export async function listSuiteFiles(): Promise<readonly string[]> {
	const found: string[] = [];
	const queue: string[] = [SUITE_ROOT];
	while (queue.length > 0) {
		const directory = queue.shift() as string;
		for (const entry of await listDirectory(directory)) {
			if (entry.type === "dir") {
				queue.push(entry.path);
				continue;
			}
			found.push(entry.path);
		}
	}
	found.sort();
	return found;
}

/**
 * The files that are *run*: test pages, plus the interface-definition harness.
 *
 * Two groups are not tests and are excluded from the run. `resources/`
 * directories hold pages that other tests load into frames; serving them is
 * required, running them is not. `*.yml`, `*.headers` and `META.yml` are
 * metadata that the runner reads or serves rather than executes.
 */
export function isRunnableSuiteFile(path: string): boolean {
	if (path === IDL_HARNESS_PATH) {
		return true;
	}
	if (path.includes("/resources/")) {
		return false;
	}
	return path.endsWith(".https.html") || path.endsWith(".html");
}

/**
 * A listing that cannot be the real suite is a failure, not an empty run.
 *
 * These two floors exist because the failure mode they catch is silent: an
 * empty or truncated enumeration produces a report with no failures in it, and
 * a report with no failures in it is indistinguishable from a good one. The
 * count is well below the real total on purpose, so a suite that legitimately
 * shrinks is caught and looked at rather than silently reducing coverage.
 */
export function assertSuiteEnumeration(files: readonly string[]): void {
	const runnable = files.filter((file) => isRunnableSuiteFile(file));
	if (runnable.length < 50) {
		throw new Error(
			`wpt: enumerated ${runnable.length} runnable suite files at ${WPT_SHA}, which cannot be the real suite`,
		);
	}
	if (!files.includes(IDL_HARNESS_PATH)) {
		throw new Error(
			`wpt: the interface-definition harness is absent from the enumeration at ${WPT_SHA}`,
		);
	}
}
