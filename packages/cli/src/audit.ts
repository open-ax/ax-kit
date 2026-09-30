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
	evaluate<T>(fn: () => T): Promise<Awaited<T>>;
};

export type BrowserLike = {
	newPage(): Promise<BrowserPageLike>;
	close(): Promise<void>;
};

/**
 * Collect the audit context inside the page. Never navigates: the caller
 * owns navigation. Every page function is self-contained with no closed-over
 * state; only serializable data crosses the boundary.
 *
 * Fail-closed: the page realm is hostile and may subvert in-page guards
 * (for example poisoned `Array.isArray` or `Object.entries`), so shaped
 * values are revalidated Node-side by `scoreAudit`. Malformed tool data
 * throws instead of scoring the remaining tools; no filtering or
 * normalization is applied before scoring.
 */
export async function collectContext(
	page: BrowserPageLike,
): Promise<AuditContextInput> {
	const evaluated = await page.evaluate((): unknown => {
		const doc = (typeof document === "undefined"
			? undefined
			: document) as unknown as Record<string, unknown> | undefined;
		if (doc === undefined) {
			return { tools: [], policyAllowsTools: true, originKeyed: true };
		}
		let policyAllowsTools = true;
		try {
			const policy = doc.permissionsPolicy as
				| {
						allowsFeature?: unknown;
						features?: unknown;
				  }
				| undefined;
			if (
				typeof policy === "object" &&
				policy !== null &&
				typeof policy.allowsFeature === "function"
			) {
				let knownIncludesTools = false;
				const known = policy.features;
				if (typeof known === "function") {
					try {
						const names = (known as () => unknown).call(policy);
						if (Array.isArray(names)) {
							knownIncludesTools = names.includes("tools");
						}
					} catch {
						knownIncludesTools = false;
					}
				}
				if (knownIncludesTools) {
					policyAllowsTools =
						(policy.allowsFeature as (feature: string) => unknown).call(
							policy,
							"tools",
						) !== false;
				}
			}
		} catch {
			policyAllowsTools = true;
		}
		let originKeyed = true;
		try {
			const location = doc.location as
				| { protocol?: unknown; hostname?: unknown }
				| undefined;
			const protocol =
				typeof location?.protocol === "string" ? location.protocol : "";
			const hostname =
				typeof location?.hostname === "string" ? location.hostname : "";
			if (protocol === "file:") {
				originKeyed = true;
			} else if (hostname === "") {
				originKeyed = true;
			} else {
				try {
					const domain = doc.domain as unknown;
					originKeyed = typeof domain !== "string" || domain === hostname;
				} catch {
					originKeyed = false;
				}
			}
		} catch {
			originKeyed = true;
		}
		const holder = doc;
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
			return { tools: [], policyAllowsTools, originKeyed };
		}
		const pending: unknown = (
			surface.getTools as (...args: unknown[]) => unknown
		).call(surface);
		const isThenable =
			typeof pending === "object" &&
			pending !== null &&
			typeof (pending as { then?: unknown }).then === "function";
		const finish = (listed: unknown): unknown => {
			if (!Array.isArray(listed)) {
				return { tools: [], policyAllowsTools, originKeyed };
			}
			const tools: Record<string, unknown>[] = [];
			for (const entry of listed) {
				if (typeof entry !== "object" || entry === null) {
					continue;
				}
				const record = entry as Record<string, unknown>;
				const inputSchema: unknown = (record as { inputSchema?: unknown })
					.inputSchema;
				const hasInputSchema = inputSchema !== undefined;
				const schemaValid =
					typeof inputSchema === "object" &&
					inputSchema !== null &&
					!Array.isArray(inputSchema) &&
					(inputSchema as Record<string, unknown>).type === "object";
				const annotations = record.annotations as
					| Record<string, unknown>
					| undefined;
				const consequentialHint =
					(record.consequentialHint === true ||
						(typeof annotations === "object" &&
							annotations !== null &&
							annotations.consequentialHint === true)) === true;
				const readOnlyHint =
					(record.readOnlyHint === true ||
						(typeof annotations === "object" &&
							annotations !== null &&
							annotations.readOnlyHint === true)) === true;
				let paramCount = 0;
				let maxParamDescription = 0;
				if (
					typeof inputSchema === "object" &&
					inputSchema !== null &&
					!Array.isArray(inputSchema)
				) {
					const properties = (inputSchema as Record<string, unknown>)
						.properties;
					if (
						typeof properties === "object" &&
						properties !== null &&
						!Array.isArray(properties)
					) {
						const entries = Object.entries(
							properties as Record<string, unknown>,
						);
						paramCount = entries.length;
						for (const [, prop] of entries) {
							if (
								typeof prop === "object" &&
								prop !== null &&
								!Array.isArray(prop)
							) {
								const description = (prop as Record<string, unknown>)
									.description;
								if (typeof description === "string") {
									if (description.length > maxParamDescription) {
										maxParamDescription = description.length;
									}
								}
							}
						}
					}
				}
				const rawLength = (record as { outputLength?: unknown }).outputLength;
				const outputLength =
					typeof rawLength === "number" &&
					Number.isFinite(rawLength) &&
					rawLength >= 0
						? rawLength
						: 0;
				tools.push({
					name: typeof record.name === "string" ? record.name : "unknown",
					description:
						typeof record.description === "string" ? record.description : "",
					hasInputSchema,
					schemaValid,
					consequentialHint,
					readOnlyHint,
					exposedOrigins: Array.isArray(record.exposedOrigins)
						? record.exposedOrigins.filter(
								(origin): origin is string => typeof origin === "string",
							)
						: [],
					outputLength,
					paramCount,
					maxParamDescription,
				});
			}
			return { tools, policyAllowsTools, originKeyed };
		};
		if (isThenable) {
			return (pending as Promise<unknown>).then(finish, () => ({
				tools: [],
				policyAllowsTools,
				originKeyed,
			}));
		}
		try {
			return finish(pending);
		} catch {
			return { tools: [], policyAllowsTools, originKeyed };
		}
	});
	const raw: unknown =
		typeof evaluated === "object" &&
		evaluated !== null &&
		typeof (evaluated as { then?: unknown }).then === "function"
			? await (evaluated as Promise<unknown>)
			: evaluated;
	if (typeof raw !== "object" || raw === null) {
		throw new TypeError("bad audit context");
	}
	return raw as AuditContextInput;
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
