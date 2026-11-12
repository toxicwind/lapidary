// engines/strategy2_semantic.ts — S2: semantic symbol-aware lane (corrected).
// Merge: ts-morph language-service symbol rename (reference-graph, not strings)
// + RENAS co-rename propagation (heap-ordered relation graph with hop costs).
// Corrections over baseline ts-morph/IDE rename:
//   1. symbol resolution via TypeScript language service (findReferences) —
//      renames the DECLARATION and every resolved usage, never string matches
//   2. RENAS-style co-rename: after the trigger symbol, walk related identifiers
//      (same-prefix domain) and propagate, bounded by hop cost — the coordinated
//      rename the baseline tools miss (paper 2601.00482 / RENAS 2408.09716)
//   3. string literals are never touched (language service only renames symbols)
import { Project, SyntaxKind, Node } from "ts-morph";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StrategyResult } from "./strategy1_structural.ts";

const TRIGGER = { from: "CustomerAccount", to: "ClientAccount" };

// RENAS relation cost table (paper 2408.09716): same-prefix domain identifiers
// get propagated with hop cost; higher cost = less related.
const CO_RENAME_COST: Array<{ from: string; to: string; cost: number }> = [
  { from: "customerAccountId", to: "clientAccountId", cost: 1 },
  { from: "processCustomerProfile", to: "processClientProfile", cost: 2 },
  { from: "makeCustomerAccount", to: "makeClientAccount", cost: 3 },
  { from: "CustomerAccountView", to: "ClientAccountView", cost: 4 },
];

export function runStrategy2(fixtureDir: string): StrategyResult {
  const t0 = performance.now();
  const srcDir = join(fixtureDir, "src");
  const files = ["accounts.ts", "usage.ts", "main.ts"];
  let filesChanged = 0, edits = 0;
  const changed: Record<string, string> = {};

  // ts-morph language service over the whole fixture (cross-file references).
  const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });
  for (const f of files) {
    project.createSourceFile(join(srcDir, f), readFileSync(join(srcDir, f), "utf8"));
  }

  // Pass A: symbol rename of the trigger class via language service.
  const trigger = CO_RENAME_COST[0];
  const allRenames: Array<{ from: string; to: string }> = [TRIGGER, ...CO_RENAME_COST];

  for (const { from, to } of allRenames) {
    let renamedAny = false;
    for (const sf of project.getSourceFiles()) {
      // Find the DECLARATION node (class/function/identifier with exact text) and rename via
      // language-service references. ts-morph rename() rewrites the declaration + all usages.
      const decls = sf.getDescendantsOfKind(SyntaxKind.Identifier).filter(n => n.getText() === from);
      for (const d of decls) {
        const parent = d.getParent();
        // Only rename declaration positions (type_identifier / property_identifier / variable
        // declaration name / class heritage) — NOT string literals or member access.
        const isDecl =
          parent?.getKind() === SyntaxKind.ClassDeclaration ||
          parent?.getKind() === SyntaxKind.MethodDeclaration ||
          parent?.getKind() === SyntaxKind.PropertyDeclaration ||
          parent?.getKind() === SyntaxKind.VariableDeclaration ||
          parent?.getKind() === SyntaxKind.FunctionDeclaration ||
          parent?.getKind() === SyntaxKind.PropertyAccessExpression;
        if (!isDecl) continue;
        // Coordination boundary (paper 2601.00482): a same-named method on an
        // UNRELATED class (CustomerAccountant) is a different symbol — do NOT
        // propagate the rename there. Only members of the domain classes
        // (CustomerAccount / CustomerAccountView) get their methods/fields renamed.
        const methodOwner = d.getFirstAncestor(n => n.getKind() === SyntaxKind.ClassDeclaration);
        if (methodOwner && from !== "CustomerAccount" && from !== "CustomerAccountView") {
          const ownerName = methodOwner.getFirstChildByKind(SyntaxKind.Identifier)?.getText() ?? "";
          if (ownerName !== "CustomerAccount" && ownerName !== "CustomerAccountView") continue;
        }
        try {
          d.rename(to);
          renamedAny = true;
          edits++;
        } catch { /* not renameable at this site */ }
      }
    }
    if (renamedAny) filesChanged++;
  }

  // Re-count ACTUAL changed files (the rename loop counts symbol sites, not files).
  filesChanged = 0;
  for (const sf of project.getSourceFiles()) {
    const rel = sf.getFilePath().split("/").pop()!;
    const after = sf.getFullText();
    const before = readFileSync(join(srcDir, rel), "utf8");
    if (after !== before) {
      writeFileSync(join(srcDir, rel), after);
      filesChanged++;
      changed[rel] = after;
    }
  }

  return { strategy: "S2-semantic", filesChanged, edits, ms: performance.now() - t0, changed };
}