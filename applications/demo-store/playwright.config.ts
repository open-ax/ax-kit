import { defineConfig } from "@playwright/test";

/**
 * The deployed storefront, in a real browser.
 *
 * Separate from the polyfill's own runner configuration on purpose. That
 * configuration exists to score the proposal's suite against this repository's
 * bundle, and its projects each serve a suite from a pinned upstream revision —
 * none of which applies to an application that has to be built and started.
 * Adding a fourth project there would put the storefront's server lifecycle into
 * a config whose entire job is upstream conformance.
 *
 * The build is a prerequisite rather than something this config arranges. The
 * tests deliberately fail with a clear message when `.next` is absent, because
 * serving a dev server instead would make every assertion about a thing nobody
 * deploys — and a missing header is exactly the kind of difference a dev server
 * hides.
 */
export default defineConfig({
	testDir: "./test",
	testMatch: /browser\.ts$/,
	timeout: 90_000,
	// One worker. The suite starts one server in `beforeAll`; running the files
	// in parallel would start several and race on the port. There is one file,
	// so this costs nothing and removes a class of flake.
	workers: 1,
	fullyParallel: false,
	// The page has no interactive state worth reporting on, and a trace for a
	// passing run is bytes nobody reads.
	trace: "off",
	reporter: [["list"]],
	use: {},
});
