/**
 * The storefront.
 *
 * A server component, with no `"use client"` anywhere in this file. That is the
 * point of the example: the page renders on the server, the polyfill installs
 * from the `Polyfill` client component mounted in the layout, and the tools are
 * registered from an effect in the one client component below. Marking this
 * whole tree client-side to get an import to run in a browser would be the
 * mistake this file is arranged to avoid.
 *
 * `instrumentation.ts` is named here because it is the approach this does *not*
 * use. That hook runs on the server and never reaches the reader's document, so
 * it installs nothing in a browser; `install-polyfill.tsx` records the attempt
 * and the measurement. A reference example that taught the rejected approach
 * would be worse than one that taught nothing.
 *
 * Structured data for the products and their offers is emitted here rather than
 * in the client component, because it belongs to the rendered document and
 * should be in the server's output. The required properties for a `Product` and
 * its `Offer` are present; nothing speculative is added for surfaces that do not
 * document a requirement, because invalid structured data is worse than none —
 * it is a claim that is checkable and wrong.
 */

import type { PRODUCTS } from "../lib/tools";
import { ToolRegistration } from "./tool-registration";

interface Props {
	readonly products: typeof PRODUCTS;
}

export function Storefront({ products }: Props): React.JSX.Element {
	const structured = {
		"@context": "https://schema.org",
		"@type": "ItemList",
		itemListElement: products.map((product, index) => ({
			"@type": "ListItem",
			position: index + 1,
			item: {
				"@type": "Product",
				name: product.name,
				sku: product.sku,
				description: product.summary,
				offers: {
					"@type": "Offer",
					price: (product.price / 100).toFixed(2),
					priceCurrency: product.currency,
					availability: "https://schema.org/InStock",
				},
			},
		})),
	};

	/**
	 * The JSON-LD block, built here rather than inline in the markup.
	 *
	 * A plain `<script>` element, not the framework's script component: that
	 * component defers injection to the client, so the JSON-LD would arrive after
	 * the document had been parsed — and a consumer reading the served HTML, which
	 * is exactly what a structured-data consumer does, would find nothing.
	 * Server-rendered, present in the first byte of the response, is the whole
	 * requirement.
	 */
	const jsonLd = (
		<script
			id="structured-data"
			type="application/ld+json"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is script content; see the comment above.
			dangerouslySetInnerHTML={{
				// Every `<` is escaped, not only `</script`. JSON-LD routinely carries
				// URLs, and escaping the one character that can end the element is
				// cheaper than reasoning about which string shapes are safe.
				__html: JSON.stringify(structured).replace(/</g, "\\u003c"),
			}}
		/>
	);

	return (
		<main>
			<header>
				<h1>ax-kit reference storefront</h1>
				<p>
					A small shop that publishes its capabilities as typed tools. If your
					browser has the proposal natively you need install nothing; if it does
					not, the page below still works as a shop and installs the polyfill
					itself.
				</p>
			</header>

			<ToolRegistration />

			<section aria-labelledby="catalogue">
				<h2 id="catalogue">Catalogue</h2>
				<ul>
					{products.map((product) => (
						<li key={product.sku}>
							<h3>{product.name}</h3>
							<p>{product.summary}</p>
							<p>
								{(product.price / 100).toFixed(2)} {product.currency} ·{" "}
								<code>{product.sku}</code>
							</p>
						</li>
					))}
				</ul>
			</section>

			<section aria-labelledby="agent-surface">
				<h2 id="agent-surface">What an agent can do here</h2>
				<ul>
					<li>
						<code>search_products</code> — find products, optionally under a
						price bound
					</li>
					<li>
						<code>view_cart</code> — read the cart
					</li>
					<li>
						<code>add_to_cart</code> — add a quantity of one product
					</li>
					<li>
						<code>apply_coupon_code</code> — apply a discount
					</li>
					<li>
						<code>proceed_to_checkout</code> — place the order.{" "}
						<strong>Consequential:</strong> it spends money and cannot be
						undone, which is why it and only it is annotated.
					</li>
				</ul>
				<p>
					The cart mutations are reversible and cost nothing, so they are{" "}
					<em>not</em> annotated. Over-annotating trains everyone to dismiss
					confirmations, which is the failure mode the annotation exists to
					prevent.
				</p>
			</section>

			<section aria-labelledby="protocols">
				<h2 id="protocols">Commerce protocols</h2>
				<p>
					<strong>None implemented.</strong> AP2, ACP and Merchant Checkout are
					each early enough that a small example speaking one would be speaking
					a draft. What this shop publishes instead is the machine-readable
					profile AP2 expects, as data, at{" "}
					<a href="/agent-profile.json">/agent-profile.json</a>. The route at{" "}
					<a href="/api/catalog">/api/catalog</a> answers <code>501</code> on
					purpose: this shop does not speak ACP, and serving a well-formed
					payload from a route that implements none of it would be the claim
					this example refuses to make.
				</p>
			</section>

			{jsonLd}
		</main>
	);
}
