// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function src(name: string): string {
	return readFileSync(join(process.cwd(), "src", name), "utf8");
}

describe("negative guards", () => {
	it("uses the client effect only", () => {
		const hooks = src("hooks.ts");
		expect(hooks).not.toMatch("useInsertionEffect");
		expect(hooks).toMatch("useEffect");
	});

	it("has no ref-guard skip", () => {
		const hooks = src("hooks.ts");
		expect(hooks).not.toMatch(/if\s*\(\s*!.*\.current/);
	});

	it("marks client modules", () => {
		const index = src("index.ts");
		expect(index).toMatch("use client");
	});

	it("is sleep-free", () => {
		for (const file of ["hooks.ts", "context.tsx", "types.ts"]) {
			const text = src(file);
			expect(text).not.toMatch("setTimeout");
			expect(text).not.toMatch("setInterval");
		}
	});

	it("declares zero runtime dependencies", () => {
		const pkg = JSON.parse(
			readFileSync(join(process.cwd(), "package.json"), "utf8"),
		) as unknown as Record<string, unknown>;
		expect(pkg.dependencies).toBeUndefined();
	});
});
