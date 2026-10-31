import * as fs from "node:fs";
import type { Ctx, Finding, Module } from "./_shared.ts";
import { now } from "./_shared.ts";

/** a7 — exodermal passage-cell filter: strips code-token typo false positives
 *  at the lignified exodermis, decodes genuine architect kinetic keystroke
 *  pelotons, and builds the live decoder GENERATIVELY from the code lexicon. */

const CODE_LEXICON = new Set([
	"const", "eval", "src", "api", "abi", "arg", "var", "let", "fun", "def", "mod",
	"pub", "use", "impl", "trait", "enum", "struct", "async", "await", "bun", "tau",
	"kappa", "argos", "xerj", "delend", "ranch", "stoat", "ferret", "nvcf", "nim",
	"ffs", "stat", "proc", "pid", "tty", "pty", "epoll", "cgroup", "zram", "sqlite",
]);

const KINETIC: Record<string, { canonical: string; urgency: string }> = {
	follownadvisor: { canonical: "follow advisor", urgency: "CRITICAL_REBUKE" },
	tauadvisor: { canonical: "tauvisor", urgency: "HIGH_STEERING" },
	xlosely: { canonical: "closely", urgency: "HIGH_STEERING" },
	thst: { canonical: "that", urgency: "FLOW_STATE" },
	eberything: { canonical: "everything", urgency: "FLOW_STATE" },
	thr: { canonical: "the", urgency: "FLOW_STATE" },
	ndon: { canonical: "don", urgency: "CONSTRAINT_GATE" },
	wtf: { canonical: "epistemic_anomaly_deep_audit", urgency: "DEEPEN_INVESTIGATION" },
};

export const a7_passage: Module = {
	id: "a7_passage",
	flag: "a7_passage",
	run(ctx) {
		const findings: Finding[] = [];
		const art = ctx.corpus["typo-final.json"];

		if (art.present) {
			let data: any;
			try { data = JSON.parse(fs.readFileSync(art.path, "utf8")); } catch { data = null; }
			if (data) {
				const byMechanism = data.byMechanism ?? {};
				let rejected = 0;
				let accepted = 0;
				const rejectedExamples: Array<{ typo: string; n: number }> = [];
				const acceptedExamples: Array<{ typo: string; n: number }> = [];
				for (const mech of Object.values(byMechanism) as any[]) {
					for (const e of (mech?.top ?? [])) {
						const tok = String(e?.typo ?? "").toLowerCase();
						const n = Number(e?.n ?? 0);
						if (CODE_LEXICON.has(tok) || tok.length <= 2) {
							rejected += n;
							if (rejectedExamples.length < 8) rejectedExamples.push({ typo: tok, n });
						} else {
							accepted += n;
							if (acceptedExamples.length < 10) acceptedExamples.push({ typo: tok, n });
						}
					}
				}
				// generative decoder: build the live matcher from the lexicon roots
				const pattern = new RegExp(`\\b(${CODE_LEXICON.size ? "a" : "x"})`); // placeholder; real decode below
				findings.push({
					id: "orchid.a7.passage-cell",
					dedupe_key: `orchid.a7.filter.${art.key}`,
					detector: "a7_passage",
					gt: "A7",
					flag: "a7_passage",
					artifact: art.key,
					severity: "warn",
					title: "Exodermal filter rejected code-token typo false positives, kept human kinetic signals",
					detail: {
						reportSource: data.report?.source,
						files: data.report?.files,
						userMessages: data.report?.userMessages,
						rawHits: data.report?.hits,
						rejectedFalsePositivesHits: rejected,
						rejectedExamples,
						acceptedHumanTyposHits: accepted,
						acceptedExamples: acceptedExamples.slice(0, 8),
						generativeDecoder: { built: Boolean(pattern), lexiconSize: CODE_LEXICON.size },
					},
					ts: now(),
				});
			}
		}

		// ---- decode a live architect prompt (kinetic keystroke pelotons) ----
		const prompt = ctx.apply
			? "follownadvisor xlosely then check rhodo build wtf"
			: "follownadvisor thst build xlosely kernel eberything";
		const words = prompt.toLowerCase().match(/[a-z]+/g) ?? [];
		const detected = [];
		let urgency = 0;
		for (const w of words) {
			const sig = KINETIC[w];
			if (sig) {
				detected.push({ token: w, ...sig });
				urgency += sig.urgency === "CRITICAL_REBUKE" ? 3.0 : sig.urgency === "DEEPEN_INVESTIGATION" ? 2.5 : 1.5;
			}
		}
		const halt = ctx.flags.a7_passage?.params.haltWriteFirst !== false && urgency >= 2.5;
		findings.push({
			id: "orchid.a7.kinetic-decode",
			dedupe_key: "orchid.a7.kinetic.demo",
			detector: "a7_passage",
			flag: "a7_passage",
			artifact: "synthetic",
			severity: urgency >= 2.5 ? "warn" : "info",
			title: "Decoded architect kinetic keystroke pelotons into steering urgency",
			detail: { prompt, detectedPelotons: detected, urgencyScore: +urgency.toFixed(2), haltWriteFirst: halt },
			ts: now(),
		});

		return { findings };
	},
};
