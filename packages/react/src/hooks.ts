// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { AxContext } from "./context.js";
import type {
	AxActionOptions,
	AxExecuteCallback,
	AxModelContextLike,
	AxToolDefinition,
	AxToolHandle,
} from "./types.js";

const INERT: AxToolHandle = {
	supported: false,
	registered: false,
	error: null,
};

function hasWindow(): boolean {
	return typeof window !== "undefined" && typeof document !== "undefined";
}

function surfaceOf(doc: Document): AxModelContextLike | undefined {
	const raw = doc as unknown as Record<string, unknown>;
	const candidate = raw.modelContext;
	if (typeof candidate !== "object" || candidate === null) {
		return undefined;
	}
	const register = (candidate as Record<string, unknown>).registerTool;
	if (typeof register !== "function") {
		return undefined;
	}
	return candidate as AxModelContextLike;
}

function snapshotIdentity(
	name: string,
	description: string,
	title: string | undefined,
	inputSchema: unknown,
	annotations: unknown,
	exposedTo: ReadonlyArray<string> | undefined,
): string {
	const schemaText = safeJson(inputSchema);
	const annotationsText = safeJson(annotations ?? null);
	const exposedText = safeJson(exposedTo ?? null);
	return `${name}|${description}|${title ?? ""}|${schemaText}|${annotationsText}|${exposedText}`;
}

function safeJson(value: unknown): string {
	try {
		const text: unknown = JSON.stringify(value === undefined ? null : value);
		return typeof text === "string" ? text : "unserializable";
	} catch {
		return "unserializable";
	}
}

function isDuplicateName(error: unknown): boolean {
	return error instanceof DOMException && error.name === "InvalidStateError";
}

function nextTask(): Promise<void> {
	if (typeof MessageChannel === "function") {
		return new Promise<void>((resolve) => {
			const channel = new MessageChannel();
			channel.port1.onmessage = (): void => {
				channel.port1.close();
				channel.port2.close();
				resolve();
			};
			channel.port2.postMessage(undefined);
		});
	}
	return Promise.resolve();
}

async function quiesce(): Promise<void> {
	await Promise.resolve();
	await nextTask();
}

/**
 * Register a tool for the lifetime of the calling component. The
 * registration controller is created inside the client effect with cleanup
 * aborting it, so development setup-cleanup-setup leaves exactly one
 * registration. The registered callback is stable and forwards to a
 * latest-handler mailbox, while identity change aborts then registers with
 * tolerance for transient duplicate-name rejection.
 */
export function useAxTool(
	tool: AxToolDefinition,
	deps?: ReadonlyArray<unknown>,
): AxToolHandle {
	const { namespace, middleware } = useContext(AxContext);
	const effectiveName = `${namespace}${tool.name}`;

	const handlerRef = useRef<AxExecuteCallback>(tool.execute);
	handlerRef.current = tool.execute;
	const middlewareRef = useRef(middleware);
	middlewareRef.current = middleware;

	const identity = snapshotIdentity(
		effectiveName,
		tool.description,
		tool.title,
		tool.inputSchema,
		tool.annotations,
		tool.exposedTo,
	);
	const extra = deps === undefined ? "" : safeJson(deps);
	const key = `${identity}|${extra}`;

	const [state, setState] = useState<AxToolHandle>(() => {
		if (!hasWindow()) {
			return INERT;
		}
		return { supported: true, registered: false, error: null };
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: key encodes identity
	useEffect(() => {
		if (!hasWindow()) {
			setState(INERT);
			return;
		}
		const doc: Document = document;
		const detected = surfaceOf(doc);
		if (detected === undefined) {
			setState({ supported: false, registered: false, error: null });
			return;
		}
		const surface: AxModelContextLike = detected;
		let cancelled = false;
		const controller = new AbortController();
		let settled = false;

		const stableExecute: AxExecuteCallback = (args, opts) => {
			const latest = handlerRef.current;
			const wrap = middlewareRef.current;
			if (wrap === undefined) {
				return latest(args, opts);
			}
			return wrap(latest, args, opts);
		};

		async function register(attempt: number): Promise<void> {
			try {
				await surface.registerTool(
					{
						name: effectiveName,
						title: tool.title,
						description: tool.description,
						inputSchema: tool.inputSchema,
						execute: stableExecute,
						annotations: tool.annotations,
					},
					{
						exposedTo: tool.exposedTo,
						signal: controller.signal,
					},
				);
				if (!cancelled && !settled) {
					settled = true;
					setState({ supported: true, registered: true, error: null });
				}
			} catch (error) {
				if (controller.signal.aborted || cancelled) {
					return;
				}
				if (isDuplicateName(error) && attempt === 0) {
					await quiesce();
					if (controller.signal.aborted || cancelled) {
						return;
					}
					await register(1);
					return;
				}
				if (!cancelled && !settled) {
					settled = true;
					setState({
						supported: true,
						registered: false,
						error: (error as Error | DOMException) ?? null,
					});
				}
			}
		}

		void register(0);
		return () => {
			cancelled = true;
			controller.abort();
			setState({ supported: true, registered: false, error: null });
		};
	}, [key]);

	if (!hasWindow()) {
		return INERT;
	}
	return state;
}

/**
 * Feature-detect the registration surface for one document. False where the
 * caller must render the inert handle instead of registering.
 */
export function isAxSupported(doc: Document | undefined): boolean {
	if (doc === undefined) {
		return false;
	}
	if (!hasWindow()) {
		return false;
	}
	return surfaceOf(doc) !== undefined;
}

/**
 * Register a named action with a handler. The description and contract
 * options default to empty so mistakes surface the draft error family
 * instead of a placeholder.
 */
export function useAxAction(
	name: string,
	handler: AxExecuteCallback,
	options?: AxActionOptions,
): AxToolHandle {
	return useAxTool({
		name,
		description: options?.description ?? "",
		title: options?.title,
		inputSchema: options?.inputSchema,
		execute: handler,
		annotations: options?.annotations,
		exposedTo: options?.exposedTo,
	});
}
