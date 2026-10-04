---
"@ax-kit/core": minor
"@ax-kit/cli": minor
---

Stop refusing to operate on a document that is not origin-keyed. The 2 October
2026 draft removed the agent cluster precondition from `registerTool`,
`getTools` and `executeTool`, so a page whose `document.domain` has drifted is
now served normally instead of rejecting with a `SecurityError` and logging a
`WebMCP unavailable` warning. `ax-kit audit` no longer reports an
`origin-keyed cluster` finding, because a conformant site was being failed for a
requirement that no longer exists. Origin restrictions on which origins may see
and invoke a given tool are a separate mechanism and are unchanged.