---
sidebar_position: 2
---

# Contributing

Contributions are welcome.

## How to contribute

There is nothing ShojiWM-specific here — just follow the **standard GitHub
contribution flow**:

1. Fork [the repository](https://github.com/bea4dev/ShojiWM).
2. Create a branch for your change.
3. Make and commit your change (build and try it locally — see
   [Development](./developing.md)).
4. Open a pull request against `main`.

## What gets merged

Patches are judged on **maintainability — readability and practicality** — not on
how they were produced.

**AI-assisted patches are welcome.** It does not matter whether you wrote the
code by hand or with help from an AI tool: if the result is readable, useful, and
maintainable, it has a high chance of being accepted.

A few things that help a patch get merged:

- Match the style and conventions of the surrounding code.
- Keep each pull request focused on one change.
- Remember that ShojiWM spans both Rust and TypeScript. Changes to the
  server-side-decoration (SSD) path often need matching updates on both sides —
  the Rust wire-format bridge and the TypeScript serialization.
