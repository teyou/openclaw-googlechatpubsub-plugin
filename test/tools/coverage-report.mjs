/**
 * Per-function line coverage for the outbound media upload code.
 *
 * Node's built-in reporter only prints whole-file percentages, and
 * dist/index.js is ~1450 lines of which the upload code is ~200. This script
 * runs the suite with the lcov reporter and re-slices the DA: records by the
 * line ranges of the four functions under test, so the reported number is
 * about the code actually under test.
 *
 *   node test/tools/coverage-report.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_PATH = path.join(PLUGIN_DIR, ".test-tmp", "bundle-under-test.mjs");
const LCOV = path.join(PLUGIN_DIR, ".test-tmp", "coverage.lcov");

execFileSync(
  process.execPath,
  [
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=.test-tmp/**",
    "--test-reporter=lcov",
    `--test-reporter-destination=${LCOV}`,
    "test/**/*.test.mjs",
  ],
  { cwd: PLUGIN_DIR, stdio: ["ignore", "ignore", "inherit"] }
);

const source = readFileSync(MODULE_PATH, "utf8").split("\n");

/** Locate a top-level declaration and the line before the next one. */
function rangeOf(startPattern, endPattern) {
  const start = source.findIndex((l) => startPattern.test(l));
  if (start === -1) throw new Error(`could not locate ${startPattern}`);
  const rel = source.slice(start + 1).findIndex((l) => endPattern.test(l));
  if (rel === -1) throw new Error(`could not locate end ${endPattern}`);
  return [start + 1, start + rel]; // 1-based, inclusive
}

const TARGETS = {
  "guessMimeType + MIME table": rangeOf(/^var MAX_UPLOAD_BYTES/, /^async function resolveOutboundMedia/),
  resolveOutboundMedia: rangeOf(/^async function resolveOutboundMedia/, /^async function uploadAttachment/),
  uploadAttachment: rangeOf(/^async function uploadAttachment/, /^async function sendMediaMessages/),
  sendMediaMessages: rangeOf(/^async function sendMediaMessages/, /^async function processMessageInPipeline/),
};

// Parse DA:<line>,<hits> and BRDA:<line>,<block>,<branch>,<taken>.
const hits = new Map();
const branches = new Map(); // line -> {total, taken}
let inRecord = false;
for (const line of readFileSync(LCOV, "utf8").split("\n")) {
  if (line.startsWith("SF:")) inRecord = line.includes("bundle-under-test.mjs");
  else if (line === "end_of_record") inRecord = false;
  else if (inRecord && line.startsWith("DA:")) {
    const [ln, count] = line.slice(3).split(",").map(Number);
    hits.set(ln, (hits.get(ln) || 0) + count);
  } else if (inRecord && line.startsWith("BRDA:")) {
    const [ln, , , taken] = line.slice(5).split(",");
    const n = Number(ln);
    const rec = branches.get(n) || { total: 0, taken: 0 };
    rec.total++;
    if (taken !== "-" && Number(taken) > 0) rec.taken++;
    branches.set(n, rec);
  }
}
if (hits.size === 0) throw new Error("no coverage records found for the module under test");

console.log("\nOutbound media upload — per-function line coverage");
console.log("(measured by node --experimental-test-coverage, lcov reporter)\n");
console.log("function                     lines  covered  line %  branch %  uncovered lines");
console.log("-".repeat(78));

let totalTracked = 0;
let totalCovered = 0;
let totalBr = 0;
let totalBrTaken = 0;
const uncoveredAll = [];
const partialBranches = [];

for (const [name, [from, to]] of Object.entries(TARGETS)) {
  let tracked = 0;
  let covered = 0;
  let br = 0;
  let brTaken = 0;
  const uncovered = [];
  for (let ln = from; ln <= to; ln++) {
    if (hits.has(ln)) {
      tracked++;
      if (hits.get(ln) > 0) covered++;
      else uncovered.push(ln);
    }
    const b = branches.get(ln);
    if (b) {
      br += b.total;
      brTaken += b.taken;
      if (b.taken < b.total) partialBranches.push(`${ln} (${b.taken}/${b.total})`);
    }
  }
  totalTracked += tracked;
  totalCovered += covered;
  totalBr += br;
  totalBrTaken += brTaken;
  uncoveredAll.push(...uncovered);
  const pct = tracked ? ((covered / tracked) * 100).toFixed(2) : "n/a";
  const bpct = br ? ((brTaken / br) * 100).toFixed(2) : "n/a";
  console.log(
    `${name.padEnd(28)} ${String(tracked).padStart(5)}  ${String(covered).padStart(7)}  ${pct.padStart(
      6
    )}  ${bpct.padStart(8)}  ${uncovered.join(", ") || "—"}`
  );
}

console.log("-".repeat(78));
const totalPct = (totalCovered / totalTracked) * 100;
const totalBrPct = totalBr ? (totalBrTaken / totalBr) * 100 : 100;
console.log(
  `${"TOTAL (functions under test)".padEnd(28)} ${String(totalTracked).padStart(5)}  ${String(
    totalCovered
  ).padStart(7)}  ${totalPct.toFixed(2).padStart(6)}  ${totalBrPct.toFixed(2).padStart(8)}`
);
if (partialBranches.length) {
  console.log(`\nPartially-taken branches: ${partialBranches.join(", ")}`);
}
console.log(`\nSource lines ${TARGETS["guessMimeType + MIME table"][0]}–${TARGETS.sendMediaMessages[1]} of ${path.relative(PLUGIN_DIR, MODULE_PATH)}`);
console.log(totalPct >= 90 ? "\nPASS: >= 90% line coverage of the target code.\n" : `\nFAIL: below the 90% target. Uncovered: ${uncoveredAll.join(", ")}\n`);

rmSync(LCOV, { force: true });
process.exit(totalPct >= 90 ? 0 : 1);
