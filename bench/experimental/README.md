# Experimental Compare — 3 Orthogonal Rename Strategies (2026-11-12)

Fixture: `bench/experimental/fixture/src/` — cross-file TypeScript domain
(`CustomerAccount` class, `customerAccountId` field, `processCustomerProfile`
method, `makeCustomerAccount` factory, shadow `CustomerAccountView` class, and
a decoy `CustomerAccountant` class with an overlapping-prefix method).
Ground truth: rename 5 symbols, keep 3 tokens (`"CustomerAccount"` literal,
`CustomerAccountant`, `ACCOUNT_LABEL`) untouched. Emergence = coordinated
renames (view class + method + field) all propagated.

## Verdict

| strategy | lane | ms | files | edits | precision | recall | F1 | goalMet | emergence |
|---|---|---|---|---|---|---|---|---|---|
| **S1-structural** | ast-grep AST + case styles | **1.4** | 3 | 29 | 1.00 | 1.00 | **1.00** | ✅ | ✅ |
| **S2-semantic** | ts-morph language service + RENAS co-rename | 205.0 | 3 | 10 | 1.00 | 1.00 | **1.00** | ✅ | ✅ |
| **S3-intent** | fluxling LLM + Declared Scope | 5618.3 | 3 | 3 | 1.00 | 1.00 | **1.00** | ✅ | ✅ |

## Interpretation

- **S1 (1.4ms)** — syntactic, ~4000× faster than the LLM lane. Achieves the
  same perfect result ONLY after the two corrections that baseline ast-grep /
  regex / comby get wrong: (1) multi-kind identifier matching
  (`type_identifier`/`property_identifier` — a naive `identifier` kind guard
  misses class and method names entirely), and (2) AST-range splicing instead
  of regex text replacement (regex hits string literals and comments).
- **S2 (205ms)** — semantic, language-service references. The reference graph
  makes string-literal safety automatic. Needs the RENAS coordination
  boundary: a same-named method on an UNRELATED class (`CustomerAccountant`)
  is a different symbol — the baseline ts-morph rename would have clobbered
  it (we saw the fp before adding the owner-class guard).
- **S3 (5.6s)** — intent/LLM. Same F1 but 4000× slower and non-deterministic;
  the Declared Scope (exact symbol map + literal guards) is what keeps it
  correct. fluxling's `apply` verify gate scans the whole pens tree (argos
  corpus recall), so it exits 1 on unrelated stale refs even when the fixture
  edit succeeded — the gate must be fixture-scoped for bench use.

## Corrections over the hoisted baselines (the "too baseline" traps)

1. **Naive `identifier` kind guard** — tree-sitter TS uses
   `type_identifier` (classes) and `property_identifier` (methods); a single
   `kind: identifier` rule matched only local variables (1 of ~8 symbols).
2. **Regex text replace** — `\bCustomerAccount\b` hits `"CustomerAccount"`
   string literals and comments; must splice at AST node ranges.
3. **Unbounded symbol rename** — language-service rename of a method name
   propagates to every class with that method, including unrelated decoys;
   needs the RENAS relation-cost boundary (paper 2408.09716).
4. **Text-based change detection** — `includes("ClientAccount")` false-positives
   on the goal text in comments; detection must be symbol-based
   (`class ClientAccount`).
5. **Text-based verify gate** — fluxling-verify counts old-name text in
   comments/literals as stale; goal-meeting needs symbol-aware scoring.

## Papers consulted (Nov 2026)

- **2601.00482** Multi-Agent Coordinated Rename Refactoring (JetBrains Research
  + NEC, updated 10 Nov 2026) — Declared Scope, coordination boundary.
- **2408.09716** RENAS (salab/RENAS, cloned) — heap-ordered co-rename
  propagation with relation costs.
- **2608.23377** Fine-Grained Move Refactorings (Aug 2026).
- **2602.03712** SWE-Refactor benchmark (Feb 2026).
- **2511.04824** Agentic Refactoring empirical study (Nov 2026).

## Reproduce

```sh
cd /home/toxic/pens/geode/products/lapidary/bench/experimental
bun runner.ts            # fresh fixture per strategy, scores, fluxling verify
cat out/compare.json     # machine-readable results
```