import { defineConfig } from "vitest/config";

/**
 * One project, no DOM.
 *
 * The vocabulary check compares two source files and needs nothing else. The
 * behavioural checks live in `test/browser.ts` against the built output and a
 * real browser, because the thing being verified is a page in a reader's browser
 * and asserting it with a DOM implementation would verify the DOM
 * implementation.
 */
export default defineConfig({
	test: {
		name: "docs-site",
		environment: "node",
		include: ["test/*.test.ts"],
	},
});
