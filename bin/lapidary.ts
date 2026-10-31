#!/usr/bin/env bun
/**
 * lapidary — the geode rename engine (maximal schema, 2026-10-30).
 *
 * Cuts and polishes product names across a repo using `.lapidary` rule files.
 * Schema merged from the mainstream pattern-borrow research (see docs/):
 *
 *   - legacy line rules (the estate's original format, forward-only alias):
 *       word:   OLD => NEW        # \bOLD\b whole-word, case-sensitive
 *       substr: OLD => NEW        # substring
 *       exclude: TOKEN           # armor a token against ALL files' word rules
 *   - ast-grep borrow: YAML rule files with per-rule `id`, `fix` templates,
 *     `filePatterns` scoping, composite `not:` guards
 *   - renovate borrow: `includePaths` / `ignorePaths` global scoping,
 *     presets via `extends:`, "each rule needs a match or an exclude"
 *   - comby borrow: `:[[hole]]` template holes in match/rewrite pairs
 *   - sed borrow: reversible edits (undo journal, never silent in-place)
 *   - case-preserving transforms (ast-grep style-case): one rule name covers
 *     camelCase, PascalCase, snake_case, kebab-case, SCREAMING_SNAKE
 *
 * Emissions:
 *   rename.map  — machine-readable OLD->NEW per file (the formal map)
 *   .lapidary-undo.jsonl — journal: one line per write {file, before-hash,
 *     before-content-ref} so every cut is reversible via --undo
 *
 * Engine contract (from the 2026-10-26 blind-sweep incident):
 *   - excludes accumulate across ALL rule files (cross-file armor)
 *   - walks `git ls-files -z` per repo; NEVER mutates through symlinks
 *   - --dry-run default-safe: prints == file == blocks + changed=N
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Ctx, Finding } from "../detectors/_shared.ts";
import { makeDoorbell, resolveCorpus, resolveFlags } from "../detectors/_shared.ts";
import { loadDetector } from "../detectors/registry.ts";

export interface Rule {
	id: string;
	kind: "word" | "substr" | "regex" | "case" | "comby" | "detect";
	from: string;
	to: string;
	file: string;
	includePaths?: string[];
	ignorePaths?: string[];
}

export interface Parsed {
	rules: Rule[];
	excludes: Set<string>;
	globalInclude: string[];
	globalIgnore: string[];
	extends: string[];
}

const CASE_STYLES: Record<string, (s: string) => string> = {
	camel: (s) => s.replace(/[-_](\w)/g, (_, c) => c.toUpperCase()).replace(/^(\w)/, (c) => c.toLowerCase()),
	pascal: (s) => s.replace(/[-_](\w)/g, (_, c) => c.toUpperCase()).replace(/^(\w)/, (c) => c.toUpperCase()),
	snake: (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase(),
	kebab: (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[_\s]+/g, "-").toLowerCase(),
	screaming: (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toUpperCase(),
};

/** Rewrite `from` in every case style to the matching style of `to`. */
export function applyCasePreserving(content: string, from: string, to: string): { content: string; count: number } {
	let count = 0;
	let result = content;
	for (const style of Object.values(CASE_STYLES)) {
		const variant = style(from);
		const replacement = style(to);
		if (variant === replacement) continue;
		const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		// Two identifier shapes must both rewrite:
		//   bare word    \bpinax\b          (pinax → mimetite)
		//   prefix form  pinax_x, pinaxApi  (→ mimetite_x, mimetiteApi)
		// Left boundary + (?![a-z]) lookahead: the continuation must not be a
		// lowercase letter, so "pinaxe" never matches while pinax_x and
		// pinaxApi do — mirrors ast-grep's identifier-aware case replace.
		result = result.replace(new RegExp(`\\b${escaped}(?![a-z])`, "g"), () => {
			count++;
			return replacement;
		});
	}
	return { content: result, count };
}

/** Expand comby-style :[[hole]] templates into regex + replacement. */
export function combyToRegex(match: string, rewrite: string): { pattern: RegExp; replace: (m: RegExpMatchArray) => string } | null {
	const holes: string[] = [];
	// Template literals are LITERAL: escape every regex metachar except the
	// :[[hole]] markers themselves (comby borrow — holes are the only syntax).
	const patternSrc = match.replace(/:\[\[(\w+)\]\]|./gs, (token, name) => {
		if (name) {
			holes.push(name);
			return `(?<${name}>.+?)`;
		}
		return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	});
	if (holes.length === 0) return null;
	return {
		pattern: new RegExp(patternSrc, "g"),
		// String.replace's callback receives the match array only when declared
		// as rest args — (m) alone is the matched STRING and .groups is
		// undefined (holes silently emptied). groups rides in as the LAST arg.
		replace: (...args: Array<unknown>) => {
			const groups = args[args.length - 1] as Record<string, string> | undefined;
			return rewrite.replace(/:\[\[(\w+)\]\]/g, (_, name) => groups?.[name] ?? "");
		},
	};
}

/** Parse a .lapidary file: YAML (has `rules:` key) or legacy line format. */
export function parseRuleFile(file: string): Parsed {
	const raw = fs.readFileSync(file, "utf8");
	const rules: Rule[] = [];
	const excludes = new Set<string>();
	const globalInclude: string[] = [];
	const globalIgnore: string[] = [];
	let extendsList: string[] = [];
	const baseId = path.basename(file).replace(/\.lapidary$/, "");

	// HYBRID schema. Scope keys (includePaths/ignorePaths/extends/exclude)
	// come from Bun.YAML; RULE lines come from the line parser below — rule
	// values like `- regex: 'x(\w*)' => 'y$1'` are INVALID YAML (a quoted
	// scalar followed by more content), so full-YAML parsing throws
	// "Unexpected token" on exactly the rules this format exists for.
	const unquote = (s: string): string => {
		const t = s.trim();
		if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
			return t.slice(1, -1);
		}
		return t;
	};
	if (/^rules:\s*$/m.test(raw) || /^detectors:\s*$/m.test(raw) || /^id:\s/m.test(raw)) {
		let doc: Record<string, unknown> = {};
		let yamlOk = false;
		try {
			doc = Bun.YAML.parse(raw) as Record<string, unknown>;
			yamlOk = Array.isArray(doc.rules);
		} catch {
			doc = {};
		}
		// Scope keys: YAML when it parsed; regex fallback over the raw lines
		// when it did not (the same quoted-scalar+`=>` problem that breaks
		// full-YAML parsing also hides the scope keys from Bun.YAML).
		if (yamlOk) {
			extendsList = (doc.extends as string[]) ?? [];
			globalInclude.push(...((doc.includePaths as string[]) ?? (doc.scope as { includePaths?: string[] })?.includePaths ?? []));
			globalIgnore.push(...((doc.ignorePaths as string[]) ?? (doc.scope as { ignorePaths?: string[] })?.ignorePaths ?? []));
			for (const token of ((doc.exclude as string[]) ?? [])) excludes.add(token);
		} else {
			extendsList = extractBracketList(raw, "extends");
			globalInclude.push(...extractBracketList(raw, "includePaths"));
			globalIgnore.push(...extractBracketList(raw, "ignorePaths"));
			for (const token of extractBracketList(raw, "exclude")) excludes.add(token);
		}
		// detect rule family: an orchid detector manifest (`detectors:` block
		// with `- detect: <moduleId>`) is mapped to feature-flagged detector
		// dispatch instead of text rewriting — reusing the same parser/scope
		// machinery as word/substr/regex/case/comby rules.
		// The detectors block is a valid YAML list even when `rules:` is absent,
		// so read it from the parsed doc whenever YAML actually parsed it.
		const detectorList = (doc?.detectors as Array<Record<string, unknown>> | undefined) ?? null;
		if (doc && Array.isArray(detectorList)) {
			for (const entry of detectorList) {
				if (!entry || typeof entry.detect !== "string") continue;
				rules.push({
					id: (entry.id as string) ?? `${baseId}#detect`,
					kind: "detect",
					from: entry.detect,
					to: typeof entry.params === "string" ? entry.params : "",
					file,
				});
			}
		}
		if (yamlOk) {
			// YAML parsed cleanly: rule entries come from the doc — including
			// ast-grep-style match/fix pairs that the line parser can't see.
			const yamlRules = (doc.rules as Array<Record<string, unknown>>) ?? [];
			for (const [i, entry] of yamlRules.entries()) {
				const id = (entry.id as string) ?? `${baseId}#${i}`;
				for (const token of ((entry.exclude as string[]) ?? [])) excludes.add(token);
				const rule: Rule = {
					id,
					kind: "substr",
					from: "",
					to: "",
					file,
					includePaths: (entry.includePaths as string[]) ?? (entry.filePatterns as string[]),
					ignorePaths: (entry.ignorePaths as string[]) ?? (entry.ignore as string[]),
				};
				const entryValue =
					(entry.word ?? entry.regex ?? entry.case ?? entry.comby ?? entry.substr) as string | undefined;
				const entryKind =
					entry.word !== undefined ? "word" :
					entry.regex !== undefined ? "regex" :
					entry.case !== undefined ? "case" :
					entry.comby !== undefined ? "comby" : "substr";
				if (entryValue !== undefined && typeof entryValue === "string") {
					const [from, to] = entryValue.split("=>").map(s => unquote(s));
					rule.kind = entryKind as Rule["kind"];
					rule.from = from;
					rule.to = to;
				} else if (typeof entry.fix === "string" && typeof entry.match === "string") {
					// ast-grep style: match pattern + fix rewrite → comby pair
					rule.kind = "comby";
					rule.from = entry.match;
					rule.to = entry.fix;
				} else {
					continue;
				}
				if (!rule.from || !rule.to) continue;
				rules.push(rule);
			}
			return { rules, excludes, globalInclude, globalIgnore, extends: extendsList };
		}
	}
	// Line parser fallback: ALL rule kinds, quoted or plain — the line grammar
	// is the load-bearing interface when YAML cannot represent the file (e.g.
	// `- regex: 'x(\w*)' => 'y$1'` is invalid YAML: quoted scalar + trailing
	// content).
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const excludeMatch = /^exclude:\s*(\S+)/.exec(trimmed);
		if (excludeMatch) { excludes.add(excludeMatch[1]); continue; }
		// Optional "- " YAML list-item prefix: the same file may be valid YAML
		// or the line-dialect, and rules inside `rules:` blocks are dashed.
		const ruleMatch = /^(?:-\s+)?(word|substr|regex|case|comby):\s*(.+?)\s*=>\s*(.+)$/.exec(trimmed);
		if (!ruleMatch) continue;
		rules.push({
			id: `${baseId}#${rules.length}`,
			kind: ruleMatch[1] as Rule["kind"],
			from: unquote(ruleMatch[2]),
			to: unquote(ruleMatch[3]),
			file,
		});
	}
	return { rules, excludes, globalInclude, globalIgnore, extends: extendsList };
}

/** Regex fallback: extract the bracket-list value of `key:` from raw text. */
export function extractBracketList(raw: string, key: string): string[] {
	const re = new RegExp(`^\\s*${key}:\\s*\\[(.*?)\\]`, "m");
	const match = re.exec(raw);
	if (!match) return [];
	return match[1].split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

/** Load multiple rule files; cross-file exclude armor + extends presets. */
export function loadRules(files: string[], _depth = 0): Parsed {
	const rules: Rule[] = [];
	const excludes = new Set<string>();
	const globalInclude: string[] = [];
	const globalIgnore: string[] = [];
	let extendsList: string[] = [];
	for (const file of files) {
		const parsed = parseRuleFile(file);
		rules.push(...parsed.rules);
		for (const token of parsed.excludes) excludes.add(token);
		globalInclude.push(...parsed.globalInclude);
		globalIgnore.push(...parsed.globalIgnore);
		extendsList.push(...parsed.extends);
	}
	// Presets (renovate borrow): resolved relative to the first file's dir,
	// depth-limited to prevent cycles.
	if (extendsList.length > 0 && _depth < 8) {
		const base = path.dirname(files[0]);
		const presetFiles = extendsList.map(e => path.resolve(base, e)).filter(f => fs.existsSync(f));
		const parent = loadRules(presetFiles, _depth + 1);
		rules.unshift(...parent.rules);
		for (const token of parent.excludes) excludes.add(token);
	}
	return { rules, excludes, globalInclude, globalIgnore, extends: extendsList };
}

/** Renovate-borrow file scoping: includePaths win, ignorePaths veto. */
export function pathAllowed(rel: string, rule: Rule, globalInclude: string[], globalIgnore: string[]): boolean {
	for (const pattern of [...(rule.ignorePaths ?? []), ...globalIgnore]) {
		if (matchGlob(pattern, rel)) return false;
	}
	const includes = [...(rule.includePaths ?? []), ...globalInclude];
	if (includes.length === 0) return true;
	return includes.some(pattern => matchGlob(pattern, rel));
}

/** Minimal glob: ** crosses segments, * within segment, ? single char. */
export function matchGlob(pattern: string, target: string): boolean {
	// Order matters: /** (suffix or mid-pattern) means "any depth", then bare
	// ** means "anything", then * stays within one segment.
	// Placeholder technique: escape first, then swap ordered wildcards through
	// sentinels (chained replace on the raw pattern double-replaced —
	// "packages/**" produced ^packages/(?:/.*)?$ which cannot match deep paths).
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const regexSrc = escaped
		.replace(/\*\*\//g, "\u0000ANYSEG\u0000")
		.replace(/\/\*\*/g, "/\u0000ANY\u0000")
		.replace(/\*\*/g, "\u0000ANY\u0000")
		.replace(/\*/g, "\u0000SEG\u0000")
		.replace(/\?/g, "\u0000ONE\u0000")
		.replace(/\u0000ANYSEG\u0000/g, "(?:.*/)?")
		.replace(/\u0000ANY\u0000/g, ".*")
		.replace(/\u0000SEG\u0000/g, "[^/]*")
		.replace(/\u0000ONE\u0000/g, ".");
	return new RegExp(`^${regexSrc}$`).test(target);
}

export interface ApplyResult {
	content: string;
	edits: number;
	map: Array<{ from: string; to: string; file: string }>;
}

/** Apply loaded rules to one file's content. Returns edits + rename map. */
export function applyRules(content: string, rules: Rule[], excludes: Set<string>, rel: string, globalInclude: string[] = [], globalIgnore: string[] = []): ApplyResult {
	let result = content;
	let edits = 0;
	const map: Array<{ from: string; to: string; file: string }> = [];
	for (const rule of rules) {
		if (!pathAllowed(rel, rule, globalInclude, globalIgnore)) continue;
		const before = result;
		if (rule.kind === "word") {
			result = result.replace(new RegExp(`\\b${rule.from}\\b`, "g"), match => (excludes.has(match) ? match : rule.to));
		} else if (rule.kind === "substr") {
			result = result.split(rule.from).join(rule.to);
		} else if (rule.kind === "regex") {
			result = result.replace(new RegExp(rule.from, "g"), rule.to);
		} else if (rule.kind === "case") {
			result = applyCasePreserving(result, rule.from, rule.to).content;
		} else if (rule.kind === "comby") {
			const compiled = combyToRegex(rule.from, rule.to);
			if (compiled) result = result.replace(compiled.pattern, compiled.replace);
		}
		if (result !== before) {
			edits++;
			map.push({ from: rule.from, to: rule.to, file: rel });
		}
	}
	return { content: result, edits, map };
}

// ---------------------------------------------------------------------------
// Detect rule family — orchid detectors (feature-flagged, generative, all-Bun)
// ---------------------------------------------------------------------------

export interface DetectOutcome {
	id: string;
	enabled: boolean;
	latencyMs: number;
	reason?: string;
	findings: Finding[];
}

export function stamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("detector-timeout")), ms))]);
}

/** Run every `detect:` rule in a manifest, feature-flag-gated, over the corpus.
 *  Emits an append-only findings journal + doorbell dispatch frame. */
export async function runDetectors(rules: Rule[], flagsOverride: string | undefined, runsDir: string): Promise<DetectOutcome[]> {
	const env = { ...process.env };
	if (flagsOverride) env.ORCHID_FLAGS = flagsOverride;
	const flags = resolveFlags(env);
	const corpus = resolveCorpus(env);
	const doorbell = makeDoorbell(runsDir);
	const ctx: Ctx = { corpus, runsDir, flags, apply: false };
	fs.mkdirSync(runsDir, { recursive: true });

	const ids = [...new Set(rules.filter(r => r.kind === "detect").map(r => r.from))];
	const outcomes: DetectOutcome[] = [];
	for (const id of ids) {
		const spec = flags[id];
		let mod;
		try {
			mod = await loadDetector(id);
		} catch (e) {
			outcomes.push({ id, enabled: false, latencyMs: 0, reason: `load-error: ${(e as Error).message}`, findings: [] });
			continue;
		}
		if (!mod) {
			outcomes.push({ id, enabled: false, latencyMs: 0, reason: "unknown-detector", findings: [] });
			continue;
		}
		if (!spec?.enabled) {
			outcomes.push({ id, enabled: false, latencyMs: 0, reason: "feature-flag-disabled", findings: [] });
			continue;
		}
		const t0 = performance.now();
		try {
			const res = await withTimeout(Promise.resolve(mod.run(ctx)), 20_000);
			outcomes.push({ id, enabled: true, latencyMs: Math.round(performance.now() - t0), findings: res.findings });
			for (const f of res.findings) {
				fs.appendFileSync(path.join(runsDir, ".orchid-findings.jsonl"), JSON.stringify(f) + "\n");
			}
		} catch (e) {
			outcomes.push({ id, enabled: true, latencyMs: Math.round(performance.now() - t0), reason: `error: ${(e as Error).message}`, findings: [] });
		}
	}
	// dispatch a run summary over the doorbell transport (spills locally too)
	await doorbell.dispatch({
		op: "GIT_SYNC_DISPATCH",
		agent: "lapidary:detect",
		remote: "dropbox:Sovereign/runs/orchid",
		event: "DETECT_RUN",
		ts: Date.now(),
		detectors: outcomes.map(o => ({ id: o.id, enabled: o.enabled, findings: o.findings.length })),
	});
	doorbell.close();
	return outcomes;
}

/** Benchmark: score detector outcomes against the verified ground-truth matrix
 *  and position against agentic-moment's log-helper (shipping) layer. */
export function runBenchmark(outcomes: DetectOutcome[], runsDir: string): any {
	const matrix = JSON.parse(
		fs.readFileSync(path.join(import.meta.dir, "..", "benchmark", "anomaly-matrix.json"), "utf8"),
	) as { anomalies: Array<{ gt: string; detector: string; artifact: string; evidence: string }> };
	const rows = matrix.anomalies.map(gt => {
		const out = outcomes.find(o => o.id === gt.detector);
		const detected = out?.findings.some(f => f.gt === gt.gt) ?? false;
		return {
			gt: gt.gt,
			detector: gt.detector,
			artifact: gt.artifact,
			detected,
			latencyMs: out?.latencyMs ?? 0,
			findings: out?.findings.length ?? 0,
			evidence: gt.evidence,
		};
	});
	const all = outcomes.flatMap(o => o.findings);
	const detected = rows.filter(r => r.detected).length;
	const total = rows.length;
	const truePos = all.filter(f => f.gt).length;
	// false positives = anomaly-category findings (warn/critical) with no GT;
	// info findings are mechanism demonstrations, not anomaly false alarms
	const falsePos = all.filter(f => !f.gt && (f.severity === "warn" || f.severity === "critical")).length;
	const demonstrations = all.filter(f => !f.gt && f.severity === "info").length;
	const report = {
		generatedAt: new Date().toISOString(),
		framework: "orchid-detect (lapidary detect rule family)",
		corpus: "verified /tmp artifacts",
		groundTruth: total,
		truePositives: truePos,
		falsePositives: falsePos,
		demonstrationFindings: demonstrations,
		precisionAllFindings: total ? +(truePos / Math.max(1, all.length)).toFixed(3) : 0,
		precisionAnomalyLabeled: total ? +(truePos / Math.max(1, truePos + falsePos)).toFixed(3) : 0,
		groundTruthRecall: +(detected / total).toFixed(3),
		coverage: `${detected}/${total}`,
		logHelperReady: {
			totalFindings: all.length,
			dedupeKeyed: all.filter(f => f.dedupe_key).length,
			pctDedupeKeyed: all.length ? Math.round((all.filter(f => f.dedupe_key).length / all.length) * 100) : 0,
		},
		compareWithAgenticMoment:
			"agentic-moment log-helper is the shipping/aggregation layer (canonical OpenTelemetry Collector, chosen by its datadog vs otel/vector/signoz semantic-ratio compare). orchid emits data-framed, dedupe-keyed detections that ride those collectors unchanged — it adds automated anomaly coverage over the corpus that the shipping layer alone does not perform.",
		rows,
		perDetector: outcomes.map(o => ({
			id: o.id,
			enabled: o.enabled,
			latencyMs: o.latencyMs,
			findings: o.findings.length,
			reason: o.reason,
		})),
	};
	fs.writeFileSync(path.join(runsDir, "benchmark.json"), JSON.stringify(report, null, 2));
	fs.writeFileSync(path.join(runsDir, "benchmark.md"), renderBenchmarkMd(report));
	return report;
}

function renderBenchmarkMd(report: Record<string, any>): string {
	const lines = [
		`# orchid-detect benchmark (lapidary)`,
		``,
		`Generated ${report.generatedAt} · framework **${report.framework}**`,
		``,
		`## Score`,
		``,
		`| metric | value |`,
		`|---|---|`,
		`| ground truth | ${report.groundTruth} anomalies |`,
		`| true positives | ${report.truePositives} |`,
		`| false positives | ${report.falsePositives} |`,
		`| ground-truth recall | ${(report.groundTruthRecall * 100).toFixed(1)}% (${report.coverage}) |`,
		`| log-helper dedupe-ready | ${report.logHelperReady.pctDedupeKeyed}% (${report.logHelperReady.totalFindings} findings) |`,
		``,
		`## Per-anomaly`,
		``,
		`| GT | detector | detected | latency ms | findings |`,
		`|---|---|---|---|---|`,
		...report.rows.map((r: any) => `| ${r.gt} | ${r.detector} | ${r.detected} | ${r.latencyMs} | ${r.findings} |`),
		``,
		`## vs agentic-moment`,
		``,
		`${report.compareWithAgenticMoment}`,
		``,
	];
	return lines.join("\n");
}

export function listTrackedFiles(repo: string): string[] {
	return execFileSync("git", ["ls-files", "-z"], { cwd: repo, maxBuffer: 1 << 28 }).toString().split("\0").filter(Boolean);
}

export function isSymlink(repo: string, rel: string): boolean {
	try { return fs.lstatSync(path.join(repo, rel)).isSymbolicLink(); } catch { return false; }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		console.log(`usage: lapidary --repo <dir> --rules <a.lapidary,b.lapidary> [--dry-run] [--commit "msg"] [--undo]
       lapidary --detect --rules <manifest.lapidary> [--flags ORCHID_FLAGS] [--bench]

detect rule family (orchid detectors, all-Bun, feature-flagged):
  - detect: a1_abscission   # and a2..a8 — see sources/orchid.lapidary
  --flags  ORCHID_FLAGS     # all | none | a1,a5 | a4=off (defaults from orchid.flags.json)
  --bench                   # score against benchmark/anomaly-matrix.json + emit report

schema (YAML .lapidary — ast-grep/renovate/comby borrow):
  id: <rule-id>
  extends: [preset.lapidary]          # presets
  includePaths: ["packages/**"]       # renovate scoping
  ignorePaths: ["**/dist/**"]
  exclude: [TOKEN, ...]               # cross-file armor
  rules:
    - word: pinax => mimetite         # legacy whole-word
    - substr: PINAX_ => MIMETITE_
    - regex: 'pinax(\\w*)' => 'mimetite$1'
    - case: pinax => mimetite         # camel/Pascal/snake/kebab/SCREAMING
    - comby: ':[[x]].pinax()' => ':[[x]].mimetite()'
legacy line format still accepted (forward-only alias).
emits: rename.map + .lapidary-undo.jsonl (reversible via --undo)`);
		process.exit(argv.includes("--help") ? 0 : 2);
	}
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const rulesArg = get("--rules") ?? get("--pairs"); // legacy alias
	const repo = get("--repo");
	const dryRun = argv.includes("--dry-run");
	const commitMsg = get("--commit");
	const undo = argv.includes("--undo");
	const detect = argv.includes("--detect");
	const flagsOverride = get("--flags");
	const bench = argv.includes("--bench");
	const runsDir = path.join(import.meta.dir, "..", "runs", stamp());

	if (detect) {
		// detect / --detect <manifest.lapidary> [--flags ORCHID_FLAGS] [--bench]
		if (!rulesArg) {
			console.error("lapidary: --detect requires --rules <manifest.lapidary>");
			process.exit(2);
		}
		void (async () => {
			const { rules } = loadRules(rulesArg.split(",").map(f => f.trim()));
			const outcomes = await runDetectors(rules, flagsOverride, runsDir);
			for (const o of outcomes) {
				console.log(`[detect] ${o.id} ${o.enabled ? `ran ${o.findings.length} finding(s) in ${o.latencyMs}ms` : `SKIPPED (${o.reason})`}`);
			}
			if (bench) {
				const report = runBenchmark(outcomes, runsDir);
				console.log(`[bench] recall=${(Number(report.groundTruthRecall) * 100).toFixed(1)}% coverage=${report.coverage} findings=${report.logHelperReady.totalFindings} -> ${path.join(runsDir, "benchmark.md")}`);
			} else {
				console.log(`[detect] journal -> ${path.join(runsDir, ".orchid-findings.jsonl")}`);
			}
		})().catch(e => {
			console.error(e);
			process.exit(1);
		});
		return;
	}
	if (!rulesArg || !repo) {
		console.error("lapidary: --repo and --rules are required");
		process.exit(2);
	}
	const ruleFiles = rulesArg.split(",").map(f => f.trim());
	const { rules, excludes, globalInclude, globalIgnore } = loadRules(ruleFiles);
	const undoPath = path.join(repo, ".lapidary-undo.jsonl");
	const mapOut: Array<{ from: string; to: string; file: string }> = [];
	let totalFiles = 0;
	let totalEdits = 0;

	if (undo) {
		const journal = fs.readFileSync(undoPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
		for (const entry of journal.reverse() as Array<{ file: string; before: string; hash: string }>) {
			const full = path.join(repo, entry.file);
			const current = fs.readFileSync(full, "utf8");
			if (createHash("sha256").update(current).digest("hex") === entry.hash) {
				fs.writeFileSync(full, entry.before);
				console.log(`undone: ${entry.file}`);
			} else {
				console.log(`skip (changed since): ${entry.file}`);
			}
		}
		return;
	}

	for (const rel of listTrackedFiles(repo)) {
		if (isSymlink(repo, rel)) continue;
		const full = path.join(repo, rel);
		let content: string;
		try {
			if (!fs.statSync(full).isFile()) continue;
			content = fs.readFileSync(full, "utf8");
		} catch { continue; }
		const applied = applyRules(content, rules, excludes, rel, globalInclude, globalIgnore);
		if (applied.edits === 0) continue;
		totalFiles++;
		totalEdits += applied.edits;
		mapOut.push(...applied.map);
		console.log(`== ${rel} ==`);
		if (!dryRun) {
			// sed-borrow reversibility: journal BEFORE writing.
			fs.appendFileSync(undoPath, JSON.stringify({
				file: rel,
				before: content,
				hash: createHash("sha256").update(applied.content).digest("hex"),
				at: new Date().toISOString(),
			}) + "\n");
			fs.writeFileSync(full, applied.content);
		}
	}
	console.log(`edits=${totalEdits} files=${totalFiles}${dryRun ? " (dry-run)" : ""}`);
	if (!dryRun) {
		fs.writeFileSync(path.join(repo, "rename.map"), JSON.stringify(mapOut, null, 2));
		if (commitMsg && totalFiles > 0) {
			execFileSync("git", ["add", "-A"], { cwd: repo });
			execFileSync("git", ["commit", "-m", commitMsg], { cwd: repo });
			console.log(`committed: ${commitMsg}`);
		}
	}
}

if (import.meta.main) main();
