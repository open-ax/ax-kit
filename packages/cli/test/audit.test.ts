// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseAuditTarget } from "../src/args.js";
import { auditSnapshot, auditUrl } from "../src/audit.js";
import {
	createReport,
	ENFORCEMENT_STATEMENT,
	formatReport,
	LANE_STATEMENT,
} from "../src/output.js";
import type { AuditCheck } from "../src/scoring.js";
import {
	BUDGETS,
	CHECK_ENFORCEMENT,
	countFailures,
	enforcementOf,
	scoreAudit,
} from "../src/scoring.js";

function tool(overrides: Record<string, unknown> = {}) {
	return {
		name: "viewCart",
		description: "Show the cart.",
		hasInputSchema: true,
		schemaValid: true,
		consequentialHint: false,
		readOnlyHint: true,
		exposedOrigins: [],
		outputLength: 100,
		paramCount: 1,
		maxParamDescription: 40,
		...overrides,
	};
}

describe("cli audit", () => {
	it("scores typed versus untyped tools", () => {
		const good = scoreAudit({
			tools: [tool()],
			policyAllowsTools: true,
		});
		expect(countFailures(good)).toBe(1);
		const bad = scoreAudit({
			tools: [tool({ hasInputSchema: false, schemaValid: false })],
			policyAllowsTools: true,
		});
		expect(countFailures(bad)).toBeGreaterThan(countFailures(good));
	});

	it("flags budget, exposure, and policy findings", () => {
		const overName = "x".repeat(BUDGETS.toolName + 1);
		const findings = scoreAudit({
			tools: [
				tool({
					name: overName,
					description: "y".repeat(BUDGETS.toolDescription + 1),
					outputLength: BUDGETS.toolOutput + 1,
					exposedOrigins: [
						"https://a.example",
						"https://b.example",
						"https://c.example",
						"https://d.example",
					],
					consequentialHint: true,
					readOnlyHint: true,
				}),
			],
			policyAllowsTools: false,
		});
		const byCheck = new Map(
			findings.map((entry) => [
				`${entry.check}:${entry.tool ?? "site"}`,
				entry,
			]),
		);
		expect(byCheck.get(`naming-budget:${overName}`)?.pass).toBe(false);
		expect(byCheck.get(`description-budget:${overName}`)?.pass).toBe(false);
		expect(byCheck.get(`output-budget:${overName}`)?.pass).toBe(false);
		expect(byCheck.get(`exposure:${overName}`)?.pass).toBe(false);
		expect(byCheck.get(`read-only-sanity:${overName}`)?.pass).toBe(false);
		expect(byCheck.get("policy:site")?.pass).toBe(false);
	});

	it("names its lane explicitly and never an unqualified score", () => {
		const text = auditSnapshot("https://shop.example", {
			tools: [tool()],
			policyAllowsTools: true,
		});
		expect(text).toContain(LANE_STATEMENT);
		expect(text).toContain("audit https://shop.example");
		expect(text).not.toContain("readiness score");
		expect(formatReport).toBeDefined();
	});

	it("closes the browser and reports the lane through the injected browser", async () => {
		// Browser lifecycle stays covered here as a unit because it needs no
		// browser. Browser *behaviour* is covered against real Chromium in
		// browser-audit.test.ts; this fake cannot observe a page's tools, which
		// is exactly why the old version of this case was deleted rather than
		// repaired.
		const calls: string[] = [];
		const text = await auditUrl(
			{
				async newPage() {
					return {
						async goto(url: string): Promise<void> {
							calls.push(url);
						},
						async evaluate<T>(fn: () => T): Promise<Awaited<T>> {
							return await fn();
						},
					};
				},
				async close(): Promise<void> {
					calls.push("close");
				},
			},
			"https://shop.example",
		);
		expect(calls).toContain("https://shop.example");
		expect(calls).toContain("close");
		expect(text).toContain(LANE_STATEMENT);
		expect(calls.filter((call) => call === "about:blank")).toHaveLength(0);
	});

	it("scores param budgets, wildcard exposure, and empty coverage", async () => {
		const over = scoreAudit({
			tools: [
				tool({ maxParamDescription: BUDGETS.paramDescription + 1 }),
				tool({ name: "wild", exposedOrigins: ["*"] }),
			],
			policyAllowsTools: true,
		});
		const byCheck = new Map(
			over.map((entry) => [`${entry.check}:${entry.tool}`, entry]),
		);
		expect(byCheck.get("param-description-budget:viewCart")?.pass).toBe(false);
		expect(byCheck.get("exposure:wild")?.pass).toBe(false);
		const empty = scoreAudit({
			tools: [],
			policyAllowsTools: true,
		});
		expect(
			empty.find((entry) => entry.check === "consequential-coverage")?.pass,
		).toBe(false);
	});

	it("never navigates from inside the collector", async () => {
		// Navigation belongs to the caller. A collector that navigated would be
		// unable to answer "what did this page look like when I looked at it".
		const { collectContext } = await import("../src/audit.js");
		const calls: string[] = [];
		await collectContext({
			async goto(url: string): Promise<void> {
				calls.push(url);
			},
			async evaluate<T>(fn: () => T): Promise<Awaited<T>> {
				return await fn();
			},
		});
		expect(calls).toHaveLength(0);
	});

	it("parses the audit subcommand separately from its url", () => {
		expect(parseAuditTarget(["audit", "https://shop.example"])).toBe(
			"https://shop.example",
		);
		expect(() => parseAuditTarget(["audit"])).toThrow(TypeError);
		expect(() => parseAuditTarget([])).toThrow(TypeError);
		expect(() => parseAuditTarget(["https://shop.example"])).toThrow(TypeError);
		expect(() => parseAuditTarget(["audit", ""])).toThrow(TypeError);
		expect(() => parseAuditTarget(["audit", "--help"])).toThrow(TypeError);
		expect(() => parseAuditTarget(["audit", "not-a-url"])).toThrow(TypeError);
		expect(() =>
			parseAuditTarget(["audit", "https://shop.example", "extra"]),
		).toThrow(TypeError);
		expect(() =>
			parseAuditTarget(["audit", "https://shop.example"]),
		).not.toThrow();
	});

	it("rejects a snapshot whose shape the page chose rather than reported", async () => {
		// The page realm can subvert its own guards, so whatever comes back is
		// `unknown` until it has been checked field by field. Each of these is a
		// value a subverted page would have to return to steer the audit: a
		// non-array tool set, a coerced flag, or a tool whose field types are
		// wrong. Accepting any of them would let the audited page author its own
		// verdict, so each rejects instead of being coerced.
		const { collectContext } = await import("../src/audit.js");
		const hostile: ReadonlyArray<unknown> = [
			{ tools: {}, policyAllowsTools: true },
			{ tools: [], policyAllowsTools: "yes" },
			{ tools: [], policyAllowsTools: 1 },
			{ policyAllowsTools: true },
			{
				tools: [{ name: "viewCart" }],
				policyAllowsTools: true,
			},
			{
				tools: [{ ...tool(), exposedOrigins: "https://shop.example" }],
				policyAllowsTools: true,
			},
			{
				tools: [{ ...tool(), schemaValid: "true" }],
				policyAllowsTools: true,
			},
			{ tools: [null], policyAllowsTools: true },
			["not", "a", "snapshot"],
		];
		for (const snapshot of hostile) {
			await expect(
				collectContext({
					async goto(): Promise<void> {
						throw new Error("must not navigate");
					},
					async evaluate<T>(): Promise<Awaited<T>> {
						return snapshot as Awaited<T>;
					},
				}),
			).rejects.toThrow(TypeError);
		}
	});

	it("accepts a well-formed snapshot and carries its fields through", async () => {
		const { collectContext } = await import("../src/audit.js");
		const collected = await collectContext({
			async goto(): Promise<void> {
				throw new Error("must not navigate");
			},
			async evaluate<T>(): Promise<Awaited<T>> {
				return {
					tools: [tool({ title: "View cart" })],
					policyAllowsTools: false,
				} as Awaited<T>;
			},
		});
		expect(collected.policyAllowsTools).toBe(false);
		expect(collected.tools).toHaveLength(1);
		expect(collected.tools[0]?.title).toBe("View cart");
		expect(collected.tools[0]?.name).toBe("viewCart");
	});

	it("closes the browser when page creation fails", async () => {
		const closed: string[] = [];
		await expect(
			auditUrl(
				{
					async newPage() {
						throw new TypeError("no page");
					},
					async close(): Promise<void> {
						closed.push("close");
					},
				},
				"https://shop.example",
			),
		).rejects.toThrow(TypeError);
		expect(closed).toEqual(["close"]);
	});

	it("labels every check it produces as advisory or enforced", () => {
		// Acceptance 5, first half: the labels exist and the table is
		// exhaustive. A check that reached a reader unlabelled would leave the
		// exit code readable as a verdict, which is the thing this closes.
		const findings = scoreAudit({
			tools: [
				tool({
					name: "x".repeat(BUDGETS.toolName + 1),
					description: "y".repeat(BUDGETS.toolDescription + 1),
					hasInputSchema: false,
					schemaValid: false,
					consequentialHint: true,
					readOnlyHint: true,
					exposedOrigins: ["*"],
				}),
			],
			policyAllowsTools: false,
		});
		expect(findings.length).toBeGreaterThan(0);
		for (const entry of findings) {
			expect(["advisory", "enforced"]).toContain(entry.enforcement);
			// The label on the finding is the label in the table, not a copy
			// that can drift from it.
			expect(CHECK_ENFORCEMENT[entry.check as AuditCheck]).toBe(
				entry.enforcement,
			);
		}
		// Every check the scorer names is in the table. Without this, a check
		// added to the scorer and not to the table would still be counted as
		// labelled, because `enforcementOf` would have thrown — so this asserts
		// the other direction: no finding escapes with a label nobody chose.
		const named = new Set(findings.map((entry) => entry.check));
		for (const check of named) {
			expect(enforcementOf(check)).toBeDefined();
		}
	});

	it("separates enforced failures from advisory ones in the report", () => {
		// Acceptance 5, second half: a reader can see which is which without
		// counting. One enforced failure and one advisory failure on the same
		// page, because that is the case where the distinction decides whether
		// the page works.
		const findings = scoreAudit({
			tools: [
				tool({
					name: "x".repeat(BUDGETS.toolName + 1),
					hasInputSchema: false,
					schemaValid: false,
					// Annotated consequential, so page-level coverage passes and the
					// only failures left are the one enforced and the one advisory
					// this test is about.
					consequentialHint: true,
					readOnlyHint: false,
				}),
			],
			policyAllowsTools: true,
		});
		const report = createReport("https://shop.example", findings);
		expect(report.enforcedFailures).toBe(1);
		expect(report.advisoryFailures).toBe(1);
		expect(report.failures).toBe(2);

		const text = formatReport(report);
		expect(text).toContain("1 enforced, 1 advisory");
		expect(text).toContain("fail enforced typed");
		expect(text).toContain("fail advisory naming-budget");
		expect(text).toContain(ENFORCEMENT_STATEMENT);
		expect(text).toContain("not a verdict on what an agent can invoke");
	});

	it("rejects a finding whose label disagrees with the table", () => {
		// The labels arrive from outside this package with everything else, so
		// a mislabelled finding is as hostile as a coerced boolean. Accepting
		// one would print two different labels for the same check in one
		// report, which is the failure the labelling exists to prevent.
		const findings = scoreAudit({
			tools: [tool()],
			policyAllowsTools: true,
		});
		for (const entry of findings) {
			const flipped: Record<string, unknown> = {
				...entry,
				enforcement: entry.enforcement === "enforced" ? "advisory" : "enforced",
			};
			expect(() => createReport("https://shop.example", [flipped])).toThrow(
				TypeError,
			);
		}
		expect(() =>
			createReport("https://shop.example", [
				{ ...findings[0], enforcement: "yes" },
			]),
		).toThrow(TypeError);
		expect(() =>
			createReport("https://shop.example", [
				{ ...findings[0], enforcement: 1 },
			]),
		).toThrow(TypeError);
	});

	it("refuses to label a check the table does not carry", () => {
		expect(() => enforcementOf("cluster")).toThrow(TypeError);
		expect(() => enforcementOf("readiness")).toThrow(TypeError);
		// Inherited keys are not table entries. Indexing the table with these
		// returns a function rather than undefined, so without an own-property test
		// they would be labelled with whatever they inherited instead of refused.
		expect(() => enforcementOf("constructor")).toThrow(TypeError);
		expect(() => enforcementOf("toString")).toThrow(TypeError);
	});
});
