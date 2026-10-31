/** Shared types for the orchid POC suite (all-Bun). */

export type Severity = "info" | "warn" | "critical";

/** A single detection. Every finding is data-framed and dedupe-ready so it can
 *  ride agentic-moment's log-helper pipeline unchanged. */
export interface Finding {
	/** stable event identity: `orchid.<detector>.<slug>` */
	id: string;
	/** proximity key for dedupe/upsert (log-helper contract) */
	dedupe_key: string;
	detector: string;
	/** ground-truth anomaly id (A1..A8) when this is a true positive, else undefined */
	gt?: string;
	flag: string;
	artifact: string;
	severity: Severity;
	title: string;
	detail: Record<string, unknown>;
	ts: string;
}

export interface ModuleResult {
	detector: string;
	enabled: boolean;
	reason?: string;
	latencyMs: number;
	findings: Finding[];
}

export interface FlagSpec {
	id: string;
	bio: string;
	enabled: boolean;
	params: Record<string, unknown>;
}

export interface CorpusEntry {
	key: string;
	path: string;
	bytes: number;
	present: boolean;
	kind: "log" | "jsonl" | "json" | "png" | "db" | "other";
}

export interface Ctx {
	corpus: Record<string, CorpusEntry>;
	runsDir: string;
	flags: Record<string, FlagSpec>;
	apply: boolean;
}

export interface Module {
	id: string;
	flag: string;
	/** runs against real artifacts; must be deterministic and non-destructive */
	run(ctx: Ctx): Promise<Omit<ModuleResult, "detector" | "enabled" | "reason">> | Omit<ModuleResult, "detector" | "enabled" | "reason">;
}


import * as fs from "node:fs";
import * as path from "node:path";

export function now(): string {
	return new Date().toISOString();
}

export function stamp(): string {
	return now().replace(/[:.]/g, "-").slice(0, 19);
}

export function ensureDir(p: string): string {
	fs.mkdirSync(p, { recursive: true });
	return p;
}

export function readMaybe(p: string): string | null {
	try {
		return fs.readFileSync(p, "utf8");
	} catch {
		return null;
	}
}

export function bytes(p: string): number {
	try {
		return fs.statSync(p).size;
	} catch {
		return 0;
	}
}

export function median(nums: number[]): number {
	const s = [...nums].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? -1;
}

export function sha256(s: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

export function shaShort(s: string | Uint8Array): string {
	return sha256(s).slice(0, 16);
}

/** bounded hit extraction: return up to n context lines matching /re/ */
export function grab(text: string, re: RegExp, n = 6, ctx = 90): string[] {
	const out: string[] = [];
	// matchAll requires a global regex; force the g flag regardless of input.
	const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
	const g = new RegExp(re.source, flags);
	for (const m of text.matchAll(g)) {
		const i = m.index ?? 0;
		out.push(text.slice(Math.max(0, i - 20), i + ctx).replace(/\s+/g, " ").trim());
		if (out.length >= n) break;
	}
	return out;
}

export function short(text: string, n = 140): string {
	return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

export function rel(root: string, p: string): string {
	return path.relative(root, p);
}


import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dir, ".");
const FLAGS_FILE = path.join(root, "orchid.flags.json");

interface FlagsFile {
	defaults: Record<string, { enabled: boolean; params: Record<string, unknown> }>;
	meta?: Record<string, unknown>;
}

/**
 * Dynamic feature-flag resolution.
 * 1. flags.json (defaults layer)
 * 2. ORCHID_FLAGS env: `all` | `none` | `a1,a5` | `a4=off,a2.params.budgetMb=128`
 * Returns every known flag with its resolved enabled/params, so the orchestrator
 * (and the agentic `doctor`) can select generatively at runtime.
 */
export function resolveFlags(env: NodeJS.ProcessEnv = process.env): Record<string, FlagSpec> {
	const file: FlagsFile = JSON.parse(fs.readFileSync(FLAGS_FILE, "utf8"));
	const out: Record<string, FlagSpec> = {};
	for (const [id, spec] of Object.entries(file.defaults)) {
		out[id] = {
			id,
			bio: bioOf(id),
			enabled: spec.enabled,
			params: { ...spec.params },
		};
	}

	const override = (env.ORCHID_FLAGS ?? "").trim();
	if (override && override !== "all") {
		if (override === "none") {
			for (const f of Object.values(out)) f.enabled = false;
		} else {
			const on = new Set<string>();
			for (const part of override.split(",")) {
				const [key, val] = part.split("=");
				const k = key.trim();
				if (k === "all") continue;
				if (k === "none") { for (const f of Object.values(out)) f.enabled = false; continue; }
				if (k === "all" || k === "*") { on.add("*"); continue; }
				if (out[k]) {
					if (val === undefined || val === "on" || val === "true" || val === "1") {
						out[k].enabled = true;
					} else if (val === "off" || val === "false" || val === "0") {
						out[k].enabled = false;
					} else if (val.startsWith("params.")) {
						// a1.params.ethyleneThresholdMs=900
						const pKey = val.slice("params.".length).split("=")[0].trim();
						const pVal = val.slice(val.indexOf("=") + 1);
						(out[k].params as Record<string, unknown>)[pKey] = coerce(pVal);
					}
				}
				on.add(k);
			}
			// a bare enable list like `a1,a5`
			if (on.size > 0 && !on.has("*")) {
				for (const f of Object.values(out)) if (!on.has(f.id)) f.enabled = false;
			}
		}
	}
	return out;
}

function coerce(v: string): unknown {
	if (v === "true") return true;
	if (v === "false") return false;
	const n = Number(v);
	if (v !== "" && !Number.isNaN(n)) return n;
	return v;
}

function bioOf(id: string): string {
	const bios: Record<string, string> = {
		a1_abscission: "ethylene-auxin abscission zone: sever stalled child/test branches (cgroup.kill guillotine + process-group fallback)",
		a2_velamen: "velamen build capacitor: isolated spill dir + autolytic scavenger so builds never saturate /tmp",
		a3_pseudobulb: "CAM stomatal sqlite hydrenchyma: in-memory belief store w/ disk translocation + ABA circuit breakers",
		a4_aquaporin: "extra-xylary wire witness: model-spoof audit + cryptographic signature chain + pcap/proc seals",
		a5_phloem: "ATG8 phloem autophagy gate: HUD velocity/compaction detection + generative write-first lock",
		a6_meristem: "dormant-pseudobulb rain-root: NUL-hole scrub + argos/xerj bin resolution + tailscale poke health",
		a7_passage: "exodermal passage-cell filter: strips code-token typos, decodes kinetic architect keystroke pelotons",
		a8_rhizome: "sympodial rhizome bus: /dev/shm mmap ring (zero-truncation) + clonal symlink audit",
	};
	return bios[id] ?? id;
}


import * as fs from "node:fs";
import * as path from "node:path";

/** Whitepaper log corpus — real artifacts, resolved dynamically.
 *  Default root /tmp; override with ORCHID_CORPUS_DIR. */
const NAMES: Array<[string, string]> = [
	["kappa-suite-serial.log", "log"],
	["rig-build.log", "log"],
	["router-25250.log", "log"],
	["argos-boot.log", "log"],
	["keepalive-tailscale.json", "json"],
	["typo-final.json", "json"],
	["tau-llm-request-15bbdb3a55c4cce4.json", "jsonl"],
	["tau-llm-request-15bb6931625ec2fc.json", "jsonl"],
];

export function resolveCorpus(env: NodeJS.ProcessEnv = process.env): Record<string, CorpusEntry> {
	const dir = env.ORCHID_CORPUS_DIR ?? "/tmp";
	const out: Record<string, CorpusEntry> = {};
	for (const [name, kind] of NAMES) {
		const p = path.join(dir, name);
		const present = fs.existsSync(p);
		out[name] = {
			key: name,
			path: p,
			bytes: present ? fs.statSync(p).size : 0,
			present,
			kind: kind as CorpusEntry["kind"],
		};
	}
	return out;
}

export function corpusSummary(c: Record<string, CorpusEntry>): { present: number; missing: string[]; totalBytes: number } {
	const present = Object.values(c).filter(x => x.present);
	const missing = Object.values(c).filter(x => !x.present).map(x => x.key);
	return {
		present: present.length,
		missing,
		totalBytes: present.reduce((a, x) => a + x.bytes, 0),
	};
}


import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** Dropbox-fast-socket-save over /tmp/ferret_doorbell.sock (AF_UNIX SOCK_STREAM,
 *  GIT_SYNC_DISPATCH framing) — the whitepaper's persistence transport.
 *
 *  The real socket is absent on this box (it belongs to a ferret-den/agentic-moment
 *  hook that is not running), so the POC owns a short-lived AF_UNIX listener at
 *  a RANDOM path (session-scoped, never the real one) plus a local run-dir spill.
 *  Frames are validated and spilled to runsDir/doorbell/<ts>.jsonl on the same
 *  schema the real dispatcher would consume. */

export interface DoorbellFrame {
	op: "GIT_SYNC_DISPATCH";
	agent: string;
	remote: string;
	event: string;
	ts: number;
	[key: string]: unknown;
}

export interface Doorbell {
	socketPath: string;
	/** local spill dir */
	spillDir: string;
	dispatch(frame: DoorbellFrame): Promise<boolean>;
	/** release the listener + socket path; MUST be called or the process hangs */
	close(): void;
}

export function makeDoorbell(runsDir: string): Doorbell {
	const spillDir = path.join(runsDir, "doorbell");
	fs.mkdirSync(spillDir, { recursive: true });
	// session-scoped socket — random path so we never collide with the real one
	const socketPath = path.join(os.tmpdir(), `ferret_doorbell_${process.pid}_${Date.now()}.sock`);

	const listener = net.createServer(sock => {
		sock.setEncoding("utf8");
		let buf = "";
		sock.on("data", d => {
			buf += d;
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				appendFrame(spillDir, line);
			}
		});
		sock.on("end", () => {
			if (buf.trim()) appendFrame(spillDir, buf);
		});
	});
	listener.listen(socketPath);

	return {
		socketPath,
		spillDir,
		dispatch(frame) {
			return new Promise(resolve => {
				const sock = net.createConnection({ path: socketPath });
				const timer = setTimeout(() => {
					sock.destroy();
					// never block: also spill locally so evidence survives even if framing fails
					appendFrame(spillDir, JSON.stringify(frame));
					resolve(false);
				}, 350);
				sock.on("connect", () => {
					sock.end(JSON.stringify(frame) + "\n", () => {
						clearTimeout(timer);
						resolve(true);
					});
				});
				sock.on("error", () => {
					clearTimeout(timer);
					appendFrame(spillDir, JSON.stringify(frame));
					resolve(false);
				});
			});
		},
		close() {
			try { listener.close(); } catch { /* ignore */ }
			try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
		},
	};
}

function appendFrame(spillDir: string, line: string): void {
	try {
		const obj = JSON.parse(line);
		const rec = typeof obj === "object" && obj ? obj : { payload: line };
		fs.appendFileSync(
			path.join(spillDir, "frames.jsonl"),
			JSON.stringify({ receivedAt: now(), ...(typeof rec === "object" ? rec : { payload: String(rec) }) }) + "\n",
			"utf8",
		);
	} catch {
		fs.appendFileSync(path.join(spillDir, "frames.jsonl"), line + "\n", "utf8");
	}
}
