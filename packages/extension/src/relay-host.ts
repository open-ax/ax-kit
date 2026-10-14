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
	 * Whether a retry has anything to re-discover.
	 *
	 * The native port is a rendezvous, not a channel. The broker's whole reply
	 * is where the daemon is; the extension then talks to the daemon directly
	 * over loopback and never reads that pipe again. So there are two different
	 * disconnects and they mean opposite things:
	 *
	 * - **the port closing** is the broker finishing its one job. Measured after
	 *   it was made to exit rather than linger: this fires immediately after a
	 *   successful attachment. Reconnecting here would ask for a rendezvous
	 *   already had, spawning a broker per cycle forever.
	 * - **the relay stopping** means the daemon became unreachable, which is a
	 *   daemon that may come back with a different port. Reconnecting is how the
	 *   bridge survives a restart with nobody involved, and it is correct there.
	 *
	 * An unattached port is not retried either. A browser with no host
	 * registered answered 2812 `connectNative` calls in about a second and a
	 * half, each one logging, none of them able to succeed — the fix is a
	 * person registering the host. The way back is the worker being revived.
	 */

	const onStop = (stop: RelayStop): void => {
		if (stop.kind === "stopped") {
			return;
		}
		state.status = stop.kind === "no-daemon" ? "no-daemon" : "detached";
		state.reason = stop.reason;
		// Re-runs the rendezvous, which re-reads the discovery file and so
		// picks up a daemon that has restarted on a different port.
		connect();
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
			state.status = "attached";
			state.reason = "";
			void serveRelay(attachment, dispatch, onStop);
		});
		port.onDisconnect.addListener(() => {
			// The broker finished its one job and closed the port. This is the
			// expected end of a rendezvous, not a lost connection, and nothing
			// was waiting on it. Deliberately no reconnect - see `onStop`.
			state.status = "detached";
			state.reason = "the broker answered and closed the native connection";
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
