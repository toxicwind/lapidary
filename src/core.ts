/**
 * core.ts — lapidary shared engine: rule parsing/application, file walking,
 * journaling, and the orchid-detect runners. Everything the subcommand
 * modules share lives here; commands/ only hold their own dispatch.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Ctx, Finding } from "../detectors/_shared.ts";
import { makeDoorbell, resolveCorpus, resolveFlags } from "../detectors/_shared.ts";
import { loadDetector } from "../detectors/registry.ts";

export interface WalkConfig {
	dots: boolean;
	hidden: boolean;
	parent: boolean;
	parent_dir: string;
}

function loadEnvDefaults(): WalkConfig {
	const envFile = path.join(import.meta.dir, "..", "..", ".env");
	let envDots = process.env.LAPIDARY_DOTS;
	let envHidden = process.env.LAPIDARY_HIDDEN;
	let envParent = process.env.LAPIDARY_PARENT;
	let envParentDir = process.env.LAPIDARY_PARENT_DIR;
	if (fs.existsSync(envFile)) {
		try {
			const content = fs.readFileSync(envFile, "utf8");
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const [k, ...rest] = trimmed.split("=");
				const v = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
				if (k === "LAPIDARY_DOTS" && envDots === undefined) envDots = v;
				if (k === "LAPIDARY_HIDDEN" && envHidden === undefined) envHidden = v;
				if (k === "LAPIDARY_PARENT" && envParent === undefined) envParent = v;
				if (k === "LAPIDARY_PARENT_DIR" && envParentDir === undefined) envParentDir = v;
			}
		} catch {}
	}
	return {
		dots: envDots !== undefined ? envDots === "true" || envDots === "1" : true,
		hidden: envHidden !== undefined ? envHidden === "true" || envHidden === "1" : true,
		parent: envParent !== undefined ? envParent === "true" || envParent === "1" : true,
		parent_dir: envParentDir || "/home/toxic/",
	};
}

export const defaultWalkConfig: WalkConfig = loadEnvDefaults();

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

export function applyCasePreserving(content: string, from: string, to: string): { content: string; count: number } {
	let count = 0;
	let result = content;
	for (const style of Object.values(CASE_STYLES)) {
		const variant = style(from);
		const replacement = style(to);
		if (variant === replacement) continue;
		const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		result = result.replace(new RegExp(`\\b${escaped}(?![a-z])`, "g"), () => { count++; return replacement; });
	}
	return { content: result, count };
}

export function combyToRegex(match: string, rewrite: string): { pattern: RegExp; replace: (m: RegExpMatchArray) => string } | null {
	const holes: string[] = [];
	const patternSrc = match.replace(/:\[\[(\w+)\]\]|./gs, (token, name) => {
		if (name) { holes.push(name); return `(?<${name}>.+?)`; }
		return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	});
	if (holes.length === 0) return null;
	return {
		pattern: new RegExp(patternSrc, "g"),
		replace: (...args: Array<unknown>) => {
			const groups = args[args.length - 1] as Record<string, string> | undefined;
			return rewrite.replace(/:\[\[(\w+)\]\]/g, (_, name) => groups?.[name] ?? "");
		},
	};
}

const unquote = (s: string): string => {
	const t = s.trim();
	if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
	return t;
};

export function parseRuleFile(file: string): Parsed {
	const raw = fs.readFileSync(file, "utf8");
	const rules: Rule[] = [];
	const excludes = new Set<string>();
	const globalInclude: string[] = [];
	const globalIgnore: string[] = [];
	let extendsList: string[] = [];
	const baseId = path.basename(file).replace(/\.lapidary$/, "");
	if (/^rules:\s*$/m.test(raw) || /^detectors:\s*$/m.test(raw) || /^id:\s/m.test(raw)) {
		let doc: Record<string, unknown> = {};
		let yamlOk = false;
		try { doc = Bun.YAML.parse(raw) as Record<string, unknown>; yamlOk = Array.isArray(doc.rules); } catch { doc = {}; }
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
		const detectorList = (doc?.detectors as Array<Record<string, unknown>> | undefined) ?? null;
		if (doc && Array.isArray(detectorList)) {
			for (const entry of detectorList) {
				if (!entry || typeof entry.detect !== "string") continue;
				rules.push({ id: (entry.id as string) ?? `${baseId}#detect`, kind: "detect", from: entry.detect, to: typeof entry.params === "string" ? entry.params : "", file });
			}
		}
		if (yamlOk) {
			const yamlRules = (doc.rules as Array<Record<string, unknown>>) ?? [];
			for (const [i, entry] of yamlRules.entries()) {
				const id = (entry.id as string) ?? `${baseId}#${i}`;
				for (const token of ((entry.exclude as string[]) ?? [])) excludes.add(token);
				const rule: Rule = { id, kind: "substr", from: "", to: "", file, includePaths: (entry.includePaths as string[]) ?? (entry.filePatterns as string[]), ignorePaths: (entry.ignorePaths as string[]) ?? (entry.ignore as string[]) };
				const entryValue = (entry.word ?? entry.regex ?? entry.case ?? entry.comby ?? entry.substr) as string | undefined;
				const entryKind = entry.word !== undefined ? "word" : entry.regex !== undefined ? "regex" : entry.case !== undefined ? "case" : entry.comby !== undefined ? "comby" : "substr";
				if (entryValue !== undefined && typeof entryValue === "string") {
					const [from, to] = entryValue.split("=>").map(s => unquote(s));
					rule.kind = entryKind as Rule["kind"];
					rule.from = from; rule.to = to;
				} else if (typeof entry.fix === "string" && typeof entry.match === "string") {
					rule.kind = "comby"; rule.from = entry.match; rule.to = entry.fix;
				} else { continue; }
				if (!rule.from || !rule.to) continue;
				rules.push(rule);
			}
			return { rules, excludes, globalInclude, globalIgnore, extends: extendsList };
		}
	}
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const excludeMatch = /^exclude:\s*(\S+)/.exec(trimmed);
		if (excludeMatch) { excludes.add(excludeMatch[1]); continue; }
		const ruleMatch = /^(?:-\s+)?(word|substr|regex|case|comby):\s*(.+?)\s*=>\s*(.+)$/.exec(trimmed);
		if (!ruleMatch) continue;
		rules.push({ id: `${baseId}#${rules.length}`, kind: ruleMatch[1] as Rule["kind"], from: unquote(ruleMatch[2]), to: unquote(ruleMatch[3]), file });
	}
	return { rules, excludes, globalInclude, globalIgnore, extends: extendsList };
}

export function extractBracketList(raw: string, key: string): string[] {
	const re = new RegExp(`^\\s*${key}:\\s*\\[(.*?)\\]`, "m");
	const match = re.exec(raw);
	if (!match) return [];
	return match[1].split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

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
	if (extendsList.length > 0 && _depth < 8) {
		const base = path.dirname(files[0]);
		const presetFiles = extendsList.map(e => path.resolve(base, e)).filter(f => fs.existsSync(f));
		const parent = loadRules(presetFiles, _depth + 1);
		rules.unshift(...parent.rules);
		for (const token of parent.excludes) excludes.add(token);
	}
	return { rules, excludes, globalInclude, globalIgnore, extends: extendsList };
}

export function pathAllowed(rel: string, rule: Rule, globalInclude: string[], globalIgnore: string[]): boolean {
	for (const pattern of [...(rule.ignorePaths ?? []), ...globalIgnore]) { if (matchGlob(pattern, rel)) return false; }
	const includes = [...(rule.includePaths ?? []), ...globalInclude];
	if (includes.length === 0) return true;
	return includes.some(pattern => matchGlob(pattern, rel));
}

export function matchGlob(pattern: string, target: string): boolean {
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
			if (compiled) result = result.replace(compiled.pattern, compiled.replace as (...args: any[]) => string);
		}
		if (result !== before) { edits++; map.push({ from: rule.from, to: rule.to, file: rel }); }
	}
	return { content: result, edits, map };
}

// ─── detect / journal ───────────────────────────────────────────────────────

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

const RUNS_ROOT = path.join(import.meta.dir, "..", "..", "runs");
const LOG_TTL_DAYS = Number(process.env.LAPIDARY_LOG_TTL_DAYS ?? 14);

export function journalRun(entry: { mode: string; repo?: string; edits?: number; files?: number; stale?: number; extra?: Record<string, unknown>; }): void {
	try {
		fs.mkdirSync(RUNS_ROOT, { recursive: true });
		fs.appendFileSync(path.join(RUNS_ROOT, "runs.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
	} catch {}
}

export function pruneExpiredLogs(): number {
	const cutoff = Date.now() - LOG_TTL_DAYS * 86_400_000;
	let pruned = 0;
	try {
		const journal = path.join(RUNS_ROOT, "runs.jsonl");
		if (fs.existsSync(journal)) {
			const keep: string[] = [];
			for (const line of fs.readFileSync(journal, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try { const rec = JSON.parse(line); if (Date.parse(rec.at) >= cutoff) keep.push(line); else pruned++; } catch { pruned++; }
			}
			fs.writeFileSync(journal, keep.length ? keep.join("\n") + "\n" : "");
		}
		for (const d of fs.existsSync(RUNS_ROOT) ? fs.readdirSync(RUNS_ROOT) : []) {
			const full = path.join(RUNS_ROOT, d);
			if (d === "runs.jsonl" || !fs.statSync(full).isDirectory()) continue;
			if (fs.statSync(full).mtimeMs < cutoff) { fs.rmSync(full, { recursive: true, force: true }); pruned++; }
		}
	} catch {}
	return pruned;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("detector-timeout")), ms))]);
}

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
		try { mod = await loadDetector(id); } catch (e) { outcomes.push({ id, enabled: false, latencyMs: 0, reason: `load-error: ${(e as Error).message}`, findings: [] }); continue; }
		if (!mod) { outcomes.push({ id, enabled: false, latencyMs: 0, reason: "unknown-detector", findings: [] }); continue; }
		if (!spec?.enabled) { outcomes.push({ id, enabled: false, latencyMs: 0, reason: "feature-flag-disabled", findings: [] }); continue; }
		const t0 = performance.now();
		try {
			const res = await withTimeout(Promise.resolve(mod.run(ctx)), 20_000);
			outcomes.push({ id, enabled: true, latencyMs: Math.round(performance.now() - t0), findings: res.findings });
			for (const f of res.findings) fs.appendFileSync(path.join(runsDir, ".orchid-findings.jsonl"), JSON.stringify(f) + "\n");
		} catch (e) {
			outcomes.push({ id, enabled: true, latencyMs: Math.round(performance.now() - t0), reason: `error: ${(e as Error).message}`, findings: [] });
		}
	}
	await doorbell.dispatch({ op: "GIT_SYNC_DISPATCH", agent: "lapidary:detect", remote: "dropbox:Sovereign/runs/orchid", event: "DETECT_RUN", ts: Date.now(), detectors: outcomes.map(o => ({ id: o.id, enabled: o.enabled, findings: o.findings.length })) });
	doorbell.close();
	return outcomes;
}

export function runBenchmark(outcomes: DetectOutcome[], runsDir: string): any {
	const matrix = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "..", "benchmark", "anomaly-matrix.json"), "utf8")) as { anomalies: Array<{ gt: string; detector: string; artifact: string; evidence: string }> };
	const rows = matrix.anomalies.map(gt => {
		const out = outcomes.find(o => o.id === gt.detector);
		const detected = out?.findings.some(f => f.gt === gt.gt) ?? false;
		return { gt: gt.gt, detector: gt.detector, artifact: gt.artifact, detected, latencyMs: out?.latencyMs ?? 0, findings: out?.findings.length ?? 0, evidence: gt.evidence };
	});
	const all = outcomes.flatMap(o => o.findings);
	const detected = rows.filter(r => r.detected).length;
	const total = rows.length;
	const truePos = all.filter(f => f.gt).length;
	const falsePos = all.filter(f => !f.gt && (f.severity === "warn" || f.severity === "critical")).length;
	const demonstrations = all.filter(f => !f.gt && f.severity === "info").length;
	const report = {
		generatedAt: new Date().toISOString(),
		framework: "orchid-detect (lapidary detect rule family)",
		corpus: "verified /tmp artifacts",
		groundTruth: total, truePositives: truePos, falsePositives: falsePos, demonstrationFindings: demonstrations,
		precisionAllFindings: total ? +(truePos / Math.max(1, all.length)).toFixed(3) : 0,
		precisionAnomalyLabeled: total ? +(truePos / Math.max(1, truePos + falsePos)).toFixed(3) : 0,
		groundTruthRecall: +(detected / total).toFixed(3), coverage: `${detected}/${total}`,
		logHelperReady: { totalFindings: all.length, dedupeKeyed: all.filter(f => f.dedupe_key).length, pctDedupeKeyed: all.length ? Math.round((all.filter(f => f.dedupe_key).length / all.length) * 100) : 0 },
		rows, perDetector: outcomes.map(o => ({ id: o.id, enabled: o.enabled, latencyMs: o.latencyMs, findings: o.findings.length, reason: o.reason })),
	};
	fs.writeFileSync(path.join(runsDir, "benchmark.json"), JSON.stringify(report, null, 2));
	fs.writeFileSync(path.join(runsDir, "benchmark.md"), renderBenchmarkMd(report));
	const siteDir = path.join(import.meta.dir, "..", "..", "site");
	fs.mkdirSync(siteDir, { recursive: true });
	fs.writeFileSync(path.join(siteDir, "index.html"), renderBenchmarkSite(report));
	return report;
}

export function renderBenchmarkSite(report: Record<string, any>): string {
	const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"]/g, c => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;");
	const rows = (report.rows as Array<Record<string, any>>).map(r => `<tr><td>${esc(r.gt)}</td><td>${esc(r.detector)}</td><td>${esc(r.artifact)}</td><td class="${r.detected ? "win" : "lose"}">${r.detected ? "✓" : "✗"}</td><td>${esc(r.latencyMs)}</td><td>${esc(r.findings)}</td></tr>`).join("\n");
	const per = (report.perDetector as Array<Record<string, any>>).map(d => `<tr><td>${esc(d.id)}</td><td>${d.enabled ? "on" : "off"}</td><td>${esc(d.latencyMs)}ms</td><td>${esc(d.findings)}</td><td>${esc(d.reason ?? "-")}</td></tr>`).join("\n");
	const json = JSON.stringify(report);
	return `<!doctype html><html><head><meta charset="utf-8"><title>lapidary · orchid-detect compare</title>
<style>body{background:#0d1117;color:#c9d1d9;font-family:ui-monospace,monospace;max-width:1000px;margin:2rem auto;padding:0 1rem}h1{color:#79c0ff}h2{color:#58a6ff}a{color:#58a6ff}table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #30363d;padding:6px 10px;text-align:left}th{background:#161b22}.win{color:#7ee787;font-weight:700}.lose{color:#f85149;font-weight:700}.kpi{display:flex;gap:2rem;flex-wrap:wrap}.kpi b{display:block;font-size:1.6rem;color:#79c0ff}</style></head><body>
<h1>🔬 lapidary — orchid-detect</h1>
<p>generated ${esc(report.generatedAt)} · framework <b>${esc(report.framework)}</b></p>
<div class="kpi"><div>ground truth<b>${esc(report.groundTruth)}</b></div><div>recall<b>${(Number(report.groundTruthRecall) * 100).toFixed(0)}%</b></div><div>true+<b>${esc(report.truePositives)}</b></div><div>false+<b>${esc(report.falsePositives)}</b></div><div>dedupe-ready<b>${esc(report.logHelperReady.pctDedupeKeyed)}%</b></div></div>
<h2>Score</h2><table><tr><th>GT</th><th>detector</th><th>artifact</th><th>detected</th><th>lat ms</th><th>findings</th></tr>${rows}</table>
<h2>Per detector</h2><table><tr><th>module</th><th>flag</th><th>lat ms</th><th>findings</th><th>note</th></tr>${per}</table>
<h2>vs agentic-moment</h2><p>${esc(report.compareWithAgenticMoment)}</p>
<pre id="data" style="display:none">${json.replace(/</g, "\\u003c")}</pre>
</body></html>`;
}

function renderBenchmarkMd(report: Record<string, any>): string {
	return [
		`# orchid-detect benchmark (lapidary)`, ``, `Generated ${report.generatedAt} · framework **${report.framework}**`, ``,
		`## Score`, ``, `| metric | value |`, `|---|---|`,
		`| ground truth | ${report.groundTruth} anomalies |`, `| true positives | ${report.truePositives} |`, `| false positives | ${report.falsePositives} |`,
		`| ground-truth recall | ${(report.groundTruthRecall * 100).toFixed(1)}% (${report.coverage}) |`, `| log-helper dedupe-ready | ${report.logHelperReady.pctDedupeKeyed}% (${report.logHelperReady.totalFindings} findings) |`,
		``, `## Per-anomaly`, ``, `| GT | detector | detected | latency ms | findings |`, `|---|---|---|---|---|`,
		...report.rows.map((r: any) => `| ${r.gt} | ${r.detector} | ${r.detected} | ${r.latencyMs} | ${r.findings} |`),
		``, `## vs agentic-moment`, ``, `${report.compareWithAgenticMoment}`, ``,
	].join("\n");
}

// ─── git + walking ──────────────────────────────────────────────────────────

let _gitBin: string | null = null;
export function resolveGit(): string {
	if (_gitBin) return _gitBin;
	const candidates = ["/usr/bin/git", "/usr/local/bin/git", "/bin/git", Bun.which("git")].filter((p): p is string => Boolean(p));
	for (const p of candidates) {
		try { execFileSync(p, ["--version"], { stdio: "ignore" }); _gitBin = p; return p; } catch { /* next */ }
	}
	_gitBin = "git";
	return _gitBin;
}

export function listTrackedFiles(repo: string): string[] {
	return execFileSync(resolveGit(), ["ls-files", "-z"], { cwd: repo, maxBuffer: 1 << 28 }).toString().split("\0").filter(Boolean);
}

export function walkFiles(repo: string, cfg: WalkConfig = defaultWalkConfig): string[] {
	const out: string[] = [];
	const roots = [repo];
	if (cfg.parent && cfg.parent_dir && fs.existsSync(cfg.parent_dir) && cfg.parent_dir !== repo) roots.push(cfg.parent_dir);
	for (const base of roots) {
		const stack: string[] = [""];
		while (stack.length) {
			const rel = stack.pop()!;
			const abs = path.join(base, rel);
			let entries: fs.Dirent[];
			try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
			for (const e of entries) {
				if (e.name === ".git") continue;
				const isDot = e.name.startsWith(".");
				if (isDot && (!cfg.dots || !cfg.hidden)) continue;
				const relChild = rel ? `${rel}/${e.name}` : e.name;
				if (e.isDirectory()) { if (e.name === "node_modules") continue; stack.push(relChild); }
				else if (e.isFile()) out.push(base === repo ? relChild : path.join(base, relChild));
			}
		}
	}
	return out.sort();
}

export function listAllFiles(repo: string): string[] {
	let tracked: string[];
	try { tracked = listTrackedFiles(repo); } catch { console.error(`lapidary: git unavailable in this runtime — falling back to filesystem walk of ${repo}`); return walkFiles(repo); }
	if (tracked.length === 0) { console.error(`lapidary: git returned no files for ${repo} — falling back to filesystem walk`); return walkFiles(repo); }
	let untracked: string[] = [];
	try { untracked = execFileSync(resolveGit(), ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: repo, maxBuffer: 1 << 28 }).toString().split("\0").filter(Boolean); } catch { /* tracked is the floor */ }
	const seen = new Set(tracked);
	for (const f of untracked) if (!seen.has(f)) tracked.push(f);
	return tracked;
}

export function isSymlink(repo: string, rel: string): boolean {
	try { return fs.lstatSync(path.join(repo, rel)).isSymbolicLink(); } catch { return false; }
}

const PENS_PRUNE = new Set(["node_modules", ".git", ".jj", "target", "dist", "build", ".cache", ".npm", "installs", "blobs", "sessions", "cache", "__pycache__", ".venv", "venv", "runs", ".consolidate-backup-20261106"]);
export function walkPens(root = "/home/toxic/pens"): string[] {
	const out: string[] = [];
	const stack: string[] = [""];
	while (stack.length) {
		const rel = stack.pop()!;
		const abs = path.join(root, rel);
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
		for (const e of entries) {
			if (PENS_PRUNE.has(e.name)) continue;
			const relChild = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) stack.push(relChild);
			else if (e.isFile()) out.push(relChild);
		}
	}
	return out.sort();
}

export function readTextIfSafe(full: string): string | null {
	try {
		if (!fs.statSync(full).isFile()) return null;
		const sniff = Buffer.from(fs.readFileSync(full).subarray(0, 8192));
		if (sniff.includes(0)) return null;
		let fffd = 0;
		for (let i = 0; i + 2 < sniff.length; i += 1) { if (sniff[i] === 0xef && sniff[i + 1] === 0xbf && sniff[i + 2] === 0xbd) { fffd += 1; i += 2; } }
		if (fffd > 4) return null;
		return fs.readFileSync(full, "utf8");
	} catch { return null; }
}

export function journalWrite(undoPath: string, rel: string, before: string, after: string): void {
	fs.appendFileSync(undoPath, JSON.stringify({ file: rel, before, hash: createHash("sha256").update(after).digest("hex"), at: new Date().toISOString() }) + "\n");
}