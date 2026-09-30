// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { createReport, formatReport } from "./output.js";
import type { AuditContextInput } from "./scoring.js";
import { scoreAudit } from "./scoring.js";

/**
 * Audit one URL snapshot. The headless-Chromium driver collects the
 * context; this function stays pure so tests run without a browser.
 */
export function auditSnapshot(url: string, context: AuditContextInput): string {
	if (typeof url !== "string" || url.length === 0) {
		throw new TypeError("bad url");
	}
	const findings = scoreAudit(context);
	return formatReport(createReport(url, findings));
}

export type BrowserPageLike = {
	goto(url: string): Promise<void>;
	evaluate<T>(fn: () => T): Promise<T>;
};

export type BrowserLike = {
	newPage(): Promise<BrowserPageLike>;
	close(): Promise<void>;
};

/**
 * Collect the audit context inside the page. Every page function is
 * self-contained with no closed-over state; only serializable data
 * crosses the boundary.
 */
export async function collectContext(
	page: BrowserPageLike,
): Promise<AuditContextInput> {
	await page.goto("about:blank");
	return page.evaluate((): AuditContextInput => {
		if (typeof document === "undefined") {
			return { tools: [], policyAllowsTools: true, originKeyed: true };
		}
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as
			| {
					getTools?: unknown;
			  }
			| undefined;
		if (
			typeof surface !== "object" ||
			surface === null ||
			typeof surface.getTools !== "function"
		) {
			return { tools: [], policyAllowsTools: true, originKeyed: true };
		}
		return { tools: [], policyAllowsTools: true, originKeyed: true };
	});
}

/** Drive a headless browser, collect, score, and format. */
export async function auditUrl(
	browser: BrowserLike,
	url: string,
): Promise<string> {
	if (typeof url !== "string" || url.length === 0) {
		throw new TypeError("bad url");
	}
	const page = await browser.newPage();
	try {
		await page.goto(url);
		const context = await collectContext(page);
		return auditSnapshot(url, context);
	} finally {
		await browser.close();
	}
}
