// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * The slice of the extension platform this package actually calls.
 *
 * Ours, not the platform's typings: installing a full ambient definition would
 * put a runtime-free but very large dependency in the tree, and this package
 * asserts a narrow surface on purpose. Anything not declared here is not used,
 * and a new call site has to add its shape here first — which is the review
 * point that matters for a Trusted-tier bridge.
 *
 * Every member is typed `unknown` where the value crosses a boundary, because
 * the platform does not type renderer-originated data for us either.
 */

interface AxInjectionTarget {
	tabId: number;
	frameIds?: number[];
}

interface AxScriptInjection {
	readonly result: unknown;
}

interface AxScripting {
	executeScript(injection: {
		target: AxInjectionTarget;
		world: "MAIN" | "ISOLATED";
		func: (...args: never[]) => unknown;
		args?: unknown[];
	}): Promise<AxScriptInjection[]>;
}

interface AxMessageSender {
	readonly id?: string;
}

interface AxRuntime {
	readonly id: string;
	/** Every value arriving from a message is untrusted until validated. */
	onMessage: {
		addListener(
			callback: (
				message: unknown,
				sender: AxMessageSender,
				sendResponse: (value: unknown) => void,
			) => boolean | undefined,
		): void;
	};
	sendMessage(message: unknown): Promise<unknown>;
}

interface AxTab {
	readonly id?: number;
	readonly url?: string;
	readonly pendingUrl?: string;
}

/**
 * The subset of `chrome.tabs.onUpdated` this worker reads.
 *
 * Only `status` is consumed, and only the transition to `"loading"`, which is
 * the signal that a tab began navigating a new document. It is delivered
 * without the `tabs` permission, so it costs nothing to request beyond the
 * host access the bridge already needs.
 */
interface AxTabsOnUpdated {
	addListener(
		callback: (tabId: number, changeInfo: { status?: unknown }) => void,
	): void;
}

interface AxTabs {
	query(info: Record<string, unknown>): Promise<AxTab[]>;
	onUpdated: AxTabsOnUpdated;
}

declare const chrome: {
	scripting: AxScripting;
	runtime: AxRuntime;
	tabs: AxTabs;
};
