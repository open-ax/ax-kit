// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";
import { assertSuiteEnumeration, IDL_HARNESS_PATH } from "../src/wpt.js";
import type { FileOutcome, SuiteRun } from "../src/wpt-run.js";
import {
	observedFailures,
	parseExpectedFailureList,
	resolveReason,
	scoreRun,
} from "../src/wpt-score.js";

/**
 * The scoring rules, tested without a browser.
 *
 * These are here because the guards they cover decide whether a red run is
 * reported as red. A guard that cannot fail is not evidence, and the failure
 * mode this whole effort exists to prevent is a run that reports green because
 * the accounting lost track of something. Every case below is a shape a real
 * run produced, including two that came out of this runner's own bugs.
 */

function file(overrides: Partial<FileOutcome> & { unit: string }): FileOutcome {
	return {
		kind: "harness",
		status: "fail",
		results: [],
		note: "",
		...overrides,
	};
}

function run(files: readonly FileOutcome[]): SuiteRun {
	return { browserName: "chromium", browserVersion: "0", files };
}

const LIST = {
	pinned: { draft: "a draft", wptRevision: "a revision" },
	causes: { known: "a stated reason long enough to be a reason" },
	exclusions: [{ unit: "webmcp/declarative/x.https.html", cause: "known" }],
	browsers: {
		chromium: {
			engine: "an engine",
			version: "0",
			expectedFailures: [
				{
					unit: "webmcp/imperative/a.https.html",
					subtest: "one",
					kind: "known-gap",
					cause: "known",
				},
				{
					unit: "webmcp/imperative/b.https.html",
					kind: "known-gap",
					reason: "inline",
				},
			],
		},
	},
};

const list = parseExpectedFailureList(structuredClone(LIST));

test("a failing subtest with no entry is unexpected", () => {
	const score = scoreRun(
		run([
			file({
				unit: "webmcp/imperative/a.https.html",
				results: [
					{ name: "one", status: "FAIL", message: "boom" },
					{ name: "three", status: "FAIL", message: "new breakage" },
					{ name: "two", status: "PASS", message: "" },
				],
			}),
		]),
		list.browsers.chromium,
	);
	expect(score.unexpected.map((entry) => entry.subtest)).toEqual(["three"]);
	expect(score.nowPassing).toEqual([]);
});

test("a listed failure that now passes is reported, not dropped", () => {
	const score = scoreRun(
		run([
			file({
				unit: "webmcp/imperative/a.https.html",
				results: [{ name: "one", status: "PASS", message: "" }],
			}),
		]),
		list.browsers.chromium,
	);
	expect(score.unexpected).toEqual([]);
	expect(score.nowPassing.map((entry) => entry.subtest)).toEqual(["one"]);
});

test("an entry whose file did not run is reported as unchecked", () => {
	const score = scoreRun(run([]), list.browsers.chromium);
	expect(score.nowPassing).toEqual([]);
	expect(score.unchecked.map((entry) => entry.unit)).toEqual([
		"webmcp/imperative/a.https.html",
		"webmcp/imperative/b.https.html",
	]);
});

test("an entry with no subtest covers the whole file", () => {
	const score = scoreRun(
		run([
			file({
				unit: "webmcp/imperative/b.https.html",
				status: "did-not-complete",
				note: "the harness never reported completion",
			}),
		]),
		list.browsers.chromium,
	);
	expect(score.unexpected).toEqual([]);
	// The other entry's file was not in the run at all, which is a different
	// problem from an entry that has gone stale, and is reported as such.
	expect(score.nowPassing).toEqual([]);
	expect(score.unchecked.map((entry) => entry.unit)).toEqual([
		"webmcp/imperative/a.https.html",
	]);
});

test("a file that reports nothing is one failure, not zero", () => {
	const failures = observedFailures([
		file({
			unit: "webmcp/imperative/c.https.html",
			status: "did-not-complete",
			note: "hung",
		}),
	]);
	expect(failures).toHaveLength(1);
	expect(failures[0].subtest).toBeUndefined();
	expect(failures[0].message).toBe("hung");
});

/**
 * Regression. The interface-definition harness was once classified as a crash
 * test, and a crash test's verdict ignored its subtests: 27 failing assertions
 * were recorded as a passing file. A kind must never be able to hide a failure.
 */
test("a crash-kind file that reports failures is still a failure", () => {
	const crashFile = file({
		unit: IDL_HARNESS_PATH,
		kind: "crash",
		note: "survived; observed completion",
		results: [
			{ name: "idl_test setup", status: "PASS", message: "" },
			{
				name: "ModelContext interface object name",
				status: "FAIL",
				message: "missing",
			},
		],
	});
	expect(observedFailures([crashFile])).toHaveLength(1);
	const score = scoreRun(run([crashFile]), list.browsers.chromium);
	expect(score.unexpected.map((entry) => entry.subtest)).toEqual([
		"ModelContext interface object name",
	]);
});

test("an enumeration that cannot be the real suite is rejected", () => {
	expect(() => assertSuiteEnumeration([])).toThrow(/cannot be the real suite/);
	const many = Array.from(
		{ length: 60 },
		(_, index) => `webmcp/imperative/f${index}.https.html`,
	);
	expect(() => assertSuiteEnumeration(many)).toThrow(/harness is absent/);
	expect(() =>
		assertSuiteEnumeration([...many, IDL_HARNESS_PATH]),
	).not.toThrow();
});

test("a cause reference that resolves to nothing is a typed failure", () => {
	const broken = structuredClone(LIST) as {
		browsers: { chromium: { expectedFailures: { cause: string }[] } };
	};
	broken.browsers.chromium.expectedFailures[0].cause = "not-defined";
	expect(() => parseExpectedFailureList(broken)).toThrow(/not-defined/);
});

test("an entry with no explanation at all is rejected", () => {
	const broken = structuredClone(LIST) as {
		browsers: { chromium: { expectedFailures: Record<string, unknown>[] } };
	};
	delete broken.browsers.chromium.expectedFailures[0].cause;
	expect(() => parseExpectedFailureList(broken)).toThrow(
		/neither a reason nor a cause/,
	);
});

/**
 * Regression. A unit-wide entry was written for a file that reports nothing at
 * all, and it was matching any failure in that unit including one with a
 * `subtest`. A file that starts completing would then have its new named
 * failures absorbed by the entry written for the old behaviour, and the run
 * would stay green while a divergence went unreported.
 */
test("a unit-wide entry does not cover a named failing subtest", () => {
	const score = scoreRun(
		run([
			file({
				unit: "webmcp/imperative/b.https.html",
				results: [{ name: "a named subtest", status: "FAIL", message: "new" }],
			}),
		]),
		list.browsers.chromium,
	);
	expect(score.unexpected.map((entry) => entry.subtest)).toEqual([
		"a named subtest",
	]);
});

test("a unit-wide entry is reported as stale when the file starts passing", () => {
	// The unit-level case is still covered, so an entry nobody has re-derived
	// cannot survive a file that completes.
	const score = scoreRun(
		run([file({ unit: "webmcp/imperative/b.https.html", status: "pass" })]),
		list.browsers.chromium,
	);
	expect(score.unexpected).toEqual([]);
	expect(score.nowPassing.map((entry) => entry.unit)).toEqual([
		"webmcp/imperative/b.https.html",
	]);
});

test("the same unit and subtest listed twice is rejected", () => {
	const repeated = structuredClone(LIST) as {
		browsers: {
			chromium: { expectedFailures: Record<string, unknown>[] };
		};
	};
	repeated.browsers.chromium.expectedFailures.push({
		unit: "webmcp/imperative/a.https.html",
		subtest: "one",
		kind: "known-gap",
		cause: "known",
	});
	expect(() => parseExpectedFailureList(repeated)).toThrow(/twice/);
});

test("a reason is reported in full, never as a bare key", () => {
	const entry = list.exclusions[0];
	expect(resolveReason(entry, list.causes)).toBe(LIST.causes.known);
	expect(resolveReason({ reason: "written out" }, list.causes)).toBe(
		"written out",
	);
});
