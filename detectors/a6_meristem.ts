import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Ctx, Finding, Module } from "./_shared.ts";
import { now } from "./_shared.ts";

/** a6 — dormant pseudobulb meristem + adventitious rain-root.
 *  (1) scrubs NUL-byte holes out of argos-boot.log into a COPY (never the source),
 *  (2) resolves the real argos/xerj binaries (read-only),
 *  (3) reads tailscale keepalive health and advises the rain-root sprout
 *      (never runs `tailscale up` / spawns argos unless a6.apply* is set). */

const CANDIDATE_BINS = [
	"/home/toxic/pens/agentic-moment/products/argos/bin/xerj",
	"/home/toxic/pens/barn/products/pens-index/src/xerj.ts",
	"/home/toxic/pens/agentic-moment/products/argos/bin",
];

export const a6_meristem: Module = {
	id: "a6_meristem",
	flag: "a6_meristem",
	run(ctx) {
		const findings: Finding[] = [];
		const art = ctx.corpus["argos-boot.log"];
		let nulsBefore = 0, nulsAfter = 0, cleanedBytes = 0;
		if (art.present) {
			const raw = fs.readFileSync(art.path);
			nulsBefore = raw.filter(b => b === 0).length;
			const text = new TextDecoder("utf8", { fatal: false }).decode(raw).replace(/\0/g, "");
			const segments = (text.match(/segment flushed/g) ?? []).length;
			cleanedBytes = text.length;
			const outPath = path.join(ctx.runsDir, "argos-boot.cleaned.log");
			fs.writeFileSync(outPath, text, "utf8");
			fs.writeFileSync(path.join(ctx.runsDir, "argos-segments.txt"), text.split("\n").filter(l => l.includes("segment flushed")).join("\n"));
			nulsAfter = 0;
			findings.push({
				id: "orchid.a6.nul-holes",
				dedupe_key: `orchid.a6.nul.${art.key}`,
				detector: "a6_meristem",
				gt: "A6",
				flag: "a6_meristem",
				artifact: art.key,
				severity: "warn",
				title: "argos boot log was riddled with NUL-byte seek holes (scrubbed copy produced)",
				detail: { sourceBytes: art.bytes, nulsBefore, cleanedBytes, ftsSegmentsPreserved: segments, scrubbedCopy: outPath },
				ts: now(),
			});
		}

		// bin resolution (read-only)
		const resolved = CANDIDATE_BINS.map(p => ({ p, exists: fs.existsSync(p) }));
		const found = resolved.filter(r => r.exists).map(r => r.p);
		if (found.length) {
			findings.push({
				id: "orchid.a6.bin-resolution",
				dedupe_key: "orchid.a6.bin.resolve",
				detector: "a6_meristem",
				flag: "a6_meristem",
				artifact: "fs-scan",
				severity: "info",
				title: "Resolved argos/xerj entrypoints (fixes the ENOENT launch)",
				detail: { found, applySpawn: ctx.flags.a6_meristem?.params.applySpawn === true },
				ts: now(),
			});
		}

		// tailscale keepalive health
		const ts = ctx.corpus["keepalive-tailscale.json"];
		if (ts.present) {
			try {
				const k = JSON.parse(fs.readFileSync(ts.path, "utf8"));
				const pokes = Number(k.pokes ?? 0);
				const ok = Number(k.ok ?? 0);
				const minPokes = Number(ctx.flags.a6_meristem?.params.minPokes ?? 8);
				if (pokes >= minPokes && ok === 0) {
					findings.push({
						id: "orchid.a6.rain-root",
						dedupe_key: `orchid.a6.ts.${ts.key}`,
						detector: "a6_meristem",
						gt: "A6",
						flag: "a6_meristem",
						artifact: ts.key,
						severity: "warn",
						title: "Tailscale keepalive has poked many times with 0 ok (dead rain-root)",
						detail: { pokes, ok, lastOk: k.lastOk, dtMs: k.dtMs, advised: "tailscale up --accept-routes", applyTailscaleUp: ctx.flags.a6_meristem?.params.applyTailscaleUp === true },
						ts: now(),
					});
				}
			} catch { /* ignore */ }
		}
		return { findings };
	},
};
