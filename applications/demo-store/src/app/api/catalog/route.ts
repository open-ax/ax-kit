/**
 * The catalogue route, which serves nothing.
 *
 * The route exists to answer with `501` and to say, in a machine-readable body,
 * that this shop does not speak the Agentic Commerce Protocol. The catalogue in
 * that shape is real and is built in `lib/catalogue.ts`, but it is **not served
 * here** — serving a well-formed ACP payload from an endpoint that implements
 * none of it is the failure this example is arranged to avoid, because a reader
 * sees a valid response and concludes the shop speaks ACP.
 *
 * So the two claims are kept apart on purpose: the data exists and is testable,
 * and the route declines to serve it. A previous version of this comment said the
 * route "publishes the catalogue as data", which described neither the code nor
 * what a request returns.
 *
 * What is honest here is the pairing with `/agent-profile.json`, which declares
 * no support at all. A reader arriving at either file learns the same thing.
 */

import { NextResponse } from "next/server";

/**
 * `501` rather than `200` with an empty body.
 *
 * The status code says "this shop does not speak this protocol" to anything that
 * checks, and says it to a human reading the network tab. A `200` would be a
 * claim.
 */
export function GET(): NextResponse {
	return NextResponse.json(
		{
			error: "not_implemented",
			supported: false,
			detail:
				"This storefront does not implement the Agentic Commerce Protocol. The catalogue in that shape exists in the repository as src/lib/catalogue.ts and is deliberately not served here. See /agent-profile.json.",
		},
		{ status: 501 },
	);
}
