// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { AuditFinding } from "./scoring.js";
import { countFailures } from "./scoring.js";

/**
 * Output envelope. Names its lane explicitly against edge and journey
 * scanners: edge sees discoverability, journey agents see behavior, this
 * audit sees the in-page contract. Never an unqualified readiness score.
 */

export const LANE_STATEMENT =
	"In-page contract audit: edge sees discoverability, journey agents see behavior, this audit sees the in-page contract." as const;

export interface AuditReport {
	readonly url: string;
	readonly lane: typeof LANE_STATEMENT;
	readonly failures: number;
	readonly total: number;
	readonly findings: ReadonlyArray<AuditFinding>;
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
		});
	}
	return {
		url,
		lane: LANE_STATEMENT,
		failures: countFailures(clean),
		total: clean.length,
		findings: clean,
	};
}

function sanitizeLine(value: string): string {
	return value.replace(/[\r\n\x1b]/g, "?").slice(0, 500);
}

export function formatReport(report: AuditReport): string {
	const lines: string[] = [];
	lines.push(`audit ${sanitizeLine(report.url)}`);
	lines.push(report.lane);
	lines.push(`${report.failures}/${report.total} failing`);
	for (const finding of report.findings) {
		const target = finding.tool ?? "site";
		lines.push(
			`${finding.pass ? "pass" : "fail"} ${sanitizeLine(finding.check)} ${sanitizeLine(target)}: ${sanitizeLine(finding.detail)}`,
		);
	}
	return lines.join("\n");
}
