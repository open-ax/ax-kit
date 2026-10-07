import { defineConfig } from "vitest/config";

/**
 * One project, one environment.
 *
 * The example's tool surface touches `document.modelContext`, so the fast layer
 * here runs against happy-dom for the same reason the polyfill's own fast layer
 * does: name validation, argument rejection, annotation shape and enumeration
 * order are pure logic dressed in an installed surface, and running them in a
 * browser would cost minutes to learn nothing a DOM implementation does not
 * already tell us.
 *
 * The other half - that the *built output* publishes tools to an agent in a real
 * browser - is `test/browser.ts`, run by Playwright through this application's
 * own `playwright.config.ts`. Splitting it this way rather than adding a second
 * Vitest browser project is deliberate: that infrastructure already exists and
 * duplicating it in an application would be the kind of addition this example
 * is arranged to avoid.
 */
export default defineConfig({
	test: {
		name: "demo-store",
		environment: "happy-dom",
		include: ["test/*.test.ts"],
		setupFiles: ["test/setup.ts"],
	},
});
