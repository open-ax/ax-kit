/**
 * The catalogue, in the shape the Agentic Commerce Protocol defines.
 *
 * Kept here rather than in the route module because a route file may only export
 * the HTTP verbs Next.js routes are made of. Exporting a constant from one is a
 * type error under the framework's generated route types, and a named export that
 * typechecks today is a rule waiting to be tightened. It is imported by the route
 * and by the test, and by neither the page nor the browser.
 */

import { PRODUCTS } from "./tools";

/** One product, as an ACP-shaped offer. */
export const CATALOGUE: ReadonlyArray<Record<string, unknown>> = PRODUCTS.map(
	(product) => ({
		id: product.sku,
		title: product.name,
		description: product.summary,
		price: {
			amount: (product.price / 100).toFixed(2),
			currency: product.currency,
		},
	}),
);
