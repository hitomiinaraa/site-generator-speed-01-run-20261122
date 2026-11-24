[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/hitomiinaraa/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/hitomiinaraa/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# Build a static site faster, 22 November 2026

A fast static site generator for the [make.fun bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122). It reads a site spec (site data, templates, and Markdown sources) and emits a complete static site: post and page HTML, index pages, tag pages, a tags index, and a build report.

This is v2, rebuilt from scratch for speed. On the kit practice set it runs about 4x faster than the reference generator (CPU time, measured with interleaved runs).

## How it works

- `main.ts` is the entrypoint: it reads the cases, runs the generator, and writes the output tree.
- `solve.js` is the whole generator in one dependency-free module. It is organised for speed:
  - front matter parsed by an index-based line scan, with the body returned as a slice;
  - Markdown rendered in a single pass with no token objects, dispatching on the first character of each line;
  - inline markup rendered in bulk plain-text runs, writing chunks straight into the output array;
  - templates parsed once into numbered node kinds, rendered through a frame stack instead of merged scope objects;
  - templates whose output never varies inside a case (only the fixed site, tags, and recent values) are rendered once and reused;
  - word counting fused into the Markdown step, so each body is walked once.

## Run

```sh
node main.ts
```

Input is read from `/input/cases.json` (or `MAKEFUN_INPUT_DIR`), output is written to `/output/answers.json` (or `MAKEFUN_OUTPUT_DIR`).
