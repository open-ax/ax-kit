// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { Page } from "@playwright/test";
import { withSurfaceError } from "./errors.js";
import { compareToolNames } from "./match.js";
import type { AxToolSummary } from "./types.js";

interface PageToolRecord {
	readonly name: unknown;
	readonly description: unknown;
	readonly title: unknown;
	readonly origin: unknown;
	readonly annotations: unknown;
}

/**
 * Current listing mapped to serializable summaries. The live `window`
 * field never crosses the boundary; names cross instead. Sorted ascending
 * by name in code-unit order.
 */
export async function listToolSummaries(
	page: Page,
	fromOrigins?: ReadonlyArray<string> | undefined,
): Promise<AxToolSummary[]> {
	const records = await withSurfaceError(
		page.evaluate(
			(arg: unknown): Promise<PageToolRecord[]> => {
				const payload = arg as { fromOrigins: unknown };
				const holder = document as unknown as Record<string, unknown>;
				const surface = holder.modelContext as unknown as {
					getTools?: (
						options?: unknown,
					) => Promise<Array<Record<string, unknown>>>;
				} | null;
				if (
					surface === null ||
					surface === undefined ||
					typeof surface.getTools !== "function"
				) {
					throw new Error("typed surface is missing");
				}
				const origins =
					payload.fromOrigins === undefined || payload.fromOrigins === null
						? undefined
						: { fromOrigins: payload.fromOrigins };
				return surface.getTools(origins).then((tools) =>
					tools.map(
						(tool): PageToolRecord => ({
							name: tool.name,
							description: tool.description,
							title: tool.title,
							origin: tool.origin,
							annotations: tool.annotations,
						}),
					),
				);
			},
			{ fromOrigins: fromOrigins ?? null },
		),
	);
	const summaries: AxToolSummary[] = [];
	for (const record of records) {
		if (typeof record.name !== "string") {
			continue;
		}
		summaries.push({
			name: record.name,
			description:
				typeof record.description === "string" ? record.description : "",
			title: typeof record.title === "string" ? record.title : "",
			origin: typeof record.origin === "string" ? record.origin : "",
			...(isAnnotations(record.annotations)
				? { annotations: record.annotations }
				: {}),
		});
	}
	summaries.sort((first, second) => compareToolNames(first.name, second.name));
	return summaries;
}

function isAnnotations(value: unknown): value is AxToolSummary["annotations"] {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	return true;
}
