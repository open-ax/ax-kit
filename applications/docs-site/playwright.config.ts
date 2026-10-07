import { defineConfig } from "@playwright/test";

/**
 * The documentation site, in a real browser.
 *
 * Separate from the polyfill's runner configuration. That one exists to score
 * the proposal's suite against this repository's bundle, and its projects serve a
 * suite from a pinned upstream revision — none of which applies to a site that
 * has to be built and previewed.
 *
 * The build is a prerequisite rather than something this config arranges. The
 * tests fail with a clear message when `dist/` is absent, because serving source
 * would make every assertion about something nobody deploys.
 */
export default defineConfig({
	testDir: "./test",
	testMatch: /browser\.ts$/,
	// 45 seconds: the preview server starts once in `beforeAll` and the suite
	// loads two pages. The wait is for a port to bind, which raises no event.
	timeout: 45_000,
	workers: 1,
	fullyParallel: false,
	trace: "off",
	reporter: [["list"]],
	use: {},
});
