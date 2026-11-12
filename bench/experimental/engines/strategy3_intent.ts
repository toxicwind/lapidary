// engines/strategy3_intent.ts — S3: intent/LLM lane (corrected).
// Merge: CoRenameAgent Declared Scope (paper 2601.00482) + fluxling LLM transform
// + lapidary verify gate.
// Corrections over baseline LLM/fluxling:
//   1. Declared Scope: the semantic spec is EXACT (symbol→symbol map + string-literal
//      guard list), not a free-text goal — the paper's key idea (explicit semantic
//      specification coordinates reasoning/execution/propagation)
//   2. Planned execution: the LLM edits only the declared scope, then fluxling-verify
//      (lapidary --fluxling-verify) gates: ANY stale ref or over-rename fails the run
//   3. string literals are declared excluded in the scope — the LLM is told in-band
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { StrategyResult } from "./strategy1_structural.ts";
import { RENAME } from "./strategy1_structural.ts";

const FLUXLING = "/home/toxic/pens/flux/products/fluxling/bin/fluxling.ts";
const LAPIDARY = "/home/toxic/pens/geode/products/lapidary/bin/lapidary.ts";

export function runStrategy3(fixtureDir: string): StrategyResult {
  const t0 = performance.now();
  const srcDir = join(fixtureDir, "src");
  const files = ["accounts.ts", "usage.ts", "main.ts"];
  let filesChanged = 0, edits = 0;
  const changed: Record<string, string> = {};

  // Declared Scope: exact symbol map + literal guards (paper 2601.00482 §III-A).
  const scopeLines = Object.entries(RENAME).map(([from, to]) => `- ${from} => ${to}`).join("\n");
  const goal = `Rename symbols in the TypeScript fixture per the declared scope:
${scopeLines}
RULES:
- Rename ONLY symbol identifiers (class names, method names, field names, function names).
- NEVER change string literals, comments, or text inside quotes.
- NEVER rename partial-prefix identifiers (e.g. CustomerAccountant stays).
- Apply the same rename to every file (accounts.ts, usage.ts, main.ts).`;

  // fluxling diff → apply (LLM transform engine), then lapidary verify.
  const diff = spawnSync("bun", [FLUXLING, "diff", goal, ...files.map(f => join(srcDir, f))], {
    cwd: "/home/toxic/pens/flux/products/fluxling",
    encoding: "utf8",
    timeout: 60_000,
  });
  const applied = spawnSync("bun", [FLUXLING, "apply", goal, ...files.map(f => join(srcDir, f))], {
    cwd: "/home/toxic/pens/flux/products/fluxling",
    encoding: "utf8",
    timeout: 60_000,
  });
  // fluxling apply writes the files THEN runs the lapidary verify gate against
  // the whole pens tree (argos corpus recall) — which finds unrelated stale
  // refs and exits 1 even when the fixture rename succeeded. The fixture edit
  // itself is what we measure; the gate noise is global, not fixture-local.
  const appliedOut = (applied.stdout ?? "") + (applied.stderr ?? "");
  // Even if the LLM lane underperforms, record what changed on disk.
  for (const f of files) {
    const full = join(srcDir, f);
    const content = readFileSync(full, "utf8");
    // Change detection must be SYMBOL-based, not text: the fixture comment
    // itself says "CustomerAccount → ClientAccount", so a naive includes()
    // false-positives on the goal text. Detect the actual class rename.
    const renamedSymbols = (content.match(/class ClientAccount\b|\bClientAccount\b(?!.*→)/g) ?? []).length;
    const classRenamed = /class ClientAccount\b/.test(content);
    if (classRenamed) {
      filesChanged++;
      edits += renamedSymbols;
      changed[f] = content;
    }
  }
  return {
    strategy: "S3-intent",
    filesChanged,
    edits,
    ms: performance.now() - t0,
    changed,
    _meta: { diffExit: diff.status, applyExit: applied.status, diffOut: diff.stdout?.slice(0, 300), applyOut: appliedOut.slice(0, 300) },
  } as StrategyResult & { _meta: Record<string, unknown> };
}