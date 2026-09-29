// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { listToolSummaries } from "./listing.js";
import { findToolByName } from "./match.js";
import type { AxExpectOptions, AxToolSummary, AxWaitOptions } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5_000;

function readTimeout(options: AxWaitOptions | AxExpectOptions): number {
	const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
	if (
		typeof timeout !== "number" ||
		Number.isNaN(timeout) ||
		!Number.isFinite(timeout) ||
		timeout < 0
	) {
		throw new TypeError("bad timeout");
	}
	return timeout;
}

function timeoutError(name: string, timeout: number): Error {
	const error = new Error(
		`timed out waiting for tool "${name}" (${timeout}ms)`,
	);
	error.name = "TimeoutError";
	return error;
}

/**
 * Event-driven wait: pre-flight listing first so an already-registered tool
 * resolves without attaching a listener, otherwise a one-shot in-page
 * change hint racing an in-page guard, re-listing on every wake and
 * matching by name in code-unit order until the deadline.
 */
export async function waitForTool(
	page: Page,
	name: string,
	options?: AxWaitOptions,
): Promise<AxToolSummary> {
	if (typeof name !== "string") {
		throw new TypeError("bad tool name");
	}
	const timeout = readTimeout(options ?? {});
	const deadline = Date.now() + timeout;
	const preflight = findToolByName(await listToolSummaries(page), name);
	if (preflight !== undefined) {
		return preflight;
	}
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw timeoutError(name, timeout);
		}
		// Attach, re-check, then wait in one evaluate so a registration
		// landing between the pre-flight and this attach is still seen.
		try {
			await page.evaluate(
				(arg: unknown): Promise<{ found: boolean }> => {
					const payload = arg as { ms: unknown; name: unknown };
					const ms = typeof payload.ms === "number" ? payload.ms : 0;
					const wanted = typeof payload.name === "string" ? payload.name : "";
					const holder = document as unknown as Record<string, unknown>;
					const raw = holder.modelContext as unknown;
					if (typeof raw !== "object" || raw === null) {
						throw new Error("typed surface is missing");
					}
					const target = raw as EventTarget;
					if (
						typeof target.addEventListener !== "function" ||
						typeof target.removeEventListener !== "function"
					) {
						throw new Error("typed surface is missing");
					}
					const getTools = (raw as Record<string, unknown>).getTools;
					if (typeof getTools !== "function") {
						throw new Error("typed surface is missing");
					}
					const list = getTools as () => Promise<
						Array<Record<string, unknown>>
					>;
					return new Promise<{ found: boolean }>((resolve, reject) => {
						const timer = setTimeout(() => {
							target.removeEventListener("toolchange", onChange);
							reject(new Error("wait guard expired"));
						}, ms);
						function onChange(): void {
							clearTimeout(timer);
							resolve({ found: false });
						}
						target.addEventListener("toolchange", onChange, {
							once: true,
						});
						void list
							.call(target)
							.then((tools) => {
								if (
									tools.some(
										(tool) =>
											typeof tool.name === "string" &&
											(tool.name as string) === wanted,
									)
								) {
									clearTimeout(timer);
									target.removeEventListener("toolchange", onChange);
									resolve({ found: true });
								}
							})
							.catch(() => undefined);
					});
				},
				{ ms: remaining, name },
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes("wait guard expired")
			) {
				throw timeoutError(name, timeout);
			}
			throw error;
		}
		const current = findToolByName(await listToolSummaries(page), name);
		if (current !== undefined) {
			return current;
		}
	}
}

/**
 * Assertion flavor over the same listing and matcher, built on the
 * runner's retrying poll with forwarded timeout options.
 */
export async function expectTool(
	page: Page,
	name: string,
	options?: AxExpectOptions,
): Promise<AxToolSummary> {
	if (typeof name !== "string") {
		throw new TypeError("bad tool name");
	}
	const timeout = readTimeout(options ?? {});
	await listToolSummaries(page);
	await expect
		.poll(
			async (): Promise<string | null> => {
				const tools = await listToolSummaries(page);
				return findToolByName(tools, name)?.name ?? null;
			},
			{ timeout },
		)
		.toBe(name);
	const current = findToolByName(await listToolSummaries(page), name);
	if (current === undefined) {
		throw timeoutError(name, timeout);
	}
	return current;
}
