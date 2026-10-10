import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

/**
 * The documentation site.
 *
 * Three decisions here are load-bearing, and each one is a response to something
 * specific about this project rather than a framework preference.
 *
 * ## Static output with islands, and nothing else
 *
 * The deciding requirement is a hydrated component that runs the polyfill in the
 * reader's browser. Static generation is what makes "pages with no interactive
 * example load no framework runtime" true rather than aspirational — and that is
 * a measured claim, because `test/browser.ts` fetches a content page and asserts
 * it carries no script that runs the island.
 *
 * ## Two tools for the reference, deliberately
 *
 * `scripts/generate-reference.mjs` writes the API reference pages.
 * `scripts/verify-reference.mjs` writes a *report* of the public interface and
 * fails the build when it changes without the pages changing with it. These are
 * different jobs and one tool does not do both well: using one tool for both
 * gives either documentation that drifts or a build that fails on irrelevant
 * changes.
 *
 * The report is **committed** at `src/data/api-report.json`. It sits beside the
 * generated page rather than beside the hand-written pages, because it is an input
 * to the generator rather than a page anyone edits. That is what makes the change
 * reviewable — a pull request that alters a public signature shows the reference
 * diff next to the code diff.
 *
 * ## No dates rendered from build time
 *
 * The `LastUpdated` component reads from git. The site rebuilds on every release,
 * so a build-time date would make every page look freshly edited after every
 * release and destroy the only signal the dates carry, which is which pages
 * actually changed. The component is therefore not used at all — see
 * `components.Footer` below, which replaces the framework's footer rather than
 * extending it.
 *
 * (This header previously claimed `build: { format: "file" }` while the
 * configuration set `"directory"`. A header that explains decisions is worth
 * nothing if it describes a file that is not the one being built.)
 */
export default defineConfig({
	site: "https://ax-kit.dev",
	// "always", not "never", because every link on this site ends in a slash —
	// the ones written in MDX and the ones the documentation framework
	// generates. With "never" the development server answers those URLs with a
	// warning page rather than the page, so the site behaves differently under
	// `astro dev` than it does after a build. The two must agree, or the
	// development server stops being a way to check the site.
	trailingSlash: "always",
	build: {
		// "directory", not "file".
		//
		// Every link on this site carries a trailing slash — the ones written in
		// MDX and the ones the documentation framework's own footer generates — so
		// "directory" is the format that makes them resolve. Choosing "file" and
		// then fixing the links is the wrong order: the framework emits its own
		// links and those would need overriding.
		//
		// Found by `scripts/verify-links.mjs`, which checks the built output rather
		// than the sources. The build was green and 65 links were broken.
		format: "directory",
	},
	integrations: [
		// React only because one island needs it. The integration is loaded here so
		// the renderer exists, and the island is opted into per page with
		// `<TryIt client:load />`; no page ships the runtime unless it carries one.
		react(),
		starlight({
			// The organisation, not the repository.
			//
			// The header lockup names who publishes the documentation, and that is
			// OpenAX; `ax-kit` is one project under it. The same mark serves both —
			// the organisation's own profile page sets `alt="OpenAX"` on this
			// repository's `assets/ax-mark-*.png`, so there is one brand and one
			// drawing, not a logo and a wordmark that have to agree.
			//
			// This is also what stops the browser tab reading `ax-kit | ax-kit`:
			// the site's title becomes the delimiter's right-hand side, so the
			// landing page — whose own frontmatter title is `ax-kit` — reads
			// `ax-kit | OpenAX` instead of naming itself twice.
			title: "OpenAX",
			description:
				"A correct, tiny, dependency-free implementation of WebMCP's ModelContext.",
			// The tab mark. A PNG built from the real brand raster
			// (`public/ax-mark-dark.png`: white silhouette on the `#0b1220` tile),
			// not the hand-drawn SVG that used to sit here — that path was narrower,
			// more symmetrical, and its swoosh thinner than the real mark, and a logo
			// that does not match is worse than one that costs 696 bytes. The old
			// `/favicon.svg` is deleted with this change: leaving the file while
			// pointing elsewhere is how dead assets accumulate unnoticed.
			//
			// Top-level, because it is a site option, not a component override. It
			// was first written one block too deep, inside `components:` — where the
			// schema silently strips unknown keys, so every page kept the default
			// `/favicon.svg` and the link gate failed the build on the deleted file.
			// A misplaced option that fails silently is worse than one that errors.
			favicon: "/favicon-32x32.png",
			// No `logo`. The mark is placed by the `SiteTitle` override instead, from
			// this application's own `public/`: the mark is a two-tone raster, so
			// the framework's single-`src` `logo` option could only ever serve one
			// of its two colourways and the other scheme would get the wrong one.
			// `SiteTitle` renders both and the stylesheet picks by `data-theme`.
			// The array form, not the object form: v0.33.0 changed the syntax and
			// the object form is rejected outright rather than deprecated. Found by
			// running the build, which is the only way to find it.
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/open-ax/ax-kit",
				},
			],
			// Links, not slugs.
			//
			// A slug-based sidebar is resolved against the framework's route table at
			// build time, and against this repository's content collection it reported
			// every slug as nonexistent while the pages themselves built. So the
			// sidebar names URLs, and `scripts/verify-links.mjs` checks each one against
			// the **built output** — which is a stronger check than the framework's,
			// because it verifies a file that will actually be served rather than a
			// route that exists in a table.
			sidebar: [
				{
					// The quickstart is its own page rather than the landing page's
					// content. The landing page has to work as a landing page — a hero,
					// and one thing to do — and a quickstart is a reference, not a pitch.
					label: "Start here",
					items: [
						{ label: "Quickstart", link: "/quickstart" },
						{ label: "Try it in your browser", link: "/try-it" },
					],
				},
				{
					label: "Reference",
					items: [
						{ label: "API", link: "/reference/api" },
						{ label: "Annotations", link: "/reference/annotations" },
						{ label: "Errors", link: "/reference/errors" },
						{ label: "Conformance", link: "/reference/conformance" },
					],
				},
				{
					label: "Security",
					items: [
						{ label: "Threat model", link: "/security/threat-model" },
						{ label: "Whitepaper", link: "/security/whitepaper" },
						{
							label: "Reporting a vulnerability",
							link: "/security/reporting",
						},
					],
				},
			],
			// The self-hosted variable fonts, then the whole stylesheet. All three
			// come from the framework's own extension point rather than from a
			// `<link>` in a layout, so the stylesheet loads in the order the
			// cascade needs — after the framework's tokens, so its overrides win
			// without a single `!important`.
			//
			// Self-hosted rather than fetched from a font CDN: a documentation page
			// that makes a third-party request on load tells a third party who read
			// it, and this site makes no third-party requests at all.
			//
			// The family names carry a `Variable` suffix — read out of the installed
			// packages' own `index.css`, which declare `font-family: 'Geist Mono
			// Variable'`. Asking for the un-suffixed name matches no `@font-face`
			// rule, so the browser falls through to `system-ui`: the file is
			// downloaded on every page and never used.
			customCss: [
				"@fontsource-variable/hanken-grotesk",
				"@fontsource-variable/geist-mono",
				"./src/styles/ax.css",
			],
			// Code blocks in the same greys as the page, in both schemes.
			//
			// The framework's default is Night Owl — a blue-and-purple theme, the
			// loudest thing on any page built out of grey. Every code block on the
			// site is set through these two themes instead, so the syntax
			// highlighting follows the page's own palette rather than importing a
			// second one.
			expressiveCode: {
				themes: [
					greyTheme({
						name: "ax-grey-light",
						type: "light",
						bg: "#fafafa",
						// Measured against `#fafafa`, not eyeballed. The previous ramp
						// put comments at `#a3a3a3` — 2.42:1, which fails WCAG AA
						// (4.5:1) — and separated comments from punctuation by 0.89 of a
						// contrast point, so the two were the same grey to the eye. That
						// is why the blocks read as flat: not a font problem, and not
						// hue, but too few *distinguishable* steps in one ramp.
						//
						// The order is unchanged — comments recede, literals sit mid-ramp,
						// keywords go to the ink — but the steps are now far enough apart
						// to tell apart at a glance, and nothing a reader has to read is
						// below 4.5:1. Measured against `#fafafa`, from the top down:
						// key 18.62, fg 12.10, value 6.12, faint 4.89, muted 3.22.
						// Punctuation is the one step under the threshold, and deliberately
						// so: braces and semicolons are decoration, and holding them to a
						// text threshold is what flattens the other four.
						fg: "#333333", //  12.10:1 — functions, variables
						muted: "#8c8c8c", //  3.22:1 — punctuation; decoration, not read as text
						faint: "#6e6e6e", //  4.89:1 — comments: recede, but stay legible
						value: "#5f5f5f", //  6.12:1 — strings, numbers, constants
						key: "#0d0d0d", // 18.62:1 — keywords, properties: the ink
					}),
					greyTheme({
						name: "ax-grey-dark",
						type: "dark",
						bg: "#161616",
						// The same five decisions against `#161616`: key 16.16,
						// fg 12.21, value 8.34, faint 6.59, muted 5.24. Comments were at
						// `#5e5e5e` — 2.79:1 — and failed in this scheme too, which is the
						// half of the problem that a light-scheme-only check never sees.
						fg: "#d4d4d4", // 12.21:1
						muted: "#8a8a8a", // 5.24:1
						faint: "#9c9c9c", // 6.59:1
						value: "#b0b0b0", // 8.34:1
						key: "#f2f2f2", // 16.16:1
					}),
				],
				// Follow the site's own theme rather than the code block's, so a
				// block never renders dark on a light page.
				useStarlightDarkModeSwitch: true,
			},
			components: {
				// The document head, so navigation swaps the document instead of
				// reloading it. Renders the framework's own head first — the slot
				// replaces rather than wraps, and dropping it would take the
				// canonical link and the `llms.json` alternate with it.
				Head: "./src/components/Head.astro",
				// An island is opt-in per page through `<TryIt />`, and this slot is
				// what keeps an ordinary page free of the framework runtime. No global
				// island is registered here, deliberately.
				Footer: "./src/components/Footer.astro",
			},
			head: [
				// A machine-readable summary of the documentation, served as data.
				// Offered rather than asserted as a standard: the convention exists as
				// a proposal with a small number of adopters, and this project does not
				// claim otherwise about it.
				{
					tag: "link",
					attrs: {
						rel: "alternate",
						type: "application/json",
						title: "ax-kit documentation index",
						href: "/llms.json",
					},
				},
			],
		}),
	],
	// Astro's content layer resolves the workspace package from source, which is
	// what the reference generator reads. The site itself imports the published
	// entry points, so a reader copies what a consumer would install.
	vite: {
		ssr: {
			noExternal: ["@ax-kit/core"],
		},
	},
});
