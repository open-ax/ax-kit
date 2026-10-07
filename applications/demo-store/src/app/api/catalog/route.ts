/**
 * The catalogue, in the shape the Agentic Commerce Protocol defines.
 *
 * Published as **data only**. This example does not implement ACP, and serving
 * a file in a protocol's shape is not implementing it. The distinction is worth
 * making explicitly in a reference implementation, because the failure mode is
 * exactly this: a reader sees a well-formed ACP endpoint and concludes the shop
 * speaks ACP, and builds against an interface that answers with `501`.
 *
 * What is honest here is the pairing with `/agent-profile.json`, which declares
 * no support at all. A reader arriving at either file learns the same thing.
 */

import { NextResponse } from "next/server";
import { PRODUCTS } from "../../../lib/tools";

/**
 * `501` rather than `200` with an empty body.
 *
 * The status code says "this shop does not speak this protocol" to anything
 * that checks, and says it to a human reading the network tab. A `200` would be
 * a claim.
 */
export function GET(): NextResponse {
	return NextResponse.json(
		{
			error: "not_implemented",
			supported: false,
			detail:
				"This storefront does not implement the Agentic Commerce Protocol. It publishes the shape of a catalogue as data for reference. See /agent-profile.json.",
		},
		{ status: 501 },
	);
}

/** Exported so a test can assert the catalogue is the same data the page renders. */
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
