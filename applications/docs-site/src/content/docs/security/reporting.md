---
draft: false
title: "Reporting a vulnerability"
description: "A private route to report a security problem and what happens to the report."
---

**Please do not open a public issue for a vulnerability.** A public issue is
visible to everyone before anyone has looked at it. A proof of concept in
one is a working exploit for whoever finds the thread first.

## The route

Private vulnerability reporting is enabled on the repository. Use
**GitHub's "Report a vulnerability"** button on the
[`open-ax/ax-kit`](https://github.com/open-ax/ax-kit/security/advisories/new) page,
which opens a private advisory visible only to the maintainer.

If you would rather not use GitHub's route, email **contactopenax@gmail.com** with
`[security]` in the subject.

The same route is served in the standard machine-readable form, so tooling can
find it without scraping this page:

```
GET /.well-known/security.txt
```

## What to include

| | |
|---|---|
| What an attacker can do | The capability, not the category |
| The version | The published version, or the commit |
| A reproduction | The smallest thing that shows it |
| What you expected instead | Usually more useful than the reproduction |

The last one is the row people skip. "I called `executeTool` with a tool
registered by another origin and it ran" tells a maintainer where to look;
"cross-origin tool execution" does not.

## What happens next

| Stage | What to expect |
|---|---|
| Acknowledgement | Within a few days |
| Assessment | Whether it is a real issue and what it affects |
| Fix | A fix, or an explanation of why the behaviour is correct |
| Credit | Named in the advisory unless you ask otherwise |

Before the first published release the project's stated posture is best-effort:
security fixes only, no backports to older versions. That is the right posture
for a pre-1.0 polyfill whose value is conformance. It is the same posture the
repository's own policy file states.

## What is not a vulnerability

Some of these look like findings and are not. Each is listed because the reasoning
is what a page author needs, not just a maintainer.

**A tool handler doing something dangerous.** The handler is your code, running
in your page's realm. The library cannot constrain it. The surface adds
discovery rather than capability.

**An agent invoking a tool you did not expect it to.** Every registered tool is
discoverable by any agent in the document. That is the design. Per-origin
restriction is `exposedTo`; per-tool restriction does not exist in the draft.

**A tool result containing untrusted content.** The `untrustedContentHint`
annotation is a declaration the library delivers and cannot enforce. What a
consumer does with a result is outside its reach. That is the
[threat model](/security/threat-model/), stated in advance.

**Tools not being visible across documents.** This implementation's registry is
per document, so a frame does not see a parent's tools. It is a known gap
against the specification and a narrowing one. See
[conformance](/reference/conformance/).