# `@ax-kit/cli`

In-page contract audit for `document.modelContext` under headless Chromium.

Pinned draft: WebMCP Draft Community Group Report, 29 September 2026, from
the W3C Web Machine Learning Community Group. The pin is exported as
`SPEC_VERSION` from `@ax-kit/core` and repeated in every release note.

Everything here is ours, not the draft's: the draft defines the page
surface, while this command grades how well one page uses it.

## Use

```sh
ax-kit audit https://shop.example
```

Experimental stub: the `ax-kit audit` command currently scores a fixed
empty snapshot and exits non-zero, it does not drive a live page yet.
Live results require `auditUrl()` with a headless browser.

Scores typed tools, schema validity, consequential coverage, read-only
sanity, exposure discipline, character budgets (500/150/30/1.5K),
feature-policy posture, and the origin-keyed cluster precondition.

In-page contract audit: edge sees discoverability, journey agents see
behavior, this audit sees the in-page contract. Never an unqualified
readiness score.
