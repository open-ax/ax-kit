// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INIT_SCRIPT_FILENAME = "init.global.iife.js";

/**
 * Absolute path of the built page-side bundle installed by the fixture.
 * Resolved from the current module so the runner entry and the page bundle
 * stay co-located after publish. During development the entry runs from
 * source, so the sibling build output is accepted as well.
 */
export function resolveInitScriptPath(): string {
	const candidates = [
		new URL(`./${INIT_SCRIPT_FILENAME}`, import.meta.url),
		new URL(`../dist/${INIT_SCRIPT_FILENAME}`, import.meta.url),
	];
	for (const candidate of candidates) {
		const path = fileURLToPath(candidate);
		if (existsSync(path)) {
			return path;
		}
	}
	return fileURLToPath(candidates[0]);
}
