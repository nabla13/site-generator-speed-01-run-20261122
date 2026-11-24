# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/nabla13/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/nabla13/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0 (make.fun's own static site
generator), built for the
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
bounty: same answers as the reference on every case, byte for byte, in less
CPU time.

## How it is faster

- **Hand-rolled parsers** driven by first-character dispatch — no regexes in
  the hot paths (front matter, Markdown blocks, template tags).
- **Fused Markdown lexer + renderer**: each source line is visited once and
  rendered straight into the output, with no token objects in between.
- **Batched inline rendering**: plain-text spans between markup go through
  one escape each, and the escape returns its input unchanged when the span
  holds no special character, so most text costs no copying at all.
- **Per-case caches** for slugs and long dates (nothing is carried from one
  case to the next).
- **Flat-instruction template interpreter** with a scope stack; one vars
  object per `for` is reused across its iterations.
- **Word counts** are accumulated while lexing instead of re-scanning the
  body.

## Layout

- `solve.js` — the generator (`run(input)`), dependency-free ES module.
- `main.ts` — the driver: reads `/input/cases.json`, writes
  `/output/answers.json`.
- `package.json` — `{"type": "module"}` so `solve.js` loads as ESM.

---

<sub>Entered on [make.fun](https://make.fun/?ref=t93gzdgw&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
