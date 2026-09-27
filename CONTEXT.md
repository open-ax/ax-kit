# CONTEXT.md

The vocabulary of this codebase. Read it before naming anything.

If a term you need is missing, that is a signal: either you are reaching for
language the project does not use, or there is a real gap worth adding here.
Both are worth resolving before the name reaches a test or a public type.

Terms marked **[spec]** come from the WebMCP specification. Terms marked
**[ours]** are defined by this project. The distinction is load-bearing: a
change to a **[spec]** term is constrained by an upstream draft, while a change
to an **[ours]** term is ours to make.

---

## The surface

**ModelContext** **[spec]**
The object a page exposes on `document` that lets an agent discover and invoke
the page's tools. It is an `EventTarget`, so it emits change events as the
available set changes. This project polyfills it where the platform does not
provide it.

**Tool** **[spec]**
One named, typed capability a page offers: a name, a description, a JSON Schema
describing its arguments, and a callback that performs the work. A tool is the
unit an agent selects and calls.

**Registration** **[spec]**
Adding a tool to a `ModelContext`. Registration controls *availability* — whether
the tool can be discovered and called at all.

**Execution** **[spec]**
Invoking a registered tool with arguments. Execution controls *one invocation*.
Registration and execution have separate lifetimes and separate cancellation,
and conflating them is a bug.

**Input schema** **[spec]**
A JSON Schema document describing a tool's arguments, in a restricted subset.
It is serialised early and validated from `unknown` at every boundary it
crosses. Attacker-supplied schema content is untrusted input like any other.

**Consequential tool** **[spec]**
A tool whose effect a person would want to approve first — spending money,
irreversibly changing state, sending a message. Annotated so that a consumer
can require human confirmation before invoking it. Consequential is a property
of the *declared intent*, not a permission the tool itself enforces.

**Exposed to** **[spec]**
The origin or origins allowed to see and invoke a tool. Absent the annotation,
a tool is not exposed to anyone. This is the mechanism by which a page offers a
narrow surface rather than an open one.

**Agent** **[ours]**
Whatever is calling the tools. The project makes no assumption about what it is:
a browser extension, a test runner, a CLI, or a model in a loop. Design
decisions that assume a particular agent are the ones to be most suspicious of,
because they are the ones a different consumer will break.

**Pinned draft** **[ours]**
A specific dated version of the specification, recorded as a constant and
referenced in the README and every release note. The draft is re-dated
frequently and the surface moves underneath it, so an implementation that does
not record which draft it targets cannot be reviewed or trusted.

**Conformance** **[ours]**
Passing the specification's own test suite. A claim of conformance is only
meaningful against a named draft, and only meaningful as "zero unexpected
failures" — never as "everything is green", because the reference browser
itself does not pass everything.

---

## Worlds and trust

**Main world** **[spec]**
The page's own JavaScript realm. It shares the DOM with an extension's content
script but not the JavaScript heap.

**Isolated world** **[spec]**
An extension content script's realm. It shares the DOM, has its own globals, and
is the only place a browser extension can be trusted.

**Trusted tier** **[ours]**
The single place where an authorisation decision is made. Everything arriving
from a page is treated as hostile input regardless of how well-formed it is.

**Execution order is not a control** **[ours]**
"The page has not run yet" is not a security boundary. Other scripts run first,
back/forward-cache and prerestore paths exist, and a reference obtained later
wins. Order is an optimisation; it is never a control.

---

## Vocabulary to avoid

- **"Server"** for anything in this project. The page is not a server, and
  calling it one invites reasoning about a trust boundary that is not there.
- **"Action"** as a synonym for tool. It is the same thing; pick one. This
  project says *tool*.
- **"Polyfill"** for the whole package. The polyfill is one part of it. The
  registry, the validation, and the event dispatch are not polyfills and have
  their own failure modes.
- **"Safe"** as a security conclusion on its own. Say safe *against what*. A
  typed surface narrows what an agent can reach; it does not make untrusted
  content safe to read.

---

## Decisions

Architecture decisions are recorded in [`docs/adr/`](./docs/adr/). Each is a
short document explaining a choice that would be expensive to reverse, what was
rejected, and what would make it worth revisiting.

If a change contradicts one, say so explicitly rather than quietly overriding
it.
