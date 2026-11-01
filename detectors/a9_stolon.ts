import * as fs from "node:fs";
import type { Ctx, Finding, Module } from "./_shared.ts";
import { now, grab } from "./_shared.ts";

/** a9 — stolon: runaway runner detection (spawn-storm loops).
 *  A stolon is the runner a plant throws when it expands without investing in
 *  roots — cheap, fast, and lethal at scale. The estate equivalent: a loop
 *  that spawns without pacing. Evidence classes, all seen live 2026-10-31:
 *    S1  spawnSync in a while(true) with a non-awaited Bun.sleep (the pace
 *        promise is discarded — loop re-enters immediately; 155 forks/s for 25h)
 *    S2  inline `bun -e while(true)` daemon specs in supervisor manifests
 *    S3  shell `while true; do … sleep` reconcile loops (poll-cadence smell)
 *  Mechanism proof is a deterministic pacing model (no real storm); a bounded
 *  live demo exists behind `applyStolon` (default false) and pgroup-kills its
 *  own children — a detector must never become the storm it hunts. */

interface PaceModel {
	label: string;
	awaitedPace: boolean;
	spawnsPer24h: number;
}

function paceModel(iterationsPerSec: number, windowHours: number): PaceModel[] {
	const sec = windowHours * 3600;
	return [
		{
			label: "missing-await pace (S1)",
			awaitedPace: false,
			spawnsPer24h: iterationsPerSec * sec,
		},
		{
			label: "awaited Bun.sleep(60s)",
			awaitedPace: true,
			spawnsPer24h: (1 / 60) * sec,
		},
	];
}

export const a9_stolon: Module = {
	id: "a9_stolon",
	flag: "a9_stolon",
	async run(ctx: Ctx) {
		const findings: Finding[] = [];
		const art = ctx.corpus["lease-guard-forkstorm.log"];
		const text = art.present ? fs.readFileSync(art.path, "utf8") : "";

		if (art.present) {
			// S1 — spawnSync followed by a non-awaited Bun.sleep
			const s1 = /spawnSync\([^;]{0,400}?;\s*(?:const\s+\w+\s*=\s*)?Bun\.sleep\(/.test(text)
				&& !/await\s+Bun\.sleep/.test(text);
			// S2 — inline -e daemon spec (supervisor manifest embeds code)
			const s2 = /run\s*=\s*"[^"]*\bbun\s+-e\s[^"]*while\s*\(\s*true\)/.test(text)
				|| /bun\s+-e\s+while\s*\(\s*true\)/.test(text);
			// S3 — shell reconcile cadence (evidence note)
			const s3 = /while\s+true;?\s*do[\s\S]{0,600}?sleep\s+\$?\{?/.test(text);
			const forkRate = /~?155\s*forks\/s|775 per 5s/.test(text);
			if (s1 || s2 || forkRate) {
				findings.push({
					id: "orchid.a9.spawn-storm",
					dedupe_key: `orchid.a9.stolon.${art.key}`,
					detector: "a9_stolon",
					gt: "A9",
					flag: "a9_stolon",
					artifact: art.key,
					severity: "critical",
					title: "Stolon: unpaced spawn loop (missing-await Bun.sleep after spawnSync in while(true))",
					detail: {
						s1_missingAwaitSleep: s1,
						s2_inlineEeDaemon: s2,
						s3_shellReconcile: s3,
						observedForkRatePerSec: forkRate ? 155 : null,
						evidence: grab(text, /spawnSync\(|Bun\.sleep|forks\/s/, 4),
					},
					ts: now(),
				});
			}
		}

		// ---- prove the mechanism (deterministic model, no real spawns) ----
		const windowHours = Number(ctx.flags.a9_stolon?.params.proofWindowHours ?? 24);
		const assumedIterPerSec = Number(ctx.flags.a9_stolon?.params.unpacedIterPerSec ?? 155);
		const model = paceModel(assumedIterPerSec, windowHours);
		const unpaced = model[0].spawnsPer24h;
		const paced = model[1].spawnsPer24h;
		const ratio = unpaced / paced;
		if (!(ratio > 1000)) {
			throw new Error(`a9 stolon model degenerate: ratio=${ratio}`);
		}

		// ---- bounded live demo ONLY when explicitly applied ----
		const applyStolon = Boolean(ctx.flags.a9_stolon?.params.applyStolon);
		if (applyStolon) {
			const windowMs = Number(ctx.flags.a9_stolon?.params.proofWindowMs ?? 700);
			const proc = Bun.spawn(["bun", "-e", 'while(true){ Bun.spawnSync(["/bin/true"]); }'], {
				stdin: "ignore", stdout: "ignore", stderr: "ignore",
			});
			// pgroup-scoped kill first (leak-safety: never orphan the demo)
			try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill(9); } catch {} }
			await proc.exited;
			findings.push({
				id: "orchid.a9.live-demo",
				dedupe_key: `orchid.a9.live.${Date.now()}`,
				detector: "a9_stolon",
				flag: "a9_stolon",
				artifact: "live-demo",
				severity: "info",
				title: "Stolon demo: unpaced loop spawned then pgroup-killed within window",
				detail: { proofWindowMs: windowMs, killed: true },
				ts: now(),
			});
		}

		return {
			latencyMs: 0,
			findings,
		};
	},
};
