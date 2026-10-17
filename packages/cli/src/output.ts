// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { AuditFinding, Enforcement } from "./scoring.js";
import {
	countFailures,
	countFailuresByEnforcement,
	enforcementOf,
} from "./scoring.js";

/**
 * Output envelope. Names its lane explicitly against edge and journey
 * scanners: edge sees discoverability, journey agents see behavior, this
 * audit sees the in-page contract. Never an unqualified readiness score.
 */

export const LANE_STATEMENT =
	"In-page contract audit: edge sees discoverability, journey agents see behavior, this audit sees the in-page contract." as const;

/**
 * What the two labels mean, printed once so that no reader has to guess.
 *
 * `enforced` is the honest claim: a failure there means an agent cannot do what
 * the page declared it could. `advisory` is a judgement about quality that
 * blocks nothing anywhere. The split is measured, not asserted — see
 * `docs/audit-vs-bridge.md` for the run that produced it.
 */
export const ENFORCEMENT_STATEMENT =
	"enforced = a failure stops an agent using the page as declared; advisory = quality only, blocks nothing. The exit code counts every finding, so it is not a verdict on what an agent can invoke." as const;

export interface AuditReport {
	readonly url: string;
	readonly lane: typeof LANE_STATEMENT;
	readonly failures: number;
	readonly enforcedFailures: number;
	readonly advisoryFailures: number;
	readonly total: number;
	readonly findings: ReadonlyArray<AuditFinding>;
}

/**
 * The label a finding claims, checked against the table it has to agree with.
 *
 * Findings arrive from outside this package, so a label is as hostile as any
 * other field. Accepting one that disagrees with `CHECK_ENFORCEMENT` would put
 * two different labels for the same check in the same report, which is the one
 * thing the labelling exists to prevent.
 */
function readEnforcement(check: string, value: unknown): Enforcement {
	if (value !== "advisory" && value !== "enforced") {
		throw new TypeError("bad finding enforcement");
	}
	if (value !== enforcementOf(check)) {
		throw new TypeError("bad finding enforcement");
	}
	return value;
}

export function createReport(url: unknown, findings: unknown): AuditReport {
	if (typeof url !== "string" || url.length === 0) {
		throw new TypeError("bad url");
	}
	if (!Array.isArray(findings)) {
		throw new TypeError("bad findings");
	}
	const clean: AuditFinding[] = [];
	for (const entry of findings) {
		if (typeof entry !== "object" || entry === null) {
			throw new TypeError("bad finding");
		}
		const record = entry as Record<string, unknown>;
		if (typeof record.check !== "string" || typeof record.detail !== "string") {
			throw new TypeError("bad finding");
		}
		if (typeof record.pass !== "boolean") {
			throw new TypeError("bad finding");
		}
		if (record.tool !== null && typeof record.tool !== "string") {
			throw new TypeError("bad finding");
		}
		clean.push({
			check: record.check,
			tool: record.tool as string | null,
			pass: record.pass,
			detail: record.detail,
			enforcement: readEnforcement(record.check, record.enforcement),
		});
	}
	const byEnforcement = countFailuresByEnforcement(clean);
	return {
		url,
		lane: LANE_STATEMENT,
		failures: countFailures(clean),
		enforcedFailures: byEnforcement.enforced,
		advisoryFailures: byEnforcement.advisory,
		total: clean.length,
		findings: clean,
	};
}

function sanitizeLine(value: string): string {
	return value.replace(/\p{Cc}/gu, "?").slice(0, 500);
}

export function formatReport(report: AuditReport): string {
	const lines: string[] = [];
	lines.push(`audit ${sanitizeLine(report.url)}`);
	lines.push(report.lane);
	lines.push(
		`${report.failures}/${report.total} failing (${report.enforcedFailures} enforced, ${report.advisoryFailures} advisory)`,
	);
	lines.push(ENFORCEMENT_STATEMENT);
	for (const finding of report.findings) {
		const target = finding.tool ?? "site";
		lines.push(
			`${finding.pass ? "pass" : "fail"} ${finding.enforcement} ${sanitizeLine(finding.check)} ${sanitizeLine(target)}: ${sanitizeLine(finding.detail)}`,
		);
	}
	return lines.join("\n");
}
