# orchid · detect rule family (lapidary, all-Bun)

`orchid` is the **detect rule family** merged into lapidary (geode). Lapidary
was a pure text-transform/rename engine (`word | substr | regex | case |
comby`); it now also carries a second rule kind — **`detect`** — that maps an
orchid detector module to feature-flagged dispatch over the log corpus, reusing
the exact same parser, scoping and journal machinery as the transforms.

## Why merge here

- **One engine, one contract.** A `.lapidary` manifest already expresses "run
  this rule set over this scope, dry-run first, journal every change". Detect
  rules ride that: `sources/orchid.lapidary` enables all 9 flags; `--flags`
  toggles them at runtime like any other lapidary scope knob.
- **Modular, not a monolith.** Each mechanism is its own file in
  `detectors/` (`a1_abscission.ts` … `a8_rhizome.ts`), discovered by id through
  `detectors/registry.ts` — generative runtime selection, not hard-wired calls.
- **Data-framed, log-helper-ready.** Every finding carries a stable
  `dedupe_key` (`orchid.<detector>.<slug>`) and JSON-lines schema, so detections
  ride agentic-moment's shipping layer (canonical **OpenTelemetry Collector**,
  chosen by its datadog vs otel/vector/signoz semantic-ratio compare) unchanged.

## The 9 flag-gated detectors

| flag | mechanism | artifact it detects | ground truth |
|---|---|---|---|
| `a1_abscission` | ethylene-auxin AZ guillotine (cgroup.kill + pgroup) | kappa suite 60001ms child-session hang | A1 |
| `a2_velamen` | isolated build spill + autolytic scavenger | rig-build `/tmp` disk exhaustion (os error 122) | A2 |
| `a3_pseudobulb` | in-memory sqlite hydrenchyma + ABA stomatal gating | router `SQLITE_IOERR_WRITE` errno 778 / 401 | A3 |
| `a4_aquaporin` | wire-model-spoof witness + pcap/proc seals | transcript deepseek-v4-flash vs glm-5.3-flash | A4 |
| `a5_phloem` | generative write-first lock + HUD velocity/compaction | Tauvisor advisory rebuke + 429K→33K compaction | A5 |
| `a6_meristem` | NUL-hole scrub + argos/xerj bin + tailscale health | argos ENOENT / 90%-NUL log / 881-poke dead tailscale | A6 |
| `a7_passage` | code-token typo filter + kinetic keystroke decode | typo-final.json raw hits dominated by code FPs | A7 |
| `a8_rhizome` | /dev/shm mmap ring + clonal symlink audit | tool-output truncation lies + kite/fledge/hatch drift | A8 |
| `a9_stolon` | runaway spawn-loop detection (missing-await Bun.sleep pace storm, inline `-e` daemon specs, shell reconcile cadence) | 155 forks/s × 25.4 h lease-guard storm from an unpaced `while(true){spawnSync; Bun.sleep}` | A9 |

## CLI

```sh
bun bin/lapidary.ts --detect --rules sources/orchid.lapidary --bench
       [--flags ORCHID_FLAGS]     # all | none | a1,a5 | a4=off
```

Emits into `runs/<ts>/`:
`.orchid-findings.jsonl` (append-only journal) · `benchmark.json` · `benchmark.md`
plus a `GIT_SYNC_DISPATCH` doorbell frame (session-scoped AF_UNIX listener, spilled
to `runs/<ts>/doorbell/frames.jsonl`).

## Non-destructive by default

Preserved `--dry-run` spirit: all modules are **report-only**. Any destructive
action (pcap truncation, tailscale up, argos spawn, /tmp writes) is behind an
explicit `apply:*` param that defaults to `false`. The one exception is a1,
which severs **only its own scratch cgroup / process group** to *prove* the
guillotine mechanism.

## tau/kappa mirror (dual-TUI doctrine)

- **kappa** owns the serial test runner whose 60001ms hang `a1` detects and
  whose cgroup guillotine is the fix (`packages/cli/script/test-runner.ts`).
  Flag: `a1_abscission`.
- **tau** owns the Tauvisor advisory surface `a5` keys off (write-first apical
  dominance lock, HUD velocity surge). Flag: `a5_phloem`.
- The shared `detectors/_shared.ts` + `orchid.flags.json` runtime is
  environment-agnostic so both TUIs consume the **same** flag manifest — a
  change lands in neither unless the manifest says so (flag-off = inert).

## Benchmark

See `benchmark/anomaly-matrix.json` (ground truth verified 2026-10-31 from the
/tmp artifacts) and the generated `runs/<ts>/benchmark.{json,md}` for recall /
precision / per-anomaly latency.

## References

The biological framing ("orchid abscission") is the architect's whitepaper
metaphor mapping epiphytic-orchid survival physiology (hydraulic segmentation,
phloem autophagy, ABA gating, PCD velamen, mycorrhizal passage cells, rhizome
clonal sharing) onto estate failure modes. The engineering is orthodox: bounded
process isolation, in-memory hi-availability stores, wire identity witnesses,
data-framed telemetry.
