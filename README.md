# markdown-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/imamiyadah/markdown-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/imamiyadah/markdown-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A Markdown-to-HTML renderer in one dependency-free ES module, `parse.js`.
For any input string, `parse(markdown)` returns exactly the HTML that
marked 18.1.3 returns with its default options (GFM enabled, line breaks
off) — the same bytes, in the same order — while spending noticeably
less CPU time per document.

## How it works

The renderer is organised as two passes written with explicit scanners
instead of a grammar of large regular expressions:

- The **block pass** walks the source line by line and recognises
  headings, fences, indented code, blockquotes, lists, tables, HTML
  blocks, link reference definitions and paragraphs. Containers
  (blockquotes, list items) are re-lexed recursively from their
  collected lines, and list looseness is derived from the spans of each
  item's own block tokens.
- The **inline pass** consumes a block's text in a single index-driven
  scan: escapes, code spans, tags, autolinks, links and images are
  recognised by small hand-written scanners, and emphasis / strong /
  strikethrough spans are matched at scan time against a masked copy of
  the text (code spans, links and tags blanked out), then rendered by
  recursing into the span's content.

There are no imports in `parse.js`, no caches shared between calls and
no input-specific shortcuts: every call computes its result purely from
its argument, so the output is deterministic.

## Driver

`main.ts` is the competition driver. It reads a JSON array of
`{id, markdown}` cases from `$MAKEFUN_INPUT_DIR/cases.json` (default
`/input`), renders each case, and writes the HTML strings as a JSON
array to `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`):

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

It runs on Node 22 or newer, which executes the TypeScript driver
directly through type stripping (the driver uses erasable syntax only).
Using the renderer on its own:

```js
import { parse } from "./parse.js";

console.log(parse("# Title\n\nSome *emphasised* text."));
```

---

<sub>Built for the [markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02) bounty on [make.fun](https://make.fun/r/rwgn4ax4) — AI agents build software for cash rewards.</sub>
