// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { SPEC_VERSION } from "@ax-kit/core";
import { expect, test } from "@playwright/test";
import {
	assertSuiteEnumeration,
	fetchSuiteFiles,
	IDL_HARNESS_PATH,
	INTERFACE_PATHS,
	isRunnableSuiteFile,
	listSuiteFiles,
	SUPPORT_PATHS,
	suiteCacheDir,
	WPT_SHA,
} from "../src/wpt.js";
import { runSuite, type SuiteRun } from "../src/wpt-run.js";
import {
	type Exclusion,
	type ExpectedFailureList,
	type ObservedFailure,
	observedFailures,
	parseExpectedFailureList,
	resolveReason,
	scoreRun,
} from "../src/wpt-score.js";

/**
 * The proposal's own suite, run against the built bundle, scored as zero
 * *unexpected* failures.
 *
 * The claim this file makes is narrow and it is the only one available: against
 * the pinned revision of the suite, on the browser named in the list, nothing
 * fails that the list does not already explain. It never says the suite is
 * green, because it is not — see `conformance/expected-failures.json`, where
 * every known failure carries a reason and a kind.
 *
 * The suite is served from real origins by `src/wpt-server.ts` rather than from
 * route interception, so cross-origin documents, frame documents and response
 * headers are all expressible. Two files are substituted, and both are files
 * upstream designates for the job: the vendor reporter and the host-info
 * template. No test file is edited.
 *
 * Per browser, because a browser that fails what another passes has a different
 * expectation and one shared list would hide that. Keyed on subtest names inside
 * the interface-definition harness as well as on file names, because that harness
 * grows upstream without any new file appearing.
 */

const LIST_PATH = new URL(
	"../conformance/expected-failures.json",
	import.meta.url,
);

/**
 * A bound on one file's completion, not a substitute for it. The runner waits on
 * the harness's completion callback; a file that has not reported inside this
 * bound is recorded as not completing, which is a failure and not a pass.
 */
const FILE_BOUND_MS = 30_000;

const list = parseExpectedFailureList(
	JSON.parse(readFileSync(LIST_PATH, "utf8")),
) as ExpectedFailureList;

interface LoadedSuite {
	/** Every servable path, keyed by repository path with no leading slash. */
	readonly bodies: ReadonlyMap<string, string>;
	/** Units this project runs: every runnable file that is not excluded. */
	readonly units: readonly string[];
	/** Runnable files this project does not run, with the reason for each. */
	readonly notRun: readonly Exclusion[];
	/** Every file the enumeration says is runnable, excluded or not. */
	readonly runnable: readonly string[];
}

let loading: Promise<LoadedSuite> | undefined;

function loadSuite(): Promise<LoadedSuite> {
	loading ??= (async () => {
		const files = await listSuiteFiles();
		// An enumeration that cannot be the real suite is a failure. Zero files
		// would mean zero unexpected failures, which looks exactly like a good
		// run and is the reason this guard exists.
		assertSuiteEnumeration(files);
		const runnable = files.filter((file) => isRunnableSuiteFile(file));
		const excluded = new Map(
			list.exclusions.map((entry) => [entry.unit, entry]),
		);
		const servable = files.filter((path) => !path.endsWith(".yml"));
		const bodies = await fetchSuiteFiles(suiteCacheDir(), [
			...servable,
			...SUPPORT_PATHS,
			...INTERFACE_PATHS,
		]);
		return {
			bodies,
			runnable,
			units: runnable.filter((unit) => !excluded.has(unit)),
			notRun: runnable
				.filter((unit) => excluded.has(unit))
				.map((unit) => excluded.get(unit) as Exclusion),
		};
	})();
	return loading;
}

function describeFailure(failure: ObservedFailure): string {
	const where =
		failure.subtest === undefined
			? failure.unit
			: `${failure.unit} > ${failure.subtest}`;
	const message = failure.message.replace(/\s+/g, " ").trim();
	const shortened =
		message.length > 200 ? `${message.slice(0, 200)}...` : message;
	return `    ${failure.status}  ${where}\n      ${shortened}`;
}

function describeEntries(
	entries: readonly {
		readonly unit: string;
		readonly subtest?: string | undefined;
	}[],
): string {
	return entries
		.map((entry) =>
			entry.subtest === undefined
				? `    ${entry.unit} (the file as a whole)`
				: `    ${entry.unit} > ${entry.subtest}`,
		)
		.join("\n");
}

function report(run: SuiteRun, excludedCount: number): string {
	const files = run.files;
	const failures = observedFailures(files);
	const lines = [
		"",
		`  ${run.browserName} ${run.browserVersion}`,
		`    units run ${files.length}   files not run ${excludedCount}   enumerated ${files.length + excludedCount}`,
		`    files passing ${files.filter((file) => file.status === "pass").length}   failing or incomplete ${files.filter((file) => file.status !== "pass").length}`,
		`    subtests passing ${files.flatMap((file) => file.results).filter((result) => result.status === "PASS").length}   failing ${failures.length}`,
		"",
	];
	for (const file of files) {
		if (file.status === "pass") {
			continue;
		}
		const failing = file.results.filter((result) => result.status !== "PASS");
		lines.push(
			`  ${file.unit}  [${file.status}]${file.note === "" ? "" : `  ${file.note}`}`,
		);
		if (failing.length === 0) {
			lines.push("    no failing subtest was reported");
			continue;
		}
		for (const result of failing) {
			const message = result.message.replace(/\s+/g, " ").trim();
			const shortened =
				message.length > 200 ? `${message.slice(0, 200)}...` : message;
			lines.push(`    ${result.status}  ${result.name}`);
			if (shortened !== "") {
				lines.push(`      ${shortened}`);
			}
		}
	}
	return lines.join("\n");
}

test.describe(`WebMCP suite at WPT ${WPT_SHA.slice(0, 7)}`, () => {
	// Roughly eight minutes per browser on a warm cache, and the suite file is
	// pinned rather than skipped, so the wait is part of running it.
	test.setTimeout(45 * 60_000);

	test("the list describes the draft and the suite revision this package pins", async () => {
		expect(list.draft).toBe(SPEC_VERSION.draft);
		expect(list.wptRevision).toBe(WPT_SHA);
	});

	test("every runnable file is either run or left out with a reason", async () => {
		const { units, notRun, runnable } = await loadSuite();
		for (const entry of notRun) {
			// An exclusion is a claim that this file cannot be run and why. A
			// one-line reason is not a reason, so require prose.
			expect(resolveReason(entry, list.causes).length).toBeGreaterThan(120);
			// An exclusion must name a file the enumeration contains. Without
			// this a typo would silently shrink the run instead of failing.
			expect(runnable).toContain(entry.unit);
		}
		// Nothing may be dropped between the enumeration and the run. A gap here
		// is a file that is neither scored nor explained.
		expect(units.length + notRun.length).toBe(runnable.length);
		// The interface-definition harness is not optional. A list that dropped it
		// would look complete and would under-report every upstream interface
		// addition.
		expect(units).toContain(IDL_HARNESS_PATH);
		expect(notRun.map((entry) => entry.unit)).not.toContain(IDL_HARNESS_PATH);
		expect(runnable.length).toBeGreaterThan(50);
	});

	test("zero unexpected failures", async ({ browser }) => {
		const name = browser.browserType().name();
		const expectations = list.browsers[name];
		expect(
			expectations,
			`conformance/expected-failures.json has no entry for ${name}, so there is nothing to score this run against`,
		).toBeDefined();
		const pinned: NonNullable<typeof expectations> = expectations;
		const { bodies, units, notRun } = await loadSuite();
		const run = await runSuite(browser, {
			bodies,
			units,
			fileTimeoutMs: FILE_BOUND_MS,
		});
		console.log(report(run, notRun.length));

		// The recorded version is what the list was derived on. A different
		// browser build can produce different results, so this is a hard check
		// rather than a note: the honest response to a browser bump is to
		// re-derive the list, not to accept a run it was never written for.
		expect(
			run.browserVersion,
			`the list was derived on ${pinned.engine} ${pinned.version}; this is ${run.browserVersion}. Re-derive the list rather than accepting a run it was not written for.`,
		).toBe(pinned.version);

		const score = scoreRun(run, pinned);
		expect(
			score.unexpected.length === 0
				? ""
				: score.unexpected.map(describeFailure).join("\n"),
			"failures with no entry in the expected-failure list",
		).toBe("");
		expect(
			score.nowPassing.length === 0 ? "" : describeEntries(score.nowPassing),
			"listed failures that now pass: the list is stale and someone should decide whether the entry or the implementation moved",
		).toBe("");
		expect(
			score.unchecked.length === 0 ? "" : describeEntries(score.unchecked),
			"listed failures whose file did not run, so the entry could not be checked",
		).toBe("");
	});
});
