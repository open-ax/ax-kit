/**
 * The root layout.
 *
 * Exists because every route needs one, and deliberately contains almost
 * nothing: the example's job is to be read and copied, and a root layout with
 * navigation chrome, a footer and a design system in it would make the page
 * itself harder to find. Everything a reader needs to understand is in
 * `page.tsx`.
 *
 * Note what is *not* here. No provider, no theme wrapper, no client boundary
 * around the tree. Exactly two components in this application are marked
 * `"use client"` — `Polyfill` and `ToolRegistration` — and each is marked where
 * it is used rather than hoisted into a wrapper here for the sake of one.
 */

import type { ReactNode } from "react";
import { Polyfill } from "./install-polyfill";

export default function RootLayout({
	children,
}: {
	readonly children: ReactNode;
}): React.JSX.Element {
	return (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
			</head>
			<body>
				{/*
				 * First child, so the polyfill's effect is registered before anything
				 * below it hydrates and before the browser paints. `Polyfill` renders
				 * nothing; it exists for the side effect, and why it is a client
				 * component rather than an `instrumentation.ts` hook is explained in
				 * `polyfill.tsx`.
				 */}
				<Polyfill />
				{children}
			</body>
		</html>
	);
}
