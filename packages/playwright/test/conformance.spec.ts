// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { resolveInitScriptPath } from "../src/paths.js";
import {
	fetchSuiteFile,
	HARNESS_PATH,
	HARNESS_REPORT_PATH,
	WPT_SHA,
} from "../src/wpt.js";

/**
 * Runs the proposal's own tests against the built bundle.
 *
 * The bundle under test is the artifact the normal `pnpm build` produces —
 * `dist/init.global.iife.js` — installed through an init script so the surface
 * exists before any suite script runs. Not source, not a development build, and
 * not a test-only entry.
 *
 * The suite file is served byte-identical to upstream. The only file replaced is
 * `resources/testharnessreport.js`, which upstream describes as the file
 * "intended for vendors to implement code needed to integrate testharness.js
 * tests with their own test systems". Integration goes through its documented
 * API, `add_result_callback` and `add_completion_callback`, so the test file
 * itself is never edited or wrapped.
 *
 * Waiting is by callback. The reporter calls a page binding as each subtest
 * finishes and once more when the file completes, and the runner awaits that
 * call. There is no polling and no timeout used as a substitute for completion.
 */

const ORIGIN = "https://webmcp.test";

interface SubtestResult {
	readonly name: string;
	readonly status: string;
	readonly message: string;
}

interface HarnessReport {
	readonly kind: "result" | "complete";
	readonly harnessStatus: number;
	readonly results: readonly SubtestResult[];
}

const cacheDir = mkdtempSync(join(tmpdir(), "ax-wpt-"));

/** Serve one suite file at a virtual origin. No real network, no real server. */
async function serveSuiteFile(
	page: Page,
	url: string,
	body: string,
	contentType: string,
) {
	await page.route(url, async (route) => {
		await route.fulfill({ status: 200, contentType, body });
	});
}

const REPORTER = `
(() => {
  const results = [];
  const record = (test) => {
    if (test === null || typeof test !== "object") return;
    // testharness reports a status as a number in the completion payload
    // (0 is PASS) and as a name in some result payloads. Normalise to one word
    // so a verdict is never inferred from its spelling.
    const raw = test.status;
    const status =
      raw === 0 || raw === "0" || raw === "PASS" ? "PASS" : "FAIL";
    results.push({
      name: String(test.name),
      status: status,
      message: test.message === undefined || test.message === null ? "" : String(test.message),
    });
  };
  const emit = (harnessStatus) => {
    try {
      window.__axHarness({
        kind: "complete",
        harnessStatus: harnessStatus,
        results: results.slice(),
      });
    } catch (_) {}
  };
  add_result_callback(record);
  add_completion_callback((tests, status) => {
    // The harness reports completion with a status object; its \`status\` field is
    // the numeric verdict (0 is OK). Authoritative results come from \`tests\`,
    // because a result callback can fire for an intermediate state that later
    // changes.
    if (Array.isArray(tests)) {
      results.length = 0;
      for (const test of tests) record(test);
    }
    const numeric =
      status !== null && typeof status === "object" ? status.status : status;
    emit(Number(numeric));
  });
})();
`;

interface RunResult {
	readonly harnessStatus: number;
	readonly results: readonly SubtestResult[];
}

/** Run one upstream file and resolve when its completion callback fires. */
async function runSuiteFile(
	page: Page,
	suitePath: string,
	options: { readonly breakBundle?: boolean } = {},
): Promise<RunResult> {
	const url = `${ORIGIN}/${suitePath}`;
	await serveSuiteFile(
		page,
		`${ORIGIN}/${HARNESS_PATH}`,
		await fetchSuiteFile(cacheDir, HARNESS_PATH),
		"text/javascript",
	);
	await serveSuiteFile(
		page,
		`${ORIGIN}/${HARNESS_REPORT_PATH}`,
		REPORTER,
		"text/javascript",
	);
	await serveSuiteFile(
		page,
		url,
		await fetchSuiteFile(cacheDir, suitePath),
		"text/html",
	);

	// The built bundle, installed before any suite script runs.
	await page.addInitScript({ path: resolveInitScriptPath() });
	if (options.breakBundle === true) {
		// Deliberate break. The installed `modelContext` property is
		// non-configurable by design, so it cannot be replaced; breaking the
		// method on its prototype is the honest way to simulate a divergence.
		await page.addInitScript(() => {
			const surface = (document as unknown as Record<string, unknown>)[
				"modelContext"
			];
			const proto = Object.getPrototypeOf(surface) as Record<string, unknown>;
			proto["registerTool"] = async (): Promise<never> => {
				throw new TypeError("deliberate break for the conformance runner");
			};
		});
	}

	let settle: (() => void) | undefined;
	const finished = new Promise<void>((resolve) => {
		settle = resolve;
	});
	let report: RunResult | undefined;
	// Surfaced rather than swallowed: a suite file that fails to load reports
	// nothing through the harness, and a silent runner is indistinguishable from
	// one that cannot fail.
	page.on("console", (m) =>
		console.log(`      [page:${m.type()}] ${m.text()}`),
	);
	page.on("pageerror", (e) => console.log(`      [pageerror] ${e.message}`));
	await page.exposeBinding("__axHarness", (_source, payload: HarnessReport) => {
		if (payload.kind === "complete") {
			report = {
				harnessStatus: payload.harnessStatus,
				results: payload.results,
			};
			settle?.();
		}
	});

	await page.goto(url);
	await finished;
	if (report === undefined) {
		throw new Error(`wpt: ${suitePath} never reported completion`);
	}
	return report;
}

function describeResults(report: RunResult): string {
	return report.results
		.map(
			(result) =>
				`      ${result.status === "PASS" ? "PASS" : "FAIL"} ${result.name}`,
		)
		.join("\n");
}

test.describe(`WebMCP suite at WPT ${WPT_SHA.slice(0, 7)}`, () => {
	test("the pinned revision is recorded and the file set is reachable", async () => {
		expect(WPT_SHA).toMatch(/^[0-9a-f]{40}$/);
		// A file we intend to run must be fetchable at the pin.
		const contents = await fetchSuiteFile(
			cacheDir,
			"webmcp/imperative/object-arguments.https.html",
		);
		expect(contents).toContain("document.modelContext.executeTool");
	});

	test("an upstream file executes and reports a real per-subtest verdict", async ({
		page,
	}) => {
		const report = await runSuiteFile(
			page,
			"webmcp/imperative/object-arguments.https.html",
		);
		console.log(`\n  webmcp/imperative/object-arguments.https.html`);
		console.log(
			`    harness status: ${report.harnessStatus} (harness completion code, NOT a pass aggregate)`,
		);
		console.log(describeResults(report));

		// The seam works: real subtests, real names, real verdicts. Whether a
		// given file passes is a conformance question scored in ticket 03, not
		// a claim this runner makes.
		expect(report.results.length).toBeGreaterThan(0);
		for (const result of report.results) {
			expect(["PASS", "FAIL"]).toContain(result.status);
			expect(result.name.length).toBeGreaterThan(0);
		}
	});

	test("the runner reports failure when the bundle is broken", async ({
		page,
	}) => {
		const report = await runSuiteFile(
			page,
			"webmcp/imperative/object-arguments.https.html",
			{ breakBundle: true },
		);
		console.log(`\n  deliberate break, same suite file`);
		console.log(`    harness status: ${report.harnessStatus}`);
		console.log(describeResults(report));
		// A runner that cannot fail is not evidence. This asserts the negative.
		//
		// Note what is *not* asserted: the harness status. It reads 0 even when
		// every subtest fails, because it is the harness's own completion code
		// and not a pass aggregate. The verdict is per subtest.
		expect(report.results.some((result) => result.status !== "PASS")).toBe(
			true,
		);
	});

	test("a divergence found by this runner is pinned, not forgotten", async ({
		page,
	}) => {
		// `object-arguments.https.html` asserts that a tool returning the
		// JavaScript string "Success" makes executeTool resolve to "Success".
		// The draft says otherwise: the IDL is `Promise<DOMString>` and the
		// algorithm resolves with "the result of serializing a JavaScript value
		// to a JSON string", which for that value is `"\"Success\""`.
		//
		// So this implementation is right and the upstream assertion is not. It
		// is recorded here so the divergence cannot be quietly forgotten, and it
		// belongs upstream as an issue rather than here as a code change. If the
		// draft ever changes to match the test, this assertion flips and the
		// runner says so.
		const report = await runSuiteFile(
			page,
			"webmcp/imperative/object-arguments.https.html",
		);
		console.log(`\n  pinned divergence`);
		console.log(`    harness status: ${report.harnessStatus}`);
		console.log(describeResults(report));
		const failed = report.results.filter((result) => result.status !== "PASS");
		expect(failed.length).toBeGreaterThan(0);
		expect(failed[0].message).toContain(
			'expected "Success" but got "\\"Success\\""',
		);
	});
});
