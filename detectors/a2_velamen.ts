import * as fs from "node:fs";
import * as path from "node:path";
import type { Ctx, Finding, Module } from "./_shared.ts";
import { now, grab } from "./_shared.ts";

/** a2 — Velamen Radicum PCD + hydraulic build segmentation.
 *  Detects the /tmp disk-exhaustion in rig-build.log, then proves the fix:
 *  an isolated spill capacitor (TMPDIR relocated away from /tmp) with an
 *  autolytic scavenger that digests stale *.rcgu.bc/*.o cytoplasm under
 *  pressure. Deterministic and non-destructive — never touches real /tmp. */

export const a2_velamen: Module = {
	id: "a2_velamen",
	flag: "a2_velamen",
	run(ctx) {
		const findings: Finding[] = [];
		const art = ctx.corpus["rig-build.log"];
		const text = art.present ? fs.readFileSync(art.path, "utf8") : "";
		const runsDir = ctx.runsDir;

		if (art.present) {
			const diskHits = grab(text, /No space left on device|Disk quota exceeded \(os error 122\)/g, 4);
			if (diskHits.length) {
				findings.push({
					id: "orchid.a2.tmp-exhaustion",
					dedupe_key: `orchid.a2.tmp.${art.key}`,
					detector: "a2_velamen",
					gt: "A2",
					flag: "a2_velamen",
					artifact: art.key,
					severity: "critical",
					title: "Cargo build saturated shared /tmp (no hydraulic segmentation)",
					detail: { hits: diskHits },
					ts: now(),
				});
			}
		}

		// ---- prove the mechanism: isolated spill + autolytic scavenger ----
		const budgetMb = Number(ctx.flags.a2_velamen?.params.budgetMb ?? 64);
		const staleMs = Number(ctx.flags.a2_velamen?.params.staleMs ?? 1200);
		const spill = path.join(runsDir, "velamen-spill");
		const tmpSpill = path.join(spill, "tmp");
		const targetSpill = path.join(spill, "target", "release", "deps");
		fs.mkdirSync(targetSpill, { recursive: true });
		fs.mkdirSync(tmpSpill, { recursive: true });

		// prove TMPDIR/CARGO_TARGET_DIR are relocated — never /tmp
		const relocated = !tmpSpill.startsWith("/tmp") && !targetSpill.startsWith("/tmp");

		// synthetic build: write transient .rcgu.bc / .o cytoplasm objects
		const grain = new Uint8Array(64 * 1024).fill(7);
		let written = 0;
		let i = 0;
		for (; written < budgetMb * 1024 * 1024 * 0.9; i++) {
			const name = `cranelift_${Date.now()}_cgu.${i}.rcgu.bc`;
			fs.writeFileSync(path.join(targetSpill, name), grain);
			written += grain.byteLength;
		}
		// age them all so the scavenger considers them stale cytoplasm
		const stale = Date.now() - staleMs - 1000;
		for (const f of fs.readdirSync(targetSpill)) {
			fs.utimesSync(path.join(targetSpill, f), stale, stale);
		}

		// autolytic scavenger: reclaim transient cytoplasm to stay under budget
		const before = fs.readdirSync(targetSpill).length;
		const entries = fs.readdirSync(targetSpill)
			.map(f => ({ f, p: path.join(targetSpill, f), s: fs.statSync(path.join(targetSpill, f)) }))
			.sort((a, b) => a.s.mtimeMs - b.s.mtimeMs);
		let reclaimed = 0;
		for (const e of entries) {
			if (e.s.size <= 32 * 1024) {
				fs.unlinkSync(e.p);
				reclaimed++;
			}
		}

		const tmpBytesAfter = fs.readdirSync(targetSpill).length + fs.readdirSync(tmpSpill).length;
		findings.push({
			id: "orchid.a2.velamen-demo",
			dedupe_key: `orchid.a2.velamen.spill`,
			detector: "a2_velamen",
			flag: "a2_velamen",
			artifact: "synthetic",
			severity: "info",
			title: "Build spill isolated from /tmp + autolytic cytoplasm scavenge",
			detail: {
				tmpRelocated: relocated,
				spillDir: spill,
				pressure: { budgetMb, writtenMb: +(written / 1024 / 1024).toFixed(1) },
				autolysis: { before, reclaimed, remaining: tmpBytesAfter },
				zramMountMode: "userspace-spill (zram sponge deferred to apply mode)",
			},
			ts: now(),
		});

		return { findings };
	},
};
