// detect.ts — `lapidary detect --rules <manifest> [--flags] [--bench]`
// Runs the orchid detector rule family over the corpus, feature-flag-gated.
import * as path from "node:path";
import { loadRules, runDetectors, runBenchmark, journalRun, stamp } from "../core.ts";

export function run(args: string[]): void {
	const get = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
	const rulesArg = get("--rules") ?? get("--pairs");
	const flagsOverride = get("--flags");
	const bench = args.includes("--bench");
	const repo = get("--repo");
	const runsDir = path.join(import.meta.dir, "..", "..", "..", "runs", stamp());
	if (!rulesArg) {
		console.error("lapidary detect: --rules <manifest.lapidary> is required");
		process.exit(2);
	}
	void (async () => {
		const { rules } = loadRules(rulesArg.split(",").map(f => f.trim()));
		const outcomes = await runDetectors(rules, flagsOverride, runsDir);
		for (const o of outcomes) console.log(`[detect] ${o.id} ${o.enabled ? `ran ${o.findings.length} finding(s) in ${o.latencyMs}ms` : `SKIPPED (${o.reason})`}`);
		if (bench) {
			const report = runBenchmark(outcomes, runsDir);
			console.log(`[bench] recall=${(Number(report.groundTruthRecall) * 100).toFixed(1)}% coverage=${report.coverage} findings=${report.logHelperReady.totalFindings} -> ${path.join(runsDir, "benchmark.md")}`);
		} else {
			console.log(`[detect] journal -> ${path.join(runsDir, ".orchid-findings.jsonl")}`);
		}
		journalRun({ mode: bench ? "detect-bench" : "detect", repo, extra: { runsDir } });
	})().catch(e => { console.error(e); process.exit(1); });
}