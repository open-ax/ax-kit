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
		// Copied before sorting. `sort()` mutates, and both arrays are shared with
		// the cases below — so sorting in place silently reordered them, and the
		// docblock's "in the order it declares them" stopped being true from the
		// first assertion onward.
		expect([...demonstration].sort()).toEqual([...storefront].sort());
	});

	it("declares them in the same order in both places", () => {
		// The previous case sorted before comparing, so a reordering in one file
		// could not be detected at all. The storefront's order is the reading order
		// of a shopping flow, and the demo's is meant to mirror it.
		expect(demonstration).toEqual(storefront);
	});

	it("is five tools, and no sixth appears in either", () => {
		expect(storefront).toHaveLength(5);
		expect(demonstration).toHaveLength(5);
	});

	it("marks exactly one consequential, and both agree which", () => {
		// The *name* is compared, not only the count. Two files each flagging one
		// tool is not agreement if they flag different ones, and a count-only
		// assertion reported that state as a pass.
		const consequentialNameIn = (path: string): string | undefined => {
			const source = readFileSync(path, "utf8");
			// Both files record the decision on a `consequential:` property within a
			// few lines of the tool's `name`. Read as a window so the property is
			// attributed to the nearest preceding name rather than the whole file.
			// The tempered-dot token is what keeps the match inside one tool: an
			// unbounded `[\s\S]{0,400}?` reaches *backwards* into the previous
			// tool's object and reports its name instead, which is how a first
			// attempt at this assertion compared `apply_coupon_code` with
			// `proceed_to_checkout` and failed on files that agree.
			const match =
				/name:\s*"([a-z_]+)"((?:(?!name:)[\s\S]){0,400}?)consequential:\s*true/.exec(
					source,
				);
			return match?.[1];
		};
		const fromStorefront = consequentialNameIn(STOREFRONT);
		const fromDemonstration = consequentialNameIn(DEMONSTRATION);
		expect(fromStorefront).toBeDefined();
		expect(fromDemonstration).toBeDefined();
		expect(fromDemonstration).toBe(fromStorefront);
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
