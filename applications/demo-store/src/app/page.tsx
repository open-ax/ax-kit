import type { Metadata } from "next";
import { PRODUCTS } from "../lib/tools";
import { Storefront } from "./storefront";

export const metadata: Metadata = {
	title: "ax-kit reference storefront",
	description:
		"A storefront that publishes its capabilities as typed tools for AI agents.",
};

/**
 * Commerce protocol support.
 *
 * Stated plainly because a storefront that implied support it does not have
 * would aim somebody else's integration work at the wrong interface.
 *
 * This example implements **no** commerce or payment protocol. All three below
 * are early enough that a small example implementing any of them would be
 * implementing a draft, and a reference implementation gets copied. What is
 * published instead is the machine-readable profile the least-effort one
 * expects — as data, from `public/agent-profile.json`, not as behaviour.
 *
 * - **Agent Payments Protocol (AP2)** — not implemented. The manifest at
 *   `/agent-profile.json` declares what this shop *would* accept, which is the
 *   part an integrator needs and the least code to get wrong.
 * - **Agentic Commerce Protocol (ACP)** — not implemented. The catalogue is
 *   exported in the shape ACP defines at `/api/catalog`, so a reader can see
 *   the format without this example pretending to speak it.
 * - **Merchant Checkout Protocol** — not implemented.
 *
 * The capabilities this example *does* have are WebMCP tool registration, which
 * is a different thing from any of the three above: it is a page describing
 * itself to an agent that is already present, not an agent acting on the shop's
 * behalf over a payment rail.
 */
export default function Page(): React.JSX.Element {
	return <Storefront products={PRODUCTS} />;
}
