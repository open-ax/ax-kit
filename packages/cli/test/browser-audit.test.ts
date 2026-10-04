// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectContext } from "../src/audit.js";
import type { DrivenBrowser } from "../src/driver.js";
import {
	auditLiveUrl,
	auditLiveUrlFindings,
	exitCodeFor,
	launchDrivenBrowser,
} from "../src/driver.js";
import type { AuditContextInput } from "../src/scoring.js";
import { countFailures, scoreAudit } from "../src/scoring.js";
import type { FixtureServer } from "./fixtures.js";
import { serveFixtures } from "./fixtures.js";

/**
 * The audit against real headless Chromium, on real pages that install the
 * shipped core.
 *
 * This replaces a test whose fake `evaluate` ran the collector with no
 * `document`, so it took the empty-snapshot branch on every run and passed
 * before, during, and after the product was absent. Every assertion below
 * depends on a real `ModelContext` existing in the page, which is exactly what
 * the deleted test could not observe.
 *
 * No sleeps. Readiness is Chromium's own document-committed signal from
 * `goto`, plus an event-driven wait for the fixture's registration to settle.
 */

let server: FixtureServer;
let browser: DrivenBrowser;
const contexts = new Map<string, AuditContextInput>();

beforeAll(async () => {
	server = await serveFixtures();
	browser = await launchDrivenBrowser({ headless: true });
}, 120_000);

afterAll(async () => {
	await browser?.close();
	await server?.close();
});

/**
 * Collect one fixture's context through a real page.
 *
 * Readiness is the fixture's own completion marker, polled by the browser. A
 * fixture that throws reports its error, so a broken fixture fails loudly
 * instead of silently collecting nothing.
 */
async function auditFixture(name: string): Promise<AuditContextInput> {
	const cached = contexts.get(name);
	if (cached !== undefined) {
		return cached;
	}
	const page = await browser.newPage();
	await page.goto(`${server.origin}/${name}`);
	await page.waitFor(
		(expected: unknown) => {
			const scope = globalThis as unknown as Record<string, unknown>;
			return (
				scope["__fixture"] === expected || scope["__fixtureError"] !== undefined
			);
		},
		name,
		`fixture ${name} never completed`,
	);
	const failure = await page.evaluate(
		() =>
			(globalThis as unknown as Record<string, unknown>)["__fixtureError"] ??
			null,
	);
	if (typeof failure === "string") {
		throw new Error(`fixture ${name} failed: ${failure}`);
	}
	const context = await collectContext(page);
	contexts.set(name, context);
	return context;
}

function findingPass(context: AuditContextInput, check: string): boolean {
	const found = scoreAudit(context).find((entry) => entry.check === check);
	if (found === undefined) {
		throw new Error(`no ${check} finding`);
	}
	return found.pass;
}

describe("audit under real headless Chromium", () => {
	it("collects a real registered tool set from a page running the core", async () => {
		const context = await auditFixture("clean");
		const tools = context.tools;
		// Two registered, both visible. An empty collection fails here.
		expect(tools.length).toBe(2);
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"placeOrder",
			"viewCart",
		]);
		expect(tools.every((tool) => tool.description.length > 0)).toBe(true);
	});

	it("reports no tools for a page that registers none, without inventing any", async () => {
		const context = await auditFixture("empty");
		expect(context.tools).toEqual([]);
		const findings = scoreAudit(context);
		const coverage = findings.find(
			(entry) => entry.check === "consequential-coverage",
		);
		expect(coverage?.pass).toBe(false);
		expect(coverage?.detail).toBe("no tools to annotate");
	});

	it("distinguishes no tools from tools present but undiscoverable", async () => {
		const empty = await auditFixture("empty");
		const clean = await auditFixture("clean");
		const emptyCoverage = scoreAudit(empty).find(
			(entry) => entry.check === "consequential-coverage",
		);
		const cleanCoverage = scoreAudit(clean).find(
			(entry) => entry.check === "consequential-coverage",
		);
		// Both fail coverage, for different stated reasons. A run that collected
		// nothing would collapse these into one indistinguishable answer.
		expect(emptyCoverage?.detail).toBe("no tools to annotate");
		expect(cleanCoverage?.detail).toBe("1/2 consequential annotated");
		expect(emptyCoverage?.detail).not.toBe(cleanCoverage?.detail);
	});

	it("scores an annotated baseline as passing its own checks", async () => {
		const context = await auditFixture("clean");
		expect(findingPass(context, "typed")).toBe(true);
		expect(findingPass(context, "exposure")).toBe(true);
		expect(findingPass(context, "read-only-sanity")).toBe(true);
		expect(findingPass(context, "consequential-coverage")).toBe(true);
		expect(findingPass(context, "policy")).toBe(true);
		// The 2 October 2026 draft removed the origin-keyed agent cluster
		// precondition, so the audit must not grade it. A cluster finding in
		// either output would be a site owner being told they failed a
		// requirement that no longer exists.
		expect(scoreAudit(context).map((entry) => entry.check)).not.toContain(
			"cluster",
		);
		expect(countFailures(scoreAudit(context))).toBe(0);
	});

	it("flags a tool registered without an input schema", async () => {
		const context = await auditFixture("untyped");
		expect(findingPass(context, "typed")).toBe(false);
		expect(countFailures(scoreAudit(context))).toBeGreaterThan(0);
	});

	it("flags an inverted read-only and consequential annotation", async () => {
		const context = await auditFixture("inverted");
		expect(findingPass(context, "read-only-sanity")).toBe(false);
	});

	it("reports consequential coverage as a proportion of the real tool set", async () => {
		const context = await auditFixture("noConsequential");
		const coverage = scoreAudit(context).find(
			(entry) => entry.check === "consequential-coverage",
		);
		expect(coverage?.pass).toBe(false);
		expect(coverage?.detail).toBe("0/1 consequential annotated");
	});

	it("produces different findings for different fixture classes", async () => {
		const classes = [
			"empty",
			"clean",
			"untyped",
			"inverted",
			"noConsequential",
			"overBroad",
			"overlong",
			"forged",
		] as const;
		const signatures = new Map<string, string>();
		for (const name of classes) {
			const context = await auditFixture(name);
			signatures.set(
				name,
				scoreAudit(context)
					.map((entry) => `${entry.check}:${entry.pass ? "pass" : "fail"}`)
					.join("|"),
			);
		}
		// A collector that silently gathered nothing would give every fixture the
		// same signature, so this is the assertion that a real collection happened.
		const unique = new Set(signatures.values());
		expect(unique.size).toBeGreaterThanOrEqual(5);
		// The empty page and the fully annotated page must not score alike.
		expect(signatures.get("empty")).not.toBe(signatures.get("clean"));
		expect(signatures.get("untyped")).not.toBe(signatures.get("clean"));
		expect(signatures.get("inverted")).not.toBe(signatures.get("clean"));
	});

	it("scores a forged context on what it claims, not on trust", async () => {
		const context = await auditFixture("forged");
		const tools = context.tools;
		// The impostor's entries do reach the collector — it reads whatever the
		// document exposes. What must not happen is scoring them as trustworthy:
		// a string where a schema belongs is not a valid schema, and a wildcard
		// origin is not a narrow exposure.
		expect(tools.map((tool) => tool.name)).toEqual([
			"totallySafe",
			"wildClaim",
		]);
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		expect(byName.get("totallySafe")?.schemaValid).toBe(false);
		expect(byName.get("wildClaim")?.exposedOrigins).toEqual(["*"]);

		const findings = scoreAudit(context);
		const typed = findings.find(
			(entry) => entry.check === "typed" && entry.tool === "totallySafe",
		);
		expect(typed?.pass).toBe(false);
		const exposure = findings.find(
			(entry) => entry.check === "exposure" && entry.tool === "wildClaim",
		);
		expect(exposure?.pass).toBe(false);
		expect(exposure?.detail).toBe("exposure over-broad: wildcard");
		// The consequential claim is taken at face value for coverage only; it
		// is not a licence for the other findings to pass.
		expect(countFailures(findings)).toBeGreaterThan(0);
	});

	it("names its lane in the report it prints", async () => {
		const report = await auditLiveUrl(
			{ headless: true },
			`${server.origin}/clean`,
		);
		expect(report).toContain("audit");
		expect(report).toContain("viewCart");
		expect(report).not.toContain("readiness score");
	});

	it("changes its exit code with the findings", async () => {
		const clean = await auditFixture("clean");
		const untyped = await auditFixture("untyped");
		expect(exitCodeFor(clean)).toBe(0);
		expect(exitCodeFor(untyped)).toBe(2);
	});

	it("reports failing fixtures with a non-zero code through the driver", async () => {
		const { report, context } = await auditLiveUrlFindings(
			{ headless: true },
			`${server.origin}/untyped`,
		);
		expect(report).toContain("bareTool");
		// The name promises the code, so the code is what is asserted: a report
		// that named the failure while the command still exited 0 would pass a
		// text check and break the pipeline it exists for.
		expect(exitCodeFor(context)).toBe(2);
	});
});
