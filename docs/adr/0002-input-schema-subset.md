# 2. Input-schema subset and storage discipline

Date: 2026-09-28
Status: Accepted

## Context

The pinned draft requires an input schema on registration, stores it as a
string, and re-parses it on listing — but it does not define how a polyfill
validates schema documents or the arguments checked against them. An
unrestricted validator that silently passes what it does not understand is
worse than one that rejects clearly, and attacker-supplied schema content is
untrusted input like any other.

## Decision

Enforce a restricted subset with our own guards, documented as ours and never
cited as draft-derived:

- Dangerous keys (`__proto__`, `constructor`, `prototype`) rejected at any
  depth, including inside unknown keywords.
- Caps: depth 10, 500 total keys, 65,536 serialized characters.
- Keywords understood: `type` (object/array/string/number/integer/boolean/
  null), `properties`, `required`, `items` (single-schema form),
  `enum`, `additionalProperties` (boolean form), `description`, `title`.
  Unknown keywords are ignored as vocabulary but still swept for safety.
- Storage: serialized at registration, stored as a string (`undefined` when
  absent), re-parsed on every read, so no live caller object is ever retained
  and listings hand out fresh deep copies.
- Arguments re-validated against the current definition immediately before
  the callback runs, so an unregister/re-register race cannot check new
  arguments against an old schema.

## Consequences

Schemas outside the subset fail closed with `TypeError` at registration;
arguments that do not match fail with `TypeError` at validation, surfacing to
callers as `UnknownError` through the completion path. The Standard Schema
shape consumed structurally is declared locally in `standard-schema.ts`; the
full validation library arrives only in a deferred consumer, never here.

## Revisit when

The draft defines polyfill-side validation, or a consumer needs a keyword
outside the subset with tests proving the gap.
