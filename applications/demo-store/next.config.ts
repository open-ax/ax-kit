import type { NextConfig } from "next";

/**
 * The permission policy the tool surface is gated behind.
 *
 * A page that installs a tool surface must declare that it does. Without this
 * header the example works on localhost and silently does nothing in a real
 * deployment, which is the single most common way an example like this
 * misleads — the developer machine is usually loopback, and the platform treats
 * loopback as potentially trustworthy.
 *
 * The policy is declared through the framework's supported configuration rather
 * than by hand-rolling middleware, so it is part of the build output rather
 * than something that can be forgotten when the route changes.
 *
 * `tools=(self)` is the narrow form and the correct one: the page offers its
 * tools to itself. `self` and no other origin means a cross-origin embedder
 * cannot see them, which is the default posture this storefront wants — see the
 * note in `src/lib/tools.ts` about why the example does not demonstrate
 * `exposedTo` at the same time.
 */
const permissionsPolicy = "tools=(self)";

const nextConfig: NextConfig = {
	reactStrictMode: true,
	async headers() {
		return [
			{
				// Every route, not just the storefront page. A tool surface on a
				// partial route that lacks the policy is the confusing case, where
				// the feature appears to work on one page of the site and not
				// another.
				source: "/:path*",
				headers: [
					{ key: "Permissions-Policy", value: permissionsPolicy },
					// The storefront serves no third-party content, so it can promise
					// not to embed any. Declaring this is not a privacy feature in
					// itself — it is a claim the browser then enforces, which is the
					// only kind worth making.
					{ key: "X-Frame-Options", value: "DENY" },
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{
						key: "Referrer-Policy",
						value: "strict-origin-when-cross-origin",
					},
				],
			},
		];
	},
};

export default nextConfig;
