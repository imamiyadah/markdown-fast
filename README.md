# markdown-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/imamiyadah/markdown-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/imamiyadah/markdown-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

markdown-fast is a dependency-free Markdown renderer in a single ES module (`parse.js`) that produces, for every input string, exactly the HTML that marked 18.1.3 produces with default options (GFM on, breaks off) — byte for byte — while rendering considerably faster. Instead of driving the grammar with large regular expressions, it walks the document with hand-written line and character scanners: block structure is recognised line by line, inline text is consumed in a single index-driven pass, and emphasis is resolved by a delimiter-run engine over a masked copy of the source, so the common cases (long paragraphs, big generated README documents) avoid regex backtracking entirely. No dependencies, no build step, no caching between calls: `parse(markdown)` computes everything from its argument.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

The driver reads a JSON array of `{id, markdown}` cases from `$MAKEFUN_INPUT_DIR/cases.json` (default `/input`), renders each case with `parse()`, and writes the resulting HTML strings, in order, as a JSON array to `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`). It runs on Node 22+ (the driver is erasable TypeScript, executed directly by Node's type stripping). To use the renderer on its own, import it:

```js
import { parse } from "./parse.js";
const html = parse("# Hello\n\nSome *markdown* here.");
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=rwgn4ax4&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
