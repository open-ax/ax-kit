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
			title: "ax-kit",
			description:
				"A correct, tiny, dependency-free implementation of WebMCP's ModelContext.",
			// The repository's own brand mark rather than a copy, so the site cannot
			// drift from the README's image. `.gitignore` excludes the root `assets/`
			// from the site's own public directory, which is why this is not a bare
			// `/ax-mark.png`.
			logo: {
				src: "../../assets/ax-mark-light.png",
				replacesTitle: false,
			},
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
			// The self-hosted variable font, then the whole stylesheet. Both come
			// from the framework's own extension point rather than from a `<link>`
			// in a layout, so the stylesheet loads in the order the cascade needs —
			// after the framework's tokens, so its overrides win without a single
			// `!important`.
			//
			// Self-hosted rather than fetched from a font CDN: a documentation page
			// that makes a third-party request on load tells a third party who read
			// it, and this site makes no third-party requests at all.
			customCss: ["@fontsource-variable/hanken-grotesk", "./src/styles/ax.css"],
			components: {
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
/**
 * A syntax theme in pure grey.
 *
 * One rule set for both schemes: comments recede (faint, italic), literals sit
 * mid-ramp, and keywords and properties go to the ink. Berth's code themes are
 * the same idea — quiet tokens, no rainbow — except theirs give strings a
 * slate tint. This site's rule is white, black and grey, so the tint is gone
 * and the hierarchy is carried by lightness, weight and italics alone.
 *
 * Italic comments are the second channel: with hue unavailable, two greys of
 * similar value would be indistinguishable, and the italic is what tells a
 * comment from a string at a glance.
 */
function greyTheme({ name, type, bg, fg, muted, faint, value, key }) {
	const rules = [
		{
			scope: ["comment", "punctuation.definition.comment"],
			settings: { foreground: faint, fontStyle: "italic" },
		},
		{
			scope: [
				"string",
				"string.quoted",
				"string.template",
				"constant.other.symbol",
			],
			settings: { foreground: value },
		},
		{
			scope: ["constant.numeric", "constant.language", "constant.character"],
			settings: { foreground: value },
		},
		{
			scope: [
				"support.type.property-name",
				"meta.object-literal.key",
				"entity.name.tag",
				"variable.other.property",
			],
			settings: { foreground: key },
		},
		{
			scope: ["keyword", "storage", "storage.type", "keyword.operator.new"],
			settings: { foreground: key },
		},
		{
			scope: [
				"entity.name.function",
				"support.function",
				"entity.name.command",
			],
			settings: { foreground: fg },
		},
		{
			scope: ["variable.parameter", "variable.other.readwrite", "variable"],
			settings: { foreground: fg },
		},
		{
			scope: ["punctuation", "meta.brace", "keyword.operator"],
			settings: { foreground: muted },
		},
	];
	return {
		name,
		type,
		colors: { "editor.background": bg, "editor.foreground": fg },
		fg,
		bg,
		settings: [{ settings: { foreground: fg, background: bg } }, ...rules],
		tokenColors: rules,
	};
}

