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
 *
 * Each check also carries an enforcement label, and the table below is the
 * whole of it. A check is `enforced` when its failure means an agent cannot
 * do what the page declared it could; it is `advisory` when the failure is a
 * quality judgement that blocks nothing. The split was not chosen by reading
 * either tool: it is what `test/audit-vs-bridge.test.ts` measured when it ran
 * this audit and the shipped bridge against the same pages in the same
 * browser session. `docs/audit-vs-bridge.md` is the record, including the one
 * check that turns out to be reading a field nothing reports.
 */

/**
 * Whether a failing check blocks an agent or only advises.
 *
 * Ours, not the draft's: the draft defines the page surface and says nothing
 * about how a third party grades it.
 */
export type Enforcement = "advisory" | "enforced";

/**
 * Every check name this module can produce.
 *
 * Ours. Written out rather than derived from the table below so that the table
 * can be typed as exhaustive: a check added in one place and not the other is a
 * compile error, not a finding that reaches a reader unlabelled.
 */
export type AuditCheck =
	| "typed"
	| "naming-budget"
	| "description-budget"
	| "param-description-budget"
	| "output-budget"
	| "exposure"
	| "consequential-annotated"
	| "read-only-sanity"
	| "consequential-coverage"
	| "policy";

/**
 * The enforcement of every check this module can produce.
 *
 * A closed table rather than a field written at each call site, because the
 * interesting property is that it can be read in one place and argued with as
 * one place.
 */
export const CHECK_ENFORCEMENT: Readonly<Record<AuditCheck, Enforcement>> = {
	// Measured: with no valid schema the page declares no argument contract,
	// and the bridge derives its allow-list from that schema's properties — so
	// a tool with none is listed and run, but every argument is minimised away
	// before it arrives. The tool exists and does nothing a caller asked for.
	typed: "enforced",
	// Measured: the bridge reads `consequentialHint` off the same annotation
	// this check reads, and decides from it whether a person is asked first. A
	// pair that claims both read-only and consequential is a page asserting
	// something about its own consequence that the bridge will act on.
	"read-only-sanity": "enforced",
	// The platform's own gate. When it denies, the core never installs a
	// context and no agent sees any tool at all.
	policy: "enforced",

	// Measured: the bridge's boundary check requires a non-empty description
	// and says nothing about its length, the tool's name beyond the
	// registration pattern, or the size of anything. These are platform
	// guidance quoted as numbers, and nothing enforces them anywhere.
	"naming-budget": "advisory",
	"description-budget": "advisory",
	"param-description-budget": "advisory",
	"output-budget": "advisory",
	// Measured: the bridge admits the page's own origin and nothing else, so a
	// wider declaration is not a wider exposure. And the shipped core's
	// registered-tool listing carries no declared-origin set, so this check
	// cannot fail on a page that installed it — see `docs/audit-vs-bridge.md`.
	exposure: "advisory",
	// Measured: this is a score over the page, not a property of any tool. A
	// page can fail it and have every one of its tools fully invokable.
	"consequential-coverage": "advisory",
	// Present only when the page already annotated the tool consequential, and
	// reports success. It cannot fail, so it cannot block.
	"consequential-annotated": "advisory",
};

/** The enforcement of one check, refusing a name the table does not carry. */
export function enforcementOf(check: string): Enforcement {
	const found = CHECK_ENFORCEMENT[check as AuditCheck];
	if (found === undefined) {
		throw new TypeError(`unknown audit check: ${check}`);
	}
	return found;
}

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
	/**
	 * Whether this check blocks an agent or only advises. Carried on the
	 * finding rather than looked up when printing so that a report cannot be
	 * formatted against a classification the findings disagree with.
	 */
	readonly enforcement: Enforcement;
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

/**
 * One finding, stamped with its enforcement.
 *
 * The stamp is looked up rather than written at each call site so that the
 * table above is load-bearing: a check the table forgot would throw here
 * rather than reach a reader unlabelled.
 */
function finding(
	check: AuditCheck,
	tool: string | null,
	pass: boolean,
	detail: string,
): AuditFinding {
	return {
		check,
		tool,
		pass,
		detail,
		enforcement: enforcementOf(check),
	};
}

/** Score one audited URL snapshot. Deterministic and side-effect free. */
export function scoreAudit(context: unknown): AuditFinding[] {
	const { tools, policyAllowsTools } = readContext(context);
	const findings: AuditFinding[] = [];
	for (const tool of tools) {
		findings.push(
			finding(
				"typed",
				tool.name,
				tool.hasInputSchema && tool.schemaValid,
				tool.hasInputSchema && tool.schemaValid
					? "input schema present and valid"
					: "missing or invalid input schema",
			),
		);
		findings.push(
			finding(
				"naming-budget",
				tool.name,
				tool.name.length <= BUDGETS.toolName,
				`name ${tool.name.length}/${BUDGETS.toolName}`,
			),
		);
		findings.push(
			finding(
				"description-budget",
				tool.name,
				tool.description.length <= BUDGETS.toolDescription,
				`description ${tool.description.length}/${BUDGETS.toolDescription}`,
			),
		);
		findings.push(
			finding(
				"param-description-budget",
				tool.name,
				tool.maxParamDescription <= BUDGETS.paramDescription,
				`max param description ${tool.maxParamDescription}/${BUDGETS.paramDescription}`,
			),
		);
		findings.push(
			finding(
				"output-budget",
				tool.name,
				tool.outputLength <= BUDGETS.toolOutput,
				`output ${tool.outputLength}/${BUDGETS.toolOutput}`,
			),
		);
		const hasWildcard = tool.exposedOrigins.some(
			(origin) => origin === "*" || origin === "<all_urls>",
		);
		const allValid = tool.exposedOrigins.every(isValidOrigin);
		// Heuristic budget (not spec): narrow means valid origins, no
		// wildcards, and at most three entries. Discipline first, count second.
		const narrow = !hasWildcard && allValid && tool.exposedOrigins.length <= 3;
		findings.push(
			finding(
				"exposure",
				tool.name,
				narrow,
				hasWildcard
					? "exposure over-broad: wildcard"
					: !allValid
						? "exposure has invalid origin"
						: tool.exposedOrigins.length <= 3
							? "exposure narrow"
							: "exposure over-broad",
			),
		);
		if (tool.consequentialHint) {
			findings.push(
				finding(
					"consequential-annotated",
					tool.name,
					true,
					"consequential tool annotated",
				),
			);
		}
		if (tool.readOnlyHint && tool.consequentialHint) {
			findings.push(
				finding(
					"read-only-sanity",
					tool.name,
					false,
					"read-only and consequential together is inverted",
				),
			);
		} else {
			findings.push(
				finding("read-only-sanity", tool.name, true, "read-only flag sane"),
			);
		}
	}
	const consequentialTotal = tools.filter(
		(tool) => tool.consequentialHint,
	).length;
	findings.push(
		finding(
			"consequential-coverage",
			null,
			consequentialTotal > 0,
			tools.length === 0
				? "no tools to annotate"
				: `${consequentialTotal}/${tools.length} consequential annotated`,
		),
	);
	findings.push(
		finding(
			"policy",
			null,
			policyAllowsTools,
			policyAllowsTools
				? "feature policy allows tools"
				: "tools denied by policy",
		),
	);
	return findings;
}

/** Count failures in a finding set. */
export function countFailures(findings: ReadonlyArray<AuditFinding>): number {
	return findings.filter((finding) => !finding.pass).length;
}

/** How many failures of each enforcement a finding set carries. */
export function countFailuresByEnforcement(
	findings: ReadonlyArray<AuditFinding>,
): { enforced: number; advisory: number } {
	let enforced = 0;
	let advisory = 0;
	for (const entry of findings) {
		if (entry.pass) {
			continue;
		}
		if (entry.enforcement === "enforced") {
			enforced += 1;
		} else {
			advisory += 1;
		}
	}
	return { enforced, advisory };
}
