// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

"use client";

import type { Context, ReactNode } from "react";
import { createContext, createElement, useContext, useMemo } from "react";
import type { AxMiddleware } from "./types.js";

export interface AxContextValue {
	readonly namespace: string;
	readonly middleware: AxMiddleware | undefined;
}

export const AxContext: Context<AxContextValue> = createContext<AxContextValue>(
	{
		namespace: "",
		middleware: undefined,
	},
);

export interface AxProviderProps {
	readonly namespace?: string | undefined;
	readonly middleware?: AxMiddleware | undefined;
	readonly children: ReactNode;
}

/**
 * Share a name prefix plus invocation middleware with a subtree. Nested
 * providers concatenate prefixes so per-tool wiring stays flat. The
 * middleware wraps the latest handler only; registration identity is
 * unaffected by middleware changes.
 */
export function AxProvider(props: AxProviderProps): ReactNode {
	const parent = useContext(AxContext);
	const value = useMemo<AxContextValue>(
		() => ({
			namespace: `${parent.namespace}${props.namespace ?? ""}`,
			middleware:
				props.middleware !== undefined ? props.middleware : parent.middleware,
		}),
		[parent.namespace, parent.middleware, props.namespace, props.middleware],
	);
	return createElement(AxContext.Provider, { value }, props.children);
}
