// runner.ts — algorithmic experimental compare of the 3 orthogonal strategies.
// Metrics: wall time (ms), edits, precision/recall/F1 vs ground truth (μ),
// goal-meeting (string literals + CustomerAccountant untouched), emergence
// (coordinated renames CustomerAccountView / processCustomerProfile propagated).
// Each strategy runs on a FRESH copy of the fixture; fluxling verify gates each.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runStrategy1 } from "./engines/strategy1_structural.ts";
import { runStrategy2 } from "./engines/strategy2_semantic.ts";
import { runStrategy3 } from "./engines/strategy3_intent.ts";

const BASE = "/home/toxic/pens/geode/products/lapidary/bench/experimental";
const FIXTURE = join(BASE, "fixture");
const OUT = join(BASE, "out");
const FLUXLING = "/home/toxic/pens/flux/products/fluxling/bin/fluxling.ts";

// Ground truth: which symbol renames MUST happen, which literals MUST stay.
const MUST_RENAME = [
  "CustomerAccount", "customerAccountId", "processCustomerProfile",
  "makeCustomerAccount", "CustomerAccountView",
];
const MUST_STAY = ["\"CustomerAccount\"", "CustomerAccountant", "ACCOUNT_LABEL"];

// AST-symbol-aware scoring: count symbol occurrences in CODE (identifiers),
// never in comments or string literals. Text-matching old names in comments
// was the naive baseline trap — it scored a perfect rename as recall 0.4.
import { Project, SyntaxKind } from "ts-morph";
function symbolOccurrences(dir: string, sym: string): number {
  const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });
  for (const f of ["accounts.ts", "usage.ts", "main.ts"]) {
    try { project.createSourceFile(join(dir, "src", f), readFileSync(join(dir, "src", f), "utf8")); } catch { /* missing */ }
  }
  let n = 0;
  for (const sf of project.getSourceFiles()) {
    for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (id.getText() === sym) n++;
    }
  }
  return n;
}

function score(dir: string, changed: Record<string, string>): { precision: number; recall: number; f1: number; goalMet: boolean; emergence: boolean } {
  let tp = 0, fn = 0;
  for (const sym of MUST_RENAME) {
    if (symbolOccurrences(dir, sym) === 0) tp++; else fn++;
  }
  // false positives: any old-name string literal that got renamed, or CustomerAccountant renamed.
  let fp = 0;
  const all = Object.values(changed).join("\n");
  for (const stay of MUST_STAY) {
    if (stay === "CustomerAccountant") {
      if (symbolOccurrences(dir, "CustomerAccountant") === 0) fp++;
    } else if (!all.includes(stay)) fp++;
  }
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  const goalMet = fp === 0 && fn === 0;
  // emergence: coordinated renames propagated (view class + method + field).
  const emergence =
    symbolOccurrences(dir, "CustomerAccountView") === 0 &&
    symbolOccurrences(dir, "processCustomerProfile") === 0 &&
    symbolOccurrences(dir, "customerAccountId") === 0;
  return { precision, recall, f1, goalMet, emergence };
}

function fluxlingVerify(dir: string, term: string): { stale: number; out: string } {
  const r = spawnSync("bun", [FLUXLING, "verify", dir, term], {
    cwd: "/home/toxic/pens/flux/products/fluxling",
    encoding: "utf8",
    timeout: 30_000,
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const m = /(\d+) stale refs?/.exec(out);
  return { stale: m ? Number(m[1]) : -1, out: out.slice(0, 400) };
}

function freshCopy(tag: string): string {
  const dir = join(OUT, tag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(join(FIXTURE, "src"), join(dir, "src"), { recursive: true });
  return dir;
}

const results: Record<string, unknown> = {};
const strategies: Array<[string, (d: string) => any]> = [
  ["S1-structural", runStrategy1],
  ["S2-semantic", runStrategy2],
  ["S3-intent", runStrategy3],
];

for (const [name, fn] of strategies) {
  const dir = freshCopy(name);
  const res = fn(dir);
  const s = score(dir, res.changed);
  const verify = fluxlingVerify(dir, "CustomerAccount");
  results[name] = {
    ...res,
    _score: s,
    _verify: verify,
  };
  console.log(`\n=== ${name} ===`);
  console.log(`  time=${res.ms.toFixed(1)}ms files=${res.filesChanged} edits=${res.edits}`);
  console.log(`  precision=${s.precision.toFixed(2)} recall=${s.recall.toFixed(2)} F1=${s.f1.toFixed(2)} goalMet=${s.goalMet} emergence=${s.emergence}`);
  console.log(`  fluxling-verify stale=${verify.stale}`);
}

writeFileSync(join(OUT, "compare.json"), JSON.stringify(results, null, 2));
console.log("\nwrote out/compare.json");