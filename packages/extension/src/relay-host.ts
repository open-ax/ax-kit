// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiring the relay into the worker's lifetime.
 *
 * Everything here is ours, not draft-derived. The draft defines the page
 * surface; this is transport.
 *
 * The loop itself is in `relay.ts`. This file owns the part that is about
 * *when*: connecting at start, reconnecting when the native port drops, and
 * reporting what the bridge is doing so the panel can say something true.
 *
 * **Reconnection is the whole design.** Chrome never respawns a native host —
 * when the port closes, the host process is gone and nothing will bring it
 * back. So the connection is established at top level, which runs again every
 * time the browser revives this worker for any reason at all, and again from
 * `onDisconnect`. Neither path is a retry loop: each is a single connect, and
 * the browser deciding to wake the worker is the backoff.
 */

import {
	NATIVE_HOST_NAME,
	type RelayHandler,
	type RelayStop,
	readAttachment,
	readRefusal,
	serveRelay,
} from "./relay.js";

export type RelayStatus = "starting" | "attached" | "detached" | "no-daemon";

/** What the panel shows about the bridge itself. Read-only to a panel. */
export interface RelayState {
	readonly status: RelayStatus;
	readonly reason: string;
}

export interface RelayHandle {
	readonly state: RelayState;
}

/**
 * Start the relay and keep it started.
 *
 * `dispatch` is passed in rather than imported so this module knows nothing
 * about injection, approvals or pages. The only thing it needs to know is that
 * some other module knows how to run one named request.
 */
export function startRelay(dispatch: RelayHandler): RelayHandle {
	const state: { status: RelayStatus; reason: string } = {
		status: "starting",
		reason: "",
	};
	const handle: RelayHandle = {
		get state(): RelayState {
			return { status: state.status, reason: state.reason };
		},
	};

	/**
	 * Whether a host has ever answered.
	 *
	 * This one flag is the difference between reconnecting and retrying, and the
	 * two are not the same thing. A port that drops *after* a successful
	 * attachment is the case Chrome documents recovering from by calling
	 * `connectNative` again, and doing so is what lets the bridge survive a
	 * daemon restart with nobody involved.
	 *
	 * A port that has never attached is a different thing entirely: the host is
	 * not registered, or cannot be launched. Reconnecting immediately there does
	 * not recover anything — it only repeats a failure that a person has to fix
	 * by registering the host. Measured on a browser with no host registered:
	 * 2812 attempts in about a second and a half, each one logging, none of
	 * them useful. So an unattached port is not retried, and the way back is an
	 * event — the worker being revived — rather than a loop.
	 */
	let everAttached = false;

	const onStop = (stop: RelayStop): void => {
		if (stop.kind === "stopped") {
			return;
		}
		state.status = stop.kind === "no-daemon" ? "no-daemon" : "detached";
		state.reason = stop.reason;
		// A relay that stopped is not reusable, and nothing else will notice.
		// Reconnecting here is what lets the bridge survive a daemon restart
		// without the person doing anything about it.
		if (everAttached) {
			connect();
		}
	};

	const connect = (): void => {
		let port: AxRuntimePort;
		try {
			port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
		} catch {
			// No host is registered. That has one known fix — register the host
			// manifest — and it is not a reason to throw on every worker start.
			state.status = "no-daemon";
			state.reason = "the native host is not registered";
			return;
		}
		port.onMessage.addListener((message: unknown) => {
			const attachment = readAttachment(message);
			if (attachment === null) {
				state.status = "no-daemon";
				state.reason = readRefusal(message);
				return;
			}
			everAttached = true;
			state.status = "attached";
			state.reason = "";
			void serveRelay(attachment, dispatch, onStop);
		});
		port.onDisconnect.addListener(() => {
			// The browser closed the port. Nothing is queued on it any more, and
			// nothing will bring the host back on its own.
			state.status = "detached";
			state.reason = "the browser closed the native connection";
			// Only when there was something to lose. See `everAttached`.
			if (everAttached) {
				connect();
			}
		});
		// Say something, or the host has nothing to answer.
		//
		// Neither side is obliged to speak first on a `connectNative` port, and
		// this pair was built the wrong way round: the broker waits for a frame
		// before it replies, and the worker only ever listened. Neither ever
		// spoke, so neither ever learned the other's port, and the connection sat
		// there looking healthy while nothing was on it.
		//
		// The greeting is deliberately empty of anything the host could act on.
		// Its whole content is "a caller is here", which is the only thing the
		// broker needs in order to answer with where the daemon is.
		port.postMessage({ type: "connect" });
	};

	connect();
	return handle;
}
