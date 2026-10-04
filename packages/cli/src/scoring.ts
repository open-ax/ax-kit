// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * In-page contract scoring: typed tools, schema validity, consequential
 * coverage, read-only sanity, exposure discipline, character budgets, and
 * feature-policy posture.
 *
 * Everything here is ours, not draft-derived beyond the budget figures
 * quoted from the platform guidance: the draft defines the page surface,
 * while this module grades how well one page uses it.
 */

export interface AuditToolInput {
	readonly name: string;
	readonly description: string;
	readonly title?: string | undefined;
	readonly hasInputSchema: boolean;
	readonly schemaValid: boolean;
	readonly consequentialHint: boolean;
	readonly readOnlyHint: boolean;
	readonly exposedOrigins: ReadonlyArray<string>;
	readonly outputLength: number;
	readonly paramCount: number;
	readonly maxParamDescription: number;
}

export interface AuditContextInput {
	readonly tools: ReadonlyArray<AuditToolInput>;
	readonly policyAllowsTools: boolean;
}

export interface AuditFinding {
	readonly check: string;
	readonly tool: string | null;
	readonly pass: boolean;
	readonly detail: string;
}

export const BUDGETS = {
	toolDescription: 500,
	paramDescription: 150,
	toolName: 30,
	toolOutput: 1536,
} as const;

function isValidOrigin(value: unknown): boolean {
	if (typeof value !== "string") {
		return false;
	}
	try {
		const parsed = new URL(value);
		return parsed.origin !== "null";
	} catch {
		return false;
	}
}

function readTools(value: unknown): ReadonlyArray<AuditToolInput> {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("bad audit input");
	}
	const record = value as Record<string, unknown>;
	const tools = record.tools;
	if (!Array.isArray(tools)) {
		throw new TypeError("bad tools");
	}
	const clean: AuditToolInput[] = [];
	for (const entry of tools) {
		if (typeof entry !== "object" || entry === null) {
			throw new TypeError("bad tool");
		}
		const tool = entry as Record<string, unknown>;
		if (typeof tool.name !== "string" || typeof tool.description !== "string") {
			throw new TypeError("bad tool");
		}
		if (
			typeof tool.hasInputSchema !== "boolean" ||
			typeof tool.schemaValid !== "boolean" ||
			typeof tool.consequentialHint !== "boolean" ||
			typeof tool.readOnlyHint !== "boolean"
		) {
			throw new TypeError("bad tool flags");
		}
		if (!Array.isArray(tool.exposedOrigins)) {
			throw new TypeError("bad tool");
		}
		for (const origin of tool.exposedOrigins) {
			if (typeof origin !== "string") {
				throw new TypeError("bad tool");
			}
		}
		if (
			typeof tool.outputLength !== "number" ||
			!Number.isFinite(tool.outputLength) ||
			tool.outputLength < 0
		) {
			throw new TypeError("bad tool");
		}
		if (
			typeof tool.paramCount !== "number" ||
			!Number.isInteger(tool.paramCount) ||
			tool.paramCount < 0
		) {
			throw new TypeError("bad tool");
		}
		if (
			typeof tool.maxParamDescription !== "number" ||
			!Number.isFinite(tool.maxParamDescription) ||
			tool.maxParamDescription < 0
		) {
			throw new TypeError("bad tool");
		}
		const title: unknown = tool.title;
		if (title !== undefined && typeof title !== "string") {
			throw new TypeError("bad tool");
		}
		clean.push({
			name: tool.name,
			description: tool.description,
			title: typeof title === "string" ? title : undefined,
			hasInputSchema: tool.hasInputSchema,
			schemaValid: tool.schemaValid,
			consequentialHint: tool.consequentialHint,
			readOnlyHint: tool.readOnlyHint,
			exposedOrigins: [...(tool.exposedOrigins as string[])],
			outputLength: tool.outputLength,
			paramCount: tool.paramCount,
			maxParamDescription: tool.maxParamDescription,
		});
	}
	return clean;
}

function readContext(context: unknown): {
	tools: ReadonlyArray<AuditToolInput>;
	policyAllowsTools: boolean;
} {
	const tools = readTools(context);
	const record = context as Record<string, unknown>;
	const policyAllowsTools = record.policyAllowsTools;
	if (typeof policyAllowsTools !== "boolean") {
		throw new TypeError("bad audit context");
	}
	return { tools, policyAllowsTools };
}

/** Score one audited URL snapshot. Deterministic and side-effect free. */
export function scoreAudit(context: unknown): AuditFinding[] {
	const { tools, policyAllowsTools } = readContext(context);
	const findings: AuditFinding[] = [];
	for (const tool of tools) {
		findings.push({
			check: "typed",
			tool: tool.name,
			pass: tool.hasInputSchema && tool.schemaValid,
			detail:
				tool.hasInputSchema && tool.schemaValid
					? "input schema present and valid"
					: "missing or invalid input schema",
		});
		findings.push({
			check: "naming-budget",
			tool: tool.name,
			pass: tool.name.length <= BUDGETS.toolName,
			detail: `name ${tool.name.length}/${BUDGETS.toolName}`,
		});
		findings.push({
			check: "description-budget",
			tool: tool.name,
			pass: tool.description.length <= BUDGETS.toolDescription,
			detail: `description ${tool.description.length}/${BUDGETS.toolDescription}`,
		});
		findings.push({
			check: "param-description-budget",
			tool: tool.name,
			pass: tool.maxParamDescription <= BUDGETS.paramDescription,
			detail: `max param description ${tool.maxParamDescription}/${BUDGETS.paramDescription}`,
		});
		findings.push({
			check: "output-budget",
			tool: tool.name,
			pass: tool.outputLength <= BUDGETS.toolOutput,
			detail: `output ${tool.outputLength}/${BUDGETS.toolOutput}`,
		});
		const hasWildcard = tool.exposedOrigins.some(
			(origin) => origin === "*" || origin === "<all_urls>",
		);
		const allValid = tool.exposedOrigins.every(isValidOrigin);
		// Heuristic budget (not spec): narrow means valid origins, no
		// wildcards, and at most three entries. Discipline first, count second.
		const narrow = !hasWildcard && allValid && tool.exposedOrigins.length <= 3;
		findings.push({
			check: "exposure",
			tool: tool.name,
			pass: narrow,
			detail: hasWildcard
				? "exposure over-broad: wildcard"
				: !allValid
					? "exposure has invalid origin"
					: tool.exposedOrigins.length <= 3
						? "exposure narrow"
						: "exposure over-broad",
		});
		if (tool.consequentialHint) {
			findings.push({
				check: "consequential-annotated",
				tool: tool.name,
				pass: true,
				detail: "consequential tool annotated",
			});
		}
		if (tool.readOnlyHint && tool.consequentialHint) {
			findings.push({
				check: "read-only-sanity",
				tool: tool.name,
				pass: false,
				detail: "read-only and consequential together is inverted",
			});
		} else {
			findings.push({
				check: "read-only-sanity",
				tool: tool.name,
				pass: true,
				detail: "read-only flag sane",
			});
		}
	}
	const consequentialTotal = tools.filter(
		(tool) => tool.consequentialHint,
	).length;
	findings.push({
		check: "consequential-coverage",
		tool: null,
		pass: consequentialTotal > 0,
		detail:
			tools.length === 0
				? "no tools to annotate"
				: `${consequentialTotal}/${tools.length} consequential annotated`,
	});
	findings.push({
		check: "policy",
		tool: null,
		pass: policyAllowsTools,
		detail: policyAllowsTools
			? "feature policy allows tools"
			: "tools denied by policy",
	});
	return findings;
}

/** Count failures in a finding set. */
export function countFailures(findings: ReadonlyArray<AuditFinding>): number {
	return findings.filter((finding) => !finding.pass).length;
}
