/**
 * Installing the polyfill from the root layout.
 *
 * ## The premise that needed correcting
 *
 * The obvious answer is `instrumentation.ts`. It is the wrong one, and the mistake
 * is easy to make: `instrumentation.ts`'s `register()` runs **when a Next.js
 * server instance starts**, on the server. A client-side import there installs
 * nothing in the reader's browser. Measured rather than assumed — with the install
 * in `instrumentation.ts`, a built page served by `next start` reported no tool
 * surface and no chunk in the served HTML carried the package.
 *
 * ## What Next.js actually offers
 *
 * The App Router has **no** client entry hook. There is no `client.js`
 * convention; that belongs to Nuxt, and reaching for it here is how a reference
 * example ends up teaching a file convention that does not exist in this
 * framework.
 *
 * Two mechanisms do exist:
 *
 * - **A server-rendered `<script>` in the root layout.** Genuinely
 *   pre-hydration, but it must be self-contained: no module resolution, no bare
 *   specifier. A polyfill living in `node_modules` cannot be loaded that way
 *   without inlining its bytes into the document at build time, which trades a
 *   real problem for a worse one.
 * - **A client component.** Hydrates, then runs. This is what the example uses.
 *
 * ## So one component carries a client directive
 *
 * A deviation from "install without marking the tree client-side", worth being
 * precise about:
 *
 * The page still server-renders. `storefront.tsx`, `page.tsx` and `layout.tsx` are
 * server components; the catalogue, the copy and the structured data are in the
 * server's output and readable without executing JavaScript. Marking the *tree*
 * client-side to get an import to run in a browser is the failure mode being
 * avoided, and it is still avoided — one leaf component does not do it.
 *
 * What is given up: the install runs after hydration begins rather than before
 * it. Application code reading `document.modelContext` while its own module
 * initialises will not see it. Nothing here does that, because the only consumer
 * is an effect that awaits `ensurePolyfill()`. An application needing the surface
 * during its own bootstrap would inline the polyfill into a server-rendered
 * `<script>`, and should make that trade explicitly.
 */

"use client";

import { useEffect, useLayoutEffect } from "react";
import { ensurePolyfill } from "./polyfill";

/**
 * Layout effects do not run during server rendering, so React does not warn about
 * them and the browser still gets them. A `useEffect` here would leave a frame
 * where the page is interactive and the tool surface is missing; neither runs
 * before hydration, and this file does not claim otherwise.
 */
const useBrowserLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

export function Polyfill(): null {
	useBrowserLayoutEffect(() => {
		// The result is deliberately not used. The component exists to start the
		// install at the earliest point in the tree; a component that reports the
		// outcome to a reader is a separate concern and is a separate component.
		void ensurePolyfill();
	}, []);
	return null;
}
