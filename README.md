# lapidary — geode's transform + detect engine (all-Bun)

`lapidary` cuts & polishes product names across a repo using `.lapidary` rule
files — and, since the orchid merge (2026-10-31), also **detects** anomalies
over the estate log corpus.

## Rename engine (transform rule family)

`word | substr | regex | case | comby` rules, file scoping (`includePaths` /
`ignorePaths`), cross-file `exclude` armor, case-preserving transforms, ast-grep
& renovate & comby & sed borrow, reversible `.lapidary-undo.jsonl` journal.

```sh
bun bin/lapidary.ts --repo <dir> --rules <a.lapidary,b.lapidary> [--dry-run] [--commit "msg"] [--undo]
```

## Detect rule family (orchid)

8 feature-flagged detectors (`a1_abscission` … `a8_rhizome`) merged in as a
second rule kind — generative, dynamic runtime selection through
`detectors/registry.ts`, reuse of the same parser/scoping/journal machinery.
Every finding is data-framed with a `dedupe_key` so it rides
agentic-moment's shipping layer unchanged.

```sh
bun bin/lapidary.ts --detect --rules sources/orchid.lapidary --bench
       [--flags ORCHID_FLAGS]     # all | none | a1,a5 | a4=off
```

Emits into `runs/<ts>/`: `.orchid-findings.jsonl` · `benchmark.json` ·
`benchmark.md` + a doorbell dispatch frame.

## Docs

- [detect/orchid design + tau/kappa mirror](docs/orchid-detect.md)
- `benchmark/anomaly-matrix.json` — ground truth verified 2026-10-31; last run
  scored **8/8 ground-truth recall, 16 findings, 100% dedupe-ready**, leak-free.
