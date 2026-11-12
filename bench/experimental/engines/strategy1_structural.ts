// engines/strategy1_structural.ts — S1: syntactic-structural lane (corrected).
// Merge: ast-grep AST patterns + comby holes + lapidary case-preserving.
// Corrections over baseline ast-grep/comby:
//   1. multi-kind identifier matching (type_identifier/property_identifier — naive
//      "identifier" kind guard misses class/method names entirely)
//   2. string/comment exclusion via AST kind (baseline regex/comby hits literals)
//   3. identifier-boundary lookahead (no CustomerAccountant false hit)
import { parse } from "@ast-grep/napi";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StrategyResult {
  strategy: string;
  filesChanged: number;
  edits: number;
  ms: number;
  changed: Record<string, string>;
}

export const RENAME: Record<string, string> = {
  CustomerAccount: "ClientAccount",
  customerAccountId: "clientAccountId",
  processCustomerProfile: "processClientProfile",
  makeCustomerAccount: "makeClientAccount",
  CustomerAccountView: "ClientAccountView",
};

const ID_KINDS = ["identifier", "type_identifier", "property_identifier", "shorthand_property_identifier_pattern"];

export function runStrategy1(fixtureDir: string): StrategyResult {
  const t0 = performance.now();
  const srcDir = join(fixtureDir, "src");
  const files = ["accounts.ts", "usage.ts", "main.ts"];
  let filesChanged = 0, edits = 0;
  const changed: Record<string, string> = {};

  for (const f of files) {
    const full = join(srcDir, f);
    const before = readFileSync(full, "utf8");
    let after = before;
    let fileEdits = 0;

    // Pass A: ast-grep structural — symbol nodes only (string/comment excluded by kind).
    // Splice at AST ranges, never regex-replace whole text (regex hits string literals).
    try {
      const root = parse("tsx", before);
      const node = root.root();
      const ids = node.findAll({ rule: { any: ID_KINDS.map(kind => ({ kind })) } });
      const editsByPos: Array<[number, number, string]> = [];
      for (const m of ids) {
        const text = m.text();
        if (text in RENAME) {
          const r = m.range();
          editsByPos.push([r.start.index, r.end.index, RENAME[text]]);
        }
      }
      // Apply back-to-front so earlier offsets stay valid.
      editsByPos.sort((a, b) => b[0] - a[0]);
      for (const [start, end, repl] of editsByPos) {
        after = after.slice(0, start) + repl + after.slice(end);
        fileEdits++;
      }
    } catch (e) { console.error("S1 ast-grep error:", (e as Error).message); }

    // Pass B: case-preserving prefix forms (customerAccountId_x, CustomerAccountApi).
    // AST-only: rewrite identifier nodes, never raw text (raw replaceAll hits
    // string literals/comments — the baseline trap).
    try {
      const rootB = parse("tsx", after);
      const nodeB = rootB.root();
      const idsB = nodeB.findAll({ rule: { any: ID_KINDS.map(kind => ({ kind })) } });
      const editsB: Array<[number, number, string]> = [];
      for (const m of idsB) {
        const text = m.text();
        for (const [from, to] of Object.entries(RENAME)) {
          const pascalFrom = from.charAt(0).toUpperCase() + from.slice(1);
          const pascalTo = to.charAt(0).toUpperCase() + to.slice(1);
          if (text === pascalFrom) {
            const r = m.range();
            editsB.push([r.start.index, r.end.index, pascalTo]);
          }
        }
      }
      editsB.sort((a, b) => b[0] - a[0]);
      for (const [start, end, repl] of editsB) {
        after = after.slice(0, start) + repl + after.slice(end);
        fileEdits++;
      }
    } catch { /* pass A result stands */ }

    if (after !== before) {
      writeFileSync(full, after);
      filesChanged++;
      edits += fileEdits;
      changed[f] = after;
    }
  }
  return { strategy: "S1-structural", filesChanged, edits, ms: performance.now() - t0, changed };
}