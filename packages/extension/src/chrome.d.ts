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

/**
 * The subset of a runtime port this worker uses.
 *
 * `onDisconnect` is load-bearing rather than defensive. Chrome never respawns a
 * native host, and the port dies whenever the worker does, so reconnection is
 * the documented pattern rather than something this code invents.
 */
interface AxRuntimePort {
	postMessage(message: unknown): void;
	disconnect(): void;
	onMessage: {
		addListener(callback: (message: unknown) => void): void;
	};
	onDisconnect: {
		addListener(callback: () => void): void;
	};
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
	connectNative(hostName: string): AxRuntimePort;
}

/** One tab, as far as the bridge needs to know about one. */
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

/**
 * The subset of `chrome.tabs.onActivated`.
 *
 * Only `tabId` is read. It is used to drop approvals belonging to a tab the
 * person has moved away from: switching tabs hides the side panel rather than
 * destroying it, so a card left standing is a card for a page nobody is
 * looking at any more.
 */
interface AxTabsOnActivated {
	addListener(callback: (info: { tabId?: unknown }) => void): void;
}

interface AxTabs {
	query(info: Record<string, unknown>): Promise<AxTab[]>;
	onUpdated: AxTabsOnUpdated;
	onActivated: AxTabsOnActivated;
}

/**
 * The `webNavigation` surface, which is where a real document identity comes
 * from.
 *
 * This exists because `chrome.tabs.Tab` has no `documentId` field — checked
 * against the API reference on 2026-10-14, not assumed. The only browser-asserted
 * document identities available are the ones `webNavigation` reports at commit
 * time, and the `getFrame` lookup that validates a set of ids against the live
 * document. That validation is what an approval binding is checked against, so
 * it has to come from the browser rather than from a comparison of strings this
 * package composes.
 */
interface AxNavigationDetails {
	readonly tabId?: unknown;
	readonly frameId?: unknown;
	readonly documentId?: unknown;
	/** Absent on a normal load; `"prerender"` on a prerendered document. */
	readonly documentLifecycle?: unknown;
}

interface AxWebNavigation {
	onCommitted: {
		addListener(callback: (details: AxNavigationDetails) => void): void;
	};
	/**
	 * Resolves with the frame only when the browser confirms that this tab,
	 * frame and document are the same live document. A null answer is the
	 * browser saying they are not, which is the anti-replay check.
	 */
	getFrame(details: {
		tabId: number;
		frameId: number;
		documentId: string;
	}): Promise<unknown>;
}

/** The side panel, as the confirmation surface is actually opened. */
interface AxSidePanel {
	setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
	setOptions(options: {
		tabId: number;
		path?: string;
		enabled?: boolean;
	}): Promise<void>;
}

/** The toolbar button, used only to say that a confirmation is waiting. */
interface AxAction {
	setBadgeText(details: { text: string }): Promise<void>;
	setBadgeBackgroundColor(details: { color: string }): Promise<void>;
	/** The banner a person reads on the icon before clicking it. */
	setTitle(details: { title: string }): Promise<void>;
}

declare const chrome: {
	scripting: AxScripting;
	runtime: AxRuntime;
	tabs: AxTabs;
	webNavigation: AxWebNavigation;
	sidePanel: AxSidePanel;
	action: AxAction;
};
