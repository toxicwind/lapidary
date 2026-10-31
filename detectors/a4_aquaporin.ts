import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Ctx, Finding, Module } from "./_shared.ts";
import { now, sha256, shaShort } from "./_shared.ts";

/** a4 — extra-xylary aquaporin gating + wire-signature witness.
 *  (1) audits wire transcripts for model spoofing (claimed header model vs the
 *      model ids / thinkingSignature prefixes that actually flowed),
 *  (2) mints a cryptographic witness chain over the ordered signatures,
 *  (3) scans for runaway pcaps + overspends /proc reads — REPORT-ONLY unless
 *      a4.applySeals (never kills/truncates anything by default). */

export const a4_aquaporin: Module = {
	id: "a4_aquaporin",
	flag: "a4_aquaporin",
	run(ctx) {
		const findings: Finding[] = [];
		const art = ctx.corpus["tau-llm-request-15bbdb3a55c4cce4.json"];

		let claimed: string | null = null;
		const wire = new Map<string, number>();
		const sigChain: string[] = [];
		if (art.present) {
			let top: any;
			try {
				top = JSON.parse(fs.readFileSync(art.path, "utf8"));
			} catch { top = null; }
			if (top) {
				claimed = top.model?.id ?? top.model ?? null;
				const msgs: unknown[] = top.messages ?? [];
				for (const m of msgs as any[]) {
					if (!m || typeof m !== "object") continue;
					const mmId = typeof m.model === "string" ? m.model : (m as any).providerModel;
					if (typeof mmId === "string") wire.set(mmId, (wire.get(mmId) ?? 0) + 1);
					let content = m.content;
					if (Array.isArray(content)) {
						for (const part of content) {
							if (part && typeof part === "object") {
								const ts = part.thinkingSignature;
								if (typeof ts === "string") {
									const model = ts.split(":")[0];
									wire.set(model, (wire.get(model) ?? 0) + 1);
									sigChain.push(ts);
								}
							}
						}
					} else if (typeof content === "string") {
						for (const m2 of content.matchAll(/"thinkingSignature"\s*:\s*"([^"]+)"/g)) sigChain.push(m2[1]);
					}
				}
			}

			const raw = fs.readFileSync(art.path, "utf8");
			const dsml = (raw.match(/DSML|function_calls/g) ?? []).length;
			const spoofPct = Number(ctx.flags.a4_aquaporin?.params.spoofPct ?? 0.01);
			const wireIdents = [...wire.entries()];
			const spoofs = claimed
				? wireIdents.filter(([k]) => !String(claimed).includes(k) && !k.includes(String(claimed)) && wire.size > 0)
				: [];
			const wireChain = sigChain.length ? sha256(sigChain.join("\n")) : null;
			if (spoofs.length) {
				findings.push({
					id: "orchid.a4.wire-spoof",
					dedupe_key: `orchid.a4.spoof.${art.key}.${shaShort(wireChain ?? "none")}`,
					detector: "a4_aquaporin",
					gt: "A4",
					flag: "a4_aquaporin",
					artifact: art.key,
					severity: "critical",
					title: "Wire-level model identity diverges from claimed header",
					detail: {
						claimedHeaderModel: claimed,
						observedWireModels: Object.fromEntries(wire),
						divergent: spoofs.map(([k, n]) => ({ model: k, turns: n })).slice(0, 8),
						dsmlMarkupLeaks: dsml,
						wireWitnessSha256: wireChain,
					},
					ts: now(),
				});
			} else if (claimed) {
				findings.push({
					id: "orchid.a4.wire-ok",
					dedupe_key: `orchid.a4.ok.${art.key}.${shaShort(wireChain ?? "none")}`,
					detector: "a4_aquaporin",
					flag: "a4_aquaporin",
					artifact: art.key,
					severity: "info",
					title: "Wire identity consistent with claimed model",
					detail: { claimed, observedWireModels: Object.fromEntries(wire), wireWitnessSha256: wireChain, dsmlMarkupLeaks: dsml },
					ts: now(),
				});
			}
		}

		// ---- cuticular transpiration scan: runaway pcaps (report-only) ----
		const bigPcaps: Array<{ file: string; bytes: number }> = [];
		try {
			for (const f of fs.readdirSync(os.tmpdir())) {
				if (f.endsWith(".pcap") || f.includes(".pcap.")) {
					const p = path.join(os.tmpdir(), f);
					try {
						const sz = fs.statSync(p).size;
						if (sz > 64 * 1024 * 1024) bigPcaps.push({ file: p, bytes: sz });
					} catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }
		if (bigPcaps.length) {
			findings.push({
				id: "orchid.a4.runaway-pcap",
				dedupe_key: `orchid.a4.pcap.${os.tmpdir()}`,
				detector: "a4_aquaporin",
				flag: "a4_aquaporin",
				artifact: "fs-scan",
				severity: "warn",
				title: "Runaway pcap(s) exceed cuticular limit (report-only; applySeals=false)",
				detail: { oversizedPcaps: bigPcaps, applySeals: ctx.flags.a4_aquaporin?.params.applySeals === true },
				ts: now(),
			});
		}

		return { findings };
	},
};
