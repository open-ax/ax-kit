// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { FileOutcome, SuiteRun } from "./wpt-run.js";

/**
 * Scoring a run against the expected-failure list.
 *
 * The only claim available is **zero unexpected failures** against the pinned
 * revision. Never "everything is green": the reference browser does not pass the
 * whole suite either, and this implementation does not pass all of what it
 * does run.
 *
 * A listed failure that starts passing is reported rather than dropped. That is
 * information — the list has gone stale, and someone has to decide whether the
 * entry or the implementation moved.
 */

/**
 * Why an entry is expected, and what kind of thing the entry is. The
 * distinction is the whole point of the list: "the proposal contradicts itself"
 * and "we do not do this yet" call for completely different responses, and a
 * list that cannot tell them apart is a list nobody can act on.
 *
 * - `upstream-gap` — the draft has no text for this, or the upstream assertion
 *   contradicts the text that exists. The fix belongs in the proposal.
 * - `known-gap` — the draft describes it and this implementation does not do it.
 *   Not accepted and not upstream's: a real divergence, listed so that it is
 *   visible and cannot be mistaken for conformance.
 * - `accepted-deviation` — the implementation deliberately differs, or cannot
 *   differ, and the difference is recorded as a decision.
 * - `runner-limitation` — the harness cannot express the test in this
 *   environment. The implementation was never asked the question.
 */
export type FailureKind =
	| "upstream-gap"
	| "known-gap"
	| "accepted-deviation"
	| "runner-limitation";

/**
 * A stated reason, held once and referenced by every entry it explains.
 *
 * The interface-definition harness alone reports two dozen failures from a
 * single cause. Copying the paragraph into each entry would produce a file that
 * is unreadable and that rots the moment one copy is edited and the rest are
 * not. A reference is resolved at load, and an unresolved reference is a typed
 * failure rather than a silently missing explanation.
 */
export type Reason = { readonly reason: string } | { readonly cause: string };

export type ExpectedFailure = Reason & {
	/** Repository path, or the interface-definition harness path. */
	readonly unit: string;
	/** Absent means the unit failed as a unit rather than in a named subtest. */
	readonly subtest?: string | undefined;
	readonly kind: FailureKind;
};

/**
 * The reason as written out, whether it was given inline or by reference. A
 * report never shows a bare cause key: the reader is owed the sentence.
 */
export interface Explained {
	readonly kind: FailureKind;
	readonly reason: string;
}

/** The reason as written out, whether inline or referenced. Never a bare key. */
export function resolveReason(
	entry: Reason,
	causes: Readonly<Record<string, string>>,
): string {
	return "reason" in entry ? entry.reason : causes[entry.cause];
}

export function explain(
	entry: ExpectedFailure,
	causes: Readonly<Record<string, string>>,
): Explained {
	return { kind: entry.kind, reason: resolveReason(entry, causes) };
}

export interface BrowserExpectations {
	readonly engine: string;
	readonly version: string;
	readonly expectedFailures: readonly ExpectedFailure[];
}

/** A unit that is not run at all, with the reason it is not. */
export type Exclusion = Reason & { readonly unit: string };

export interface ExpectedFailureList {
	readonly draft: string;
	readonly wptRevision: string;
	readonly causes: Readonly<Record<string, string>>;
	readonly exclusions: readonly Exclusion[];
	readonly browsers: Readonly<Record<string, BrowserExpectations>>;
}

export interface ObservedFailure {
	readonly unit: string;
	readonly subtest: string | undefined;
	readonly status: string;
	readonly message: string;
}

export interface Score {
	/** Failures with no entry. Any of these is a build failure. */
	readonly unexpected: readonly ObservedFailure[];
	/** Entries that matched no failure: the list is stale here. */
	readonly nowPassing: readonly ExpectedFailure[];
	/** Entries whose unit was not run at all, so they could not be checked. */
	readonly unchecked: readonly ExpectedFailure[];
}

/** Every failure the run observed, flattened to one key per failure. */
export function observedFailures(
	files: readonly FileOutcome[],
): readonly ObservedFailure[] {
	const failures: ObservedFailure[] = [];
	for (const file of files) {
		if (file.status === "pass") {
			continue;
		}
		if (file.results.length === 0) {
			failures.push({
				unit: file.unit,
				subtest: undefined,
				status: file.status,
				message: file.note,
			});
			continue;
		}
		for (const result of file.results) {
			if (result.status === "PASS") {
				continue;
			}
			failures.push({
				unit: file.unit,
				subtest: result.name,
				status: result.status,
				message: result.message,
			});
		}
	}
	return failures;
}

function key(unit: string, subtest: string | undefined): string {
	return `${unit}\u0000${subtest ?? ""}`;
}

/**
 * Score one browser's run. An entry with no `subtest` covers a failure of its
 * unit *as a unit*, which is what a file that never reported needs.
 *
 * It deliberately does not cover a named subtest. A unit-wide entry exists
 * because the file produced no subtests to name; if the file starts completing
 * and reporting, it is a different file with a different expectation, and the
 * unit-wide entry absorbing its named failures would hide a new divergence
 * behind an entry written for the old behaviour — the one thing this module's
 * "zero unexpected failures" claim cannot survive.
 */
export function scoreRun(
	run: SuiteRun,
	expectations: BrowserExpectations,
): Score {
	const observed = observedFailures(run.files);
	const covered = new Set<string>();
	const unexpected: ObservedFailure[] = [];
	for (const failure of observed) {
		const exact = expectations.expectedFailures.find(
			(entry) =>
				entry.unit === failure.unit && entry.subtest === failure.subtest,
		);
		const unitWide = expectations.expectedFailures.find(
			(entry) =>
				entry.unit === failure.unit &&
				entry.subtest === undefined &&
				failure.subtest === undefined,
		);
		const entry = exact ?? unitWide;
		if (entry === undefined) {
			unexpected.push(failure);
			continue;
		}
		covered.add(key(entry.unit, entry.subtest));
	}
	const nowPassing: ExpectedFailure[] = [];
	const unchecked: ExpectedFailure[] = [];
	for (const entry of expectations.expectedFailures) {
		if (covered.has(key(entry.unit, entry.subtest))) {
			continue;
		}
		if (run.files.some((file) => file.unit === entry.unit)) {
			nowPassing.push(entry);
		} else {
			unchecked.push(entry);
		}
	}
	return { unexpected, nowPassing, unchecked };
}

function fail(message: string): never {
	throw new TypeError(`expected-failures.json: ${message}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return fail(`${where} is not an object`);
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown, where: string): string {
	if (typeof value !== "string" || value === "") {
		return fail(`${where} is not a non-empty string`);
	}
	return value;
}

function asArray(value: unknown, where: string): readonly unknown[] {
	if (!Array.isArray(value)) {
		return fail(`${where} is not an array`);
	}
	return value;
}

const KINDS: readonly FailureKind[] = [
	"upstream-gap",
	"known-gap",
	"accepted-deviation",
	"runner-limitation",
];

/**
 * Exactly one of `reason` and `cause`. Both, or neither, is a malformed entry:
 * both is ambiguous about which sentence is authoritative, and neither is an
 * unexplained entry, which is the one thing this list may not contain.
 */
function parseReason(
	record: Record<string, unknown>,
	where: string,
	causes: Readonly<Record<string, string>>,
): Reason {
	const inline = record["reason"];
	const reference = record["cause"];
	if (typeof inline === "string" && inline !== "") {
		if (reference !== undefined) {
			return fail(`${where} carries both a reason and a cause reference`);
		}
		return { reason: inline };
	}
	if (typeof reference !== "string" || reference === "") {
		return fail(`${where} has neither a reason nor a cause reference`);
	}
	if (causes[reference] === undefined) {
		return fail(
			`${where} refers to cause "${reference}", which the list does not define`,
		);
	}
	return { cause: reference };
}

function parseExpectedFailure(
	value: unknown,
	where: string,
	causes: Readonly<Record<string, string>>,
): ExpectedFailure {
	const record = asRecord(value, where);
	const kind = asString(record["kind"], `${where}.kind`);
	if (!KINDS.includes(kind as FailureKind)) {
		return fail(`${where}.kind is not one of ${KINDS.join(", ")}`);
	}
	const subtest = record["subtest"];
	if (subtest !== undefined && typeof subtest !== "string") {
		return fail(`${where}.subtest is neither absent nor a string`);
	}
	const reason = parseReason(record, where, causes);
	return {
		...reason,
		unit: asString(record["unit"], `${where}.unit`),
		subtest,
		kind: kind as FailureKind,
	};
}

/**
 * Read the list from `unknown`, so a malformed file is a typed failure with a
 * path to the offending entry rather than a silent `undefined` three frames
 * later.
 */
export function parseExpectedFailureList(value: unknown): ExpectedFailureList {
	const root = asRecord(value, "root");
	const pinned = asRecord(root["pinned"], "pinned");
	const causes: Record<string, string> = {};
	for (const [name, text] of Object.entries(
		asRecord(root["causes"], "causes"),
	)) {
		causes[name] = asString(text, `causes.${name}`);
	}
	const browsers: Record<string, BrowserExpectations> = {};
	for (const [name, entry] of Object.entries(
		asRecord(root["browsers"], "browsers"),
	)) {
		const record = asRecord(entry, `browsers.${name}`);
		const where = `browsers.${name}.expectedFailures`;
		const expectedFailures = asArray(record["expectedFailures"], where).map(
			(item, index) => parseExpectedFailure(item, `${where}[${index}]`, causes),
		);
		// One entry per failure. Coverage is keyed on `unit` and `subtest`, so a
		// repeated key is silently dropped at scoring time and changes no verdict
		// — it only inflates the count this list is read for. Nothing else would
		// notice it arriving.
		const seen = new Set<string>();
		for (const listed of expectedFailures) {
			const listedKey = key(listed.unit, listed.subtest);
			if (seen.has(listedKey)) {
				return fail(
					`${where} lists ${listed.unit} and "${listed.subtest ?? "(the file as a whole)"}" twice`,
				);
			}
			seen.add(listedKey);
		}
		browsers[name] = {
			engine: asString(record["engine"], `browsers.${name}.engine`),
			version: asString(record["version"], `browsers.${name}.version`),
			expectedFailures,
		};
	}
	return {
		draft: asString(pinned["draft"], "pinned.draft"),
		wptRevision: asString(pinned["wptRevision"], "pinned.wptRevision"),
		causes,
		exclusions: asArray(root["exclusions"], "exclusions").map((item, index) => {
			const where = `exclusions[${index}]`;
			const record = asRecord(item, where);
			const reason = parseReason(record, where, causes);
			return {
				...reason,
				unit: asString(record["unit"], `${where}.unit`),
			};
		}),
		browsers,
	};
}
