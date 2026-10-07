/**
 * The content collections.
 *
 * Explicit, because Astro 5+ requires a content config and its absence produces
 * a build that fails on the sidebar several steps from the cause.
 *
 * ## The schema is not optional
 *
 * `docsSchema()` carries the defaults every page relies on, and three of them
 * fail *silently* without it:
 *
 * - **`head: []`** — without the default, `getHead` calls `.some` on `undefined`
 *   and the build crashes on the first page. That one is loud.
 * - **`draft: false`** — without it, entries without an explicit `draft` are
 *   filtered out of production builds. That one is silent: the build reports
 *   success, Pagefind reports one HTML file, and the site ships nothing but a 404.
 * - **`pagefind: true`**, **`template: "doc"`**, and the rest are conveniences
 *   whose absence shows up as a page that renders wrongly rather than not at all.
 *
 * So `draft: false` is set explicitly in every page's frontmatter as well as
 * defaulted here. Belt and braces, and the redundancy costs one line per page
 * against a build that can silently produce an empty site.
 */

import { defineCollection } from "astro:content";
import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
	i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
