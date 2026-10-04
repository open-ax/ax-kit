// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseAuditTarget } from "../src/args.js";
import { auditSnapshot, auditUrl } from "../src/audit.js";
import { formatReport, LANE_STATEMENT } from "../src/output.js";
import { BUDGETS, countFailures, scoreAudit } from "../src/scoring.js";

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
});
