// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * The provider that stands between the protocol layer and the bridge.
 *
 * Everything here is ours, not draft-derived. The draft defines the page
 * surface; this is how the client protocol reaches a page through a browser.
 *
 * It exists because the two sides disagree about what a call can fail at, and
 * that disagreement has to be resolved in exactly one place. `PageBridge` throws
 * `BridgeRefusal` because it is a transport, and refusals are exceptional at
 * that layer. MCP wants refusals *inside* the result so a client can see them.
 * This module is the only place that translation happens, so neither the
 * protocol module nor the bridge has to learn the other's convention.
 */

import { BRIDGE_ERRORS, type PageBridge } from "./bridge.js";
import type { BridgeProvider, ToolOutcome } from "./outcome.js";
import { readToolOutcome, refusalFrom } from "./outcome.js";

export { BRIDGE_ERRORS, PageBridge } from "./bridge.js";

/** Carried on a call to a page with nothing behind it. */
const NO_CLIENT = -32013;

/**
 * Serve MCP from a page bridge.
 *
 * The tab is resolved per request rather than cached. A client has no concept of
 * a tab, so "which one" has to be answered by asking the browser at the moment
 * of the call — a cached answer would point at whatever was in front of the
 * person a minute ago, which for a consequential tool is exactly the wrong tab
 * to be asking about.
 */
export class PageBridgeProvider implements BridgeProvider {
	constructor(private readonly bridge: PageBridge) {}

	async listTools(): Promise<ReadonlyArray<Record<string, unknown>>> {
		if (!this.bridge.clientAttached()) {
			return [];
		}
		const tab = await this.tab();
		if (tab === null) {
			return [];
		}
		return await this.bridge.listTools(tab.tabId);
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<ToolOutcome> {
		if (!this.bridge.clientAttached()) {
			return {
				kind: "refused",
				code: NO_CLIENT,
				message:
					"no extension is attached: open a page in a browser with the ax-kit extension loaded",
			};
		}
		const tab = await this.tab();
		if (tab === null) {
			return {
				kind: "refused",
				code: NO_CLIENT,
				message: "no tab is available to invoke a tool in",
			};
		}
		try {
			// The page's own origin, because that is what a caller acting on that
			// page carries, and a page is exposed to itself by default. The
			// Trusted tier still decides: this process naming an origin is a claim
			// it makes about where the work happens, not a privilege it grants.
			const reply = await this.bridge.callTool(
				name,
				args,
				tab.tabId,
				tab.origin,
			);
			return readToolOutcome(reply);
		} catch (error: unknown) {
			return refusalFrom(error, BRIDGE_ERRORS.badRequest);
		}
	}

	/** The active tab, or null when the worker could not name one. */
	private async tab(): Promise<{ tabId: number; origin: string } | null> {
		try {
			return await this.bridge.activeTab();
		} catch {
			// No tab, or the worker went away between the attachment check and
			// the question. Both are the same answer for a caller: nothing here.
			return null;
		}
	}
}
