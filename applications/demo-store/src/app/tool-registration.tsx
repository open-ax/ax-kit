/**
 * The one component that registers the tools and reports the result.
 *
 * It exists because registration is a promise the page has to outlive, and a
 * promise belongs in an effect rather than in render. The effect returns the
 * function that removes all five tools, so registration and removal have the same
 * lifetime and nothing is left pending.
 *
 * The state here is for a human reading the page. An agent does not need it; an
 * agent calls `getTools()`.
 *
 * Note what this component does *not* do: it does not install the polyfill by
 * reading `document.modelContext` once. It awaits the shared install instead,
 * which is a separate module and a separate concern — see `polyfill.ts` for why
 * that distinction is load-bearing rather than tidy.
 */

"use client";

import type { ModelContext } from "@ax-kit/core";
import { useEffect, useState } from "react";
import { registerStorefrontTools } from "../lib/register";
import { TOOL_NAMES } from "../lib/tools";
import { ensurePolyfill } from "./polyfill";

type Surface = "installing" | "ready" | "unsupported";

export function ToolRegistration(): React.JSX.Element {
	const [surface, setSurface] = useState<Surface>("installing");
	const [listing, setListing] = useState<ReadonlyArray<string>>([]);

	useEffect(() => {
		// `cancelled` rather than relying on React 18's automatic effect cleanup,
		// because the cleanup here has to be able to distinguish "unmounted" from
		// "the install is still in flight" — and a setState after unmount is the
		// warning React no longer prints.
		let cancelled = false;

		// The disposer returned by `registerStorefrontTools`, or `undefined` until
		// registration resolves.
		//
		// Discarding this was a real leak with a visible symptom, not a tidy-up
		// point. `next.config.ts` sets `reactStrictMode: true`, so in development
		// React mounts, unmounts and mounts again. The second registration then
		// collided with the first on the same names, the registry refused it as a
		// duplicate, and the `.catch` below reported "unsupported" — a page whose
		// tool surface worked perfectly telling the reader it did not exist.
		//
		// Cleanup can run at any of three moments, and each needs different
		// handling. Before the install resolves, nothing is registered and the
		// `cancelled` checks below return before `registerStorefrontTools` is
		// ever called. During registration, `dispose` arrives after the cleanup
		// has run, so the check after the assignment removes them. After
		// registration, `disposeWhenAvailable` has something to call.
		let dispose: (() => void) | undefined;

		void ensurePolyfill()
			.then(async (context: ModelContext | undefined) => {
				if (cancelled) {
					return;
				}
				if (context === undefined) {
					// The platform refused the surface: an insecure context, or a
					// `tools` Permissions Policy feature this document does not allow.
					// The page stays a shop. That degradation is a requirement of the
					// example rather than a fallback — most readers will not have the
					// tool surface, and a broken page would be the wrong answer for
					// most of them.
					setSurface("unsupported");
					return;
				}
				dispose = await registerStorefrontTools(context);
				if (cancelled) {
					// Cleanup ran while the five registrations were in flight. Remove
					// them now rather than leaving them attached to a document nobody
					// is reading.
					dispose();
					return;
				}
				const tools = await context.getTools();
				if (cancelled) {
					return;
				}
				setListing(tools.map((tool) => tool.name));
				setSurface("ready");
			})
			.catch(() => {
				if (!cancelled) {
					setSurface("unsupported");
				}
			});

		return () => {
			cancelled = true;
			dispose?.();
		};
	}, []);

	return (
		<section aria-labelledby="surface-status">
			<h2 id="surface-status">Tool surface</h2>
			{surface === "installing" && <p>Preparing the tool surface…</p>}
			{surface === "unsupported" && (
				<p>
					This document has no tool surface. It may be served over plain HTTP,
					or the deployment may not declare the <code>tools</code> permission
					policy. The shop above works either way — an agent-facing tool surface
					is additive, not required to use the page.
				</p>
			)}
			{surface === "ready" && (
				<>
					<p>
						An agent can see {listing.length} tools on this page:{" "}
						<code>{listing.join(", ")}</code>
					</p>
					<p>
						Compare with the declared vocabulary:{" "}
						<code>{TOOL_NAMES.join(", ")}</code>. These must be identical, and a
						test asserts that they are — one set of names, used the same way in
						this storefront, in the documentation, and in every example.
					</p>
				</>
			)}
		</section>
	);
}
