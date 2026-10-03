// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Executable entry point: a read loop over standard input.
 *
 * Everything here is ours, not the draft's: the draft defines the page
 * surface, while this process speaks the client protocol on the other side of
 * the bridge. The pure helpers in `protocol.ts` and `stdio.ts` do the framing
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
 *   after it.
 */

import type { DaemonInfo, JsonRpcResponse } from "./protocol.js";
import {
	createDaemonInfo,
	dispatchRequest,
	parseFrame,
	serializeFrame,
} from "./protocol.js";
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

/** Where tools come from. Re-read per request: the page may change under us. */
interface BridgeProvider {
	listTools(): ReadonlyArray<Record<string, unknown>>;
}

function protocolError(code: number, message: string): JsonRpcResponse {
	return { jsonrpc: "2.0", id: null, error: { code, message } };
}

/**
 * Answer one wire frame. Never throws: a failure becomes a typed protocol
 * error, because a refused frame must not be able to stop the loop.
 */
function answerFrame(
	line: string,
	tools: BridgeProvider,
	info: DaemonInfo,
): JsonRpcResponse {
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
	return dispatchRequest(request, tools.listTools(), info);
}

/**
 * Run the loop until the input side closes. Readiness is observed through the
 * pipe itself, so nothing here waits on a timer.
 */
function runStdioLoop(
	source: StdioSource,
	sink: StdioSink,
	tools: BridgeProvider,
	info: DaemonInfo,
): void {
	let buffer = "";
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
			sink.writeFrame(answerFrame(line, tools, info));
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

/** With no page bridge attached the daemon is honest and offers nothing. */
function createEmptyProvider(warn: (message: string) => void): BridgeProvider {
	warn("ax-kit daemon: no page bridge attached");
	return { listTools: () => [] };
}

/**
 * Start the daemon on this process's real pipes.
 *
 * Called by the `bin` shim rather than guarded by an entry-point check: a shim
 * that imports this module leaves `process.argv[1]` pointing at the shim, so
 * comparing paths would silently never start the loop.
 */
export function main(): void {
	const sink = createNodeSink();
	runStdioLoop(
		createNodeSource(),
		sink,
		createEmptyProvider(sink.warn),
		createDaemonInfo(),
	);
}
