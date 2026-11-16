// markdown-fast driver.
//
// Reads the competition case set from cases.json in the input directory,
// renders every case through parse(), and writes the HTML results as a
// JSON array (same order as the input) to html.json in the output
// directory. Directories come from MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// and default to /input and /output.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

interface InputCase {
  id: string;
  markdown: string;
}

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const caseFile: string = join(inputDir, "cases.json");
const cases: InputCase[] = JSON.parse(readFileSync(caseFile, "utf8")) as InputCase[];

const rendered: string[] = new Array(cases.length);
for (let idx = 0; idx < cases.length; idx++) {
  rendered[idx] = parse(cases[idx].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(rendered));
