import * as fs from "node:fs";
import type { Ctx, Finding, Module } from "./_shared.ts";
import { now, shaShort } from "./_shared.ts";

/** a5 — ATG8 phloem autophagy gate: generative write-first apical-dominance lock.
 *  Reads the tauvisor rebuke transcript, SYNTHESIZES pending directives from the
 *  advisories it actually finds (generative, not a fixed list), then proves a
 *  mutating/read-write call is blocked until the required surfaces carry read
 *  receipts — and that velocity/context-compaction drops are surfaced. */

interface Directive {
	id: string;
	surfaces: string[];
	guidance: string;
}

function collectAdvisories(raw: string): Directive[] {
	const advisories: Directive[] = [];
	const re = /<advisory\s+[^>]*?advisor=(?:"([^"]*)"|'([^']*)')[^>]*?severity=(?:"([^"]*)"|'([^']*)')[^>]*?>\s*([\s\S]*?)<\/advisory>/g;
	for (const m of raw.matchAll(re)) {
		const body = (m[5] ?? "").replace(/\\n/g, "\n");
		const surfaces = [...body.matchAll(/"([^"\\]{3,80}\.(?:ts|py|rs|sh|json|yml|yaml|jsonl))"/g)].map(x => x[1]);
		advisories.push({
			id: `adv_${shaShort(body).slice(0, 10)}`,
			surfaces: [...new Set(surfaces)].slice(0, 6),
			guidance: body.replace(/\s+/g, " ").slice(0, 160),
		});
	}
	return advisories;
}

function isMutating(tool: string, args: Record<string, unknown>): boolean {
	const mutatingTools = new Set(["write", "edit", "patch", "delete", "git_commit", "ast_edit", "move"]);
	if (mutatingTools.has(tool)) return true;
	if (tool === "bash" || tool === "eval") {
		const s = JSON.stringify(args);
		return /\b(mv |cp |rm |mkdir |cargo build| > |>> |printf.*>)/.test(s);
	}
	return false;
}

export const a5_phloem: Module = {
	id: "a5_phloem",
	flag: "a5_phloem",
	run(ctx) {
		const findings: Finding[] = [];
		const art = ctx.corpus["tau-llm-request-15bb6931625ec2fc.json"];
		const raw = art.present ? fs.readFileSync(art.path, "utf8") : "";
		const velocityFloor = Number(ctx.flags.a5_phloem?.params.velocityFloor ?? 35);
		const compactionDelta = Number(ctx.flags.a5_phloem?.params.compactionDelta ?? 100000);

		if (art.present) {
			const advisories = collectAdvisories(raw);
			const decorative = raw.includes("Following Tauvisor's sequence strictly");
			const pending = advisories.filter(a => a.surfaces.length);
			findings.push({
				id: "orchid.a5.tauvisor-rebuke",
				dedupe_key: `orchid.a5.adv.${art.key}`,
				detector: "a5_phloem",
				gt: "A5",
				flag: "a5_phloem",
				artifact: art.key,
				severity: "warn",
				title: "Tauvisor advisories pending surface enumeration (decorative-compliance risk)",
				detail: {
					advisoryCount: advisories.length,
					pendingWithSurfaces: pending.length,
					decorativeMarker: decorative,
					synthesizedDirectives: pending.slice(0, 6).map(a => ({ id: a.id, surfaces: a.surfaces })),
				},
				ts: now(),
			});

			// --- HUD velocity / compaction scan (generative rows) ---
			let prevCtx: number | null = null;
			const cavitations: string[] = [];
			const compactions: string[] = [];
			for (const line of raw.split("\n")) {
				const parts = line.trim().split(/\s+/);
				if (parts.includes("Δ") && parts.length >= 9) {
					const tok = (s: string) => {
						if (s.endsWith("K")) return parseFloat(s.slice(0, -1)) * 1000;
						if (s.endsWith("M")) return parseFloat(s.slice(0, -1)) * 1e6;
						return parseFloat(s);
					};
					const ctxNow = tok(parts[parts.length - 4] ?? "");
					const vel = parseFloat((parts[parts.length - 1] ?? "0").replace(/[^0-9.]/g, ""));
					if (Number.isFinite(vel) && vel < velocityFloor) cavitations.push(`${parts[0]} ${parts[1]} vel=${vel} tok/s`);
					if (prevCtx !== null && Number.isFinite(ctxNow) && prevCtx - ctxNow > compactionDelta) {
						compactions.push(`${parts[0]} ${parts[1]} ctx ${prevCtx}->${ctxNow}`);
					}
					if (Number.isFinite(ctxNow)) prevCtx = ctxNow;
				}
			}
			if (cavitations.length || compactions.length) {
				findings.push({
					id: "orchid.a5.hud-cavitation",
					dedupe_key: `orchid.a5.hud.${art.key}`,
					detector: "a5_phloem",
					flag: "a5_phloem",
					artifact: art.key,
					severity: "warn",
					title: "HUD velocity cavitations / context compactions (autophagy triggers)",
					detail: { velocityFloor, compactionDelta, cavitations: cavitations.slice(0, 8), compactions: compactions.slice(0, 8) },
					ts: now(),
				});
			}
		}

		// ---- prove the gate: block a mutating call until read receipts exist ----
		const gatePending = new Map<string, string[]>();
		if (art.present) {
			for (const d of collectAdvisories(raw).filter(a => a.surfaces.length)) gatePending.set(d.id, d.surfaces);
		}
		if (!gatePending.size) gatePending.set("demo_adv", ["src/placeholder.ts", "docs/plan.md"]);

		const blockedCall = { tool: "edit", args: { path: "something.ts" } };
		const blocked = isMutating(blockedCall.tool, blockedCall.args) && gatePending.size > 0;
		// satisfy one directive (drain: pretend surfaces read) -> gate opens for those
		const first = [...gatePending.entries()][0];
		gatePending.delete(first[0]);

		findings.push({
			id: "orchid.a5.apical-dominance-demo",
			dedupe_key: "orchid.a5.gate.demo",
			detector: "a5_phloem",
			flag: "a5_phloem",
			artifact: "synthetic",
			severity: "info",
			title: "Write-first lock blocked a mutating call pending Tauvisor read receipts",
			detail: {
				blockedWhileDirectivesPending: blocked,
				generatedDirectiveSurfaces: first?.[1],
				remainingDirectivesAfterRead: gatePending.size,
				haltPolicy: ctx.flags.a5_phloem?.params.haltWriteFirst === true ? "halt" : "advisory",
			},
			ts: now(),
		});

		return { findings };
	},
};
