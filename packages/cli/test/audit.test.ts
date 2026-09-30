// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
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
			originKeyed: true,
		});
		expect(countFailures(good)).toBe(1);
		const bad = scoreAudit({
			tools: [tool({ hasInputSchema: false, schemaValid: false })],
			policyAllowsTools: true,
			originKeyed: true,
		});
		expect(countFailures(bad)).toBeGreaterThan(countFailures(good));
	});

	it("flags budget, exposure, policy, and cluster findings", () => {
		const findings = scoreAudit({
			tools: [
				tool({
					name: "x".repeat(BUDGETS.toolName + 1),
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
			originKeyed: false,
		});
		const byCheck = new Map(findings.map((entry) => [entry.check, entry]));
		expect(byCheck.get("naming-budget")?.pass).toBe(false);
		expect(byCheck.get("description-budget")?.pass).toBe(false);
		expect(byCheck.get("output-budget")?.pass).toBe(false);
		expect(byCheck.get("exposure")?.pass).toBe(false);
		expect(byCheck.get("read-only-sanity")?.pass).toBe(false);
		expect(byCheck.get("policy")?.pass).toBe(false);
		expect(byCheck.get("cluster")?.pass).toBe(false);
	});

	it("names its lane explicitly and never an unqualified score", () => {
		const text = auditSnapshot("https://shop.example", {
			tools: [tool()],
			policyAllowsTools: true,
			originKeyed: true,
		});
		expect(text).toContain(LANE_STATEMENT);
		expect(text).toContain("audit https://shop.example");
		expect(text).not.toContain("readiness score");
		expect(formatReport).toBeDefined();
	});

	it("drives the browser without sleeps", async () => {
		const calls: string[] = [];
		const text = await auditUrl(
			{
				async newPage() {
					return {
						async goto(url: string): Promise<void> {
							calls.push(url);
						},
						async evaluate<T>(fn: () => T): Promise<T> {
							return fn();
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
		const { collectContext } = await import("../src/audit.js");
		const over = scoreAudit({
			tools: [
				tool({ maxParamDescription: BUDGETS.paramDescription + 1 }),
				tool({ name: "wild", exposedOrigins: ["*"] }),
			],
			policyAllowsTools: true,
			originKeyed: true,
		});
		const byCheck = new Map(
			over.map((entry) => [`${entry.check}:${entry.tool}`, entry]),
		);
		expect(byCheck.get("param-description-budget:viewCart")?.pass).toBe(false);
		expect(byCheck.get("exposure:wild")?.pass).toBe(false);
		const empty = scoreAudit({
			tools: [],
			policyAllowsTools: true,
			originKeyed: true,
		});
		expect(
			empty.find((entry) => entry.check === "consequential-coverage")?.pass,
		).toBe(false);
		const calls: string[] = [];
		await collectContext({
			async goto(url: string): Promise<void> {
				calls.push(url);
			},
			async evaluate<T>(fn: () => T): Promise<T> {
				return fn();
			},
		});
		expect(calls).toHaveLength(0);
	});
});
