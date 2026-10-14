// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Executable entry point: a read loop over standard input, plus the local
 * listener the extension reaches.
 *
 * Everything here is ours, not draft-derived: the draft defines the page
 * surface, while this process speaks the client protocol on the other side
 * of the bridge. The pure helpers in `protocol.ts` and `stdio.ts` do the framing
 * and the dispatch; this file is only the loop that feeds them plus the
 * lifecycle that closes them.
 *
 * Invariants this process exists to hold:
 *
 * - Only protocol frames reach standard output. Diagnostics go to standard
 *   error, always, because one stray line on stdout corrupts the stream.
 * - Standard-input close is the only shutdown signal.
 * - Every request is answered independently. There is no session, so a frame
 *   never waits on an earlier one and a refused frame never blocks the frames
 *   after it. Frames are dispatched concurrently for exactly that reason: a
 *   `tools/call` waiting on a person must not stall the `tools/list` behind it.
 */

import { PageBridge } from "./bridge.js";
import { resolveDiscoveryDir } from "./discovery.js";
import type { Transport } from "./lifecycle.js";
import { startTransport } from "./lifecycle.js";
import type { BridgeProvider } from "./outcome.js";
import { emptyBridgeProvider } from "./outcome.js";
import type { DaemonInfo, JsonRpcResponse } from "./protocol.js";
import {
	createDaemonInfo,
	dispatchRequest,
	parseFrame,
	serializeFrame,
} from "./protocol.js";
import { PageBridgeProvider } from "./provider.js";
import { logToStderr, splitFrames } from "./stdio.js";

/** The input side. The process tests drive this over a real pipe instead. */
interface StdioSource {
	/** Subscribe to chunks. Returns a disposer. */
	onData(handler: (chunk: string) => void): () => void;
	/** Runs once the input side closes for good. Returns a disposer. */
	onEnd(handler: () => void): () => void;
}

/** The output side. Frames go to stdout; `warn` must never reach stdout. */
interface StdioSink {
	writeFrame(response: JsonRpcResponse): void;
	warn(message: string): void;
	close(): void;
}

function protocolError(code: number, message: string): JsonRpcResponse {
	return { jsonrpc: "2.0", id: null, error: { code, message } };
}

/**
 * Answer one wire frame. Never throws: a failure becomes a typed protocol
 * error, because a refused frame must not be able to stop the loop.
 */
async function answerFrame(
	line: string,
	provider: BridgeProvider,
	info: DaemonInfo,
): Promise<JsonRpcResponse> {
	let request: unknown;
	try {
		request = parseFrame(line);
	} catch (error: unknown) {
		const detail = error instanceof TypeError ? error.message : "";
		return detail === "frame too large"
			? protocolError(-32600, "frame too large")
			: protocolError(
					-32700,
					`unparsable frame${detail === "" ? "" : `: ${detail}`}`,
				);
	}
	try {
		return await dispatchRequest(request, provider, info);
	} catch {
		// The dispatcher refuses rather than throws, so reaching here means a bug
		// in a path every caller depends on. The frame still has to be answered:
		// a client blocked on a request that is never settled is worse than one
		// told the server is unwell.
		return protocolError(-32603, "request could not be answered");
	}
}

/**
 * Run the loop until the input side closes. Readiness is observed through the
 * pipe itself, so nothing here waits on a timer.
 *
 * Work is concurrent; answers are ordered. Those are two different things and
 * both are wanted. A frame whose tools live on the far side of a browser must
 * not stop the next frame from being *started*, and a client reading frames off
 * the pipe one line at a time must still get them in the order it sent them.
 * The cost is that one genuinely slow frame delays delivery of the ones behind
 * it, which is what any serial server would do and is not a new failure.
 */
function runStdioLoop(
	source: StdioSource,
	sink: StdioSink,
	provider: BridgeProvider,
	info: DaemonInfo,
	onClose: () => void,
): void {
	let buffer = "";
	// One slot per frame in arrival order, filled in when its answer arrives.
	const inFlight: Array<{ answer?: JsonRpcResponse }> = [];
	let nextToWrite = 0;
	const drain = (): void => {
		for (;;) {
			const slot = inFlight[nextToWrite];
			if (slot === undefined || slot.answer === undefined) {
				return;
			}
			sink.writeFrame(slot.answer);
			nextToWrite += 1;
		}
	};
	const stopData = source.onData((chunk: string) => {
		buffer += chunk;
		let split: { lines: string[]; rest: string };
		try {
			split = splitFrames(buffer);
		} catch {
			// An over-long frame is refused and the buffer dropped rather than
			// retained, so one hostile frame cannot wedge every later request.
			sink.writeFrame(protocolError(-32600, "frame too large"));
			buffer = "";
			return;
		}
		buffer = split.rest;
		for (const line of split.lines) {
			if (line.length === 0) {
				continue;
			}
			// Started, not awaited: the frame behind this one begins its own
			// work without waiting. The write is what waits, in `drain`.
			const slot: { answer?: JsonRpcResponse } = {};
			inFlight.push(slot);
			void answerFrame(line, provider, info).then((response) => {
				slot.answer = response;
				drain();
			});
		}
	});
	let stopped = false;
	const stopEnd = source.onEnd(() => {
		if (stopped) {
			return;
		}
		stopped = true;
		stopData();
		stopEnd();
		// The listener is closed before the sink, and it has to be closed at all:
		// an open server is a live handle, and a daemon whose client has gone
		// would otherwise sit there holding a port and a discovery file that
		// points at it. Standard-input close is the only shutdown signal this
		// process has, so everything it owns has to go with it.
		onClose();
		sink.close();
	});
}

function createNodeSource(): StdioSource {
	const stdin = process.stdin;
	stdin.setEncoding("utf8");
	stdin.resume();
	return {
		onData(handler: (chunk: string) => void): () => void {
			stdin.on("data", handler);
			return () => stdin.off("data", handler);
		},
		onEnd(handler: () => void): () => void {
			stdin.on("end", handler);
			return () => stdin.off("end", handler);
		},
	};
}

function createNodeSink(): StdioSink {
	return {
		writeFrame(response: JsonRpcResponse): void {
			process.stdout.write(`${serializeFrame(response)}\n`);
		},
		warn(message: string): void {
			logToStderr((text: string) => {
				process.stderr.write(text);
			}, message);
		},
		close(): void {
			process.stdout.end();
		},
	};
}

/**
 * Start the daemon on this process's real pipes.
 *
 * Called by the `bin` shim rather than guarded by an entry-point check: a shim
 * that imports this module leaves `process.argv[1]` pointing at the shim, so
 * comparing paths would silently never start the loop.
 *
 * The listener starts before the loop because a client that attaches to a port
 * the daemon has not opened yet finds nothing, and "nothing yet" is
 * indistinguishable from "no bridge". A failure to open it is a warning rather
 * than a refusal to start: stdio still works on its own, and a host with no
 * writable runtime directory should still be able to answer `server/discover`.
 */
export function main(): void {
	const sink = createNodeSink();
	const bridge = new PageBridge();
	const info = createDaemonInfo();

	// Swapped in once the listener is listening. Until then the empty provider
	// answers, which is the truth: nothing is attached to this port yet.
	let provider: BridgeProvider = emptyBridgeProvider();
	let transport: Transport | undefined;
	// A client that hangs up can arrive before the listener is up. Without this
	// the close would find nothing to close, the listener would come up a moment
	// later, and the process would sit there holding a port its client had
	// already abandoned.
	let closing = false;
	void (async () => {
		try {
			const discoveryDir = resolveDiscoveryDir(process.env, sink.warn);
			const open = await startTransport({
				discoveryDir,
				bridge,
				provider: new PageBridgeProvider(bridge),
				info,
			});
			if (closing) {
				await open.close().catch(() => {
					// The client is already gone; nothing depends on this.
				});
				return;
			}
			transport = open;
			provider = new PageBridgeProvider(bridge);
			sink.warn(
				`ax-kit daemon: local transport listening on ${String(open.port)}`,
			);
		} catch (error: unknown) {
			sink.warn(
				`ax-kit daemon: local transport unavailable (${
					error instanceof Error ? error.message : "unknown"
				}); serving stdio only`,
			);
		}
	})();

	runStdioLoop(
		createNodeSource(),
		sink,
		// Delegating rather than passing `provider` itself: the loop captures the
		// object it is handed, and the object that replaces this one is a
		// different object. Passing the variable would pin the loop to whichever
		// provider existed when it was constructed, which is the empty one.
		{
			listTools: () => provider.listTools(),
			callTool: (name: string, args: Record<string, unknown>) =>
				provider.callTool(name, args),
		},
		info,
		() => {
			closing = true;
			// Closed and forgotten, so a repeat close is a no-op rather than an
			// unhandled rejection on a second call.
			const open = transport;
			transport = undefined;
			void open?.close().catch(() => {
				// Already gone. Nothing here depends on it having succeeded.
			});
		},
	);
}

export { emptyBridgeProvider };
