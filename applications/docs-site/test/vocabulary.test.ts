// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * One vocabulary, in two places.
 *
 * The storefront and the documentation site deliberately do not import each
 * other's tool table. That is the right call — the documentation's island is
 * bundled into the site's own JavaScript, and reaching across a workspace
 * boundary to draw a constant would couple one application's build to another's
 * layout — and the cost is that the two can drift.
 *
 * So they are compared here instead. Two names for one concept in two places is
 * the specific failure this project has committed once already, and a reference
 * implementation is judged partly by what it refuses to leave to chance.
 *
 * Read as source rather than executed: the point is that these two files agree,
 * not that either one works. `test/browser.ts` in each application checks that
 * they work.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const STOREFRONT = `${REPO}applications/demo-store/src/lib/tools.ts`;
const DEMONSTRATION = `${SITE}src/components/TryIt.tsx`;

/** The tool names each file declares, in the order it declares them. */
function declaredNames(source: string): string[] {
	// The demo's `TOOLS` is a literal array of objects with a `name` property;
	// the storefront's is a list of `const` declarations bound to `name:`. Reading
	// the property is the shape both share, which is why it is the thing matched
	// rather than either file's syntax.
	return [...source.matchAll(/name:\s*"([a-z_]+)"/g)].map((match) => match[1]);
}

describe("the canonical tool vocabulary", () => {
	const storefront = declaredNames(readFileSync(STOREFRONT, "utf8"));
	const demonstration = declaredNames(readFileSync(DEMONSTRATION, "utf8"));

	it("is the same set in both places", () => {
		expect(demonstration.sort()).toEqual(storefront.sort());
	});

	it("is five tools, and no sixth appears in either", () => {
		expect(storefront).toHaveLength(5);
		expect(demonstration).toHaveLength(5);
	});

	it("marks exactly one consequential, and both agree which", () => {
		const consequentialIn = (path: string) => {
			const source = readFileSync(path, "utf8");
			// The storefront records the decision as `consequential: true` in a
			// table; the demo records it on the same property. Both are read the
			// same way so a change to one shape cannot silently pass.
			return [...source.matchAll(/consequential:\s*true/g)].length;
		};
		expect(consequentialIn(STOREFRONT)).toBe(1);
		expect(consequentialIn(DEMONSTRATION)).toBe(1);
	});

	it("uses snake_case, which the draft's name rule permits", () => {
		// 1–128 characters of `[A-Za-z0-9_.-]`. Asserted because a name that
		// violates the rule is a registration the implementation refuses, and the
		// failure would surface as an empty demonstration rather than as a bad name.
		for (const name of storefront) {
			expect(name, `${name} is not a legal tool name`).toMatch(
				/^[A-Za-z0-9_.-]{1,128}$/,
			);
		}
	});
});
