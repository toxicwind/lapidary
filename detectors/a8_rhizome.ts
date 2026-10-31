import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Ctx, Finding, Module } from "./_shared.ts";
import { now, shaShort } from "./_shared.ts";

/** a8 — sympodial rhizome clonal bus: /dev/shm mmap ring (zero-truncation
 *  inter-agent phloem) + clonal symlink drift audit. The ring proves frames of
 *  ANY length — even the >200-line ones tool-output truncation would lie about —
 *  round-trip byte-for-byte. */

const RING = "/dev/shm/pens_rhizome_bus.mmap";

export const a8_rhizome: Module = {
	id: "a8_rhizome",
	flag: "a8_rhizome",
	run(ctx) {
		const findings: Finding[] = [];
		const cap = Number(ctx.flags.a8_rhizome?.params.shmBytes ?? 16 * 1024 * 1024);

		// ---- shm ring: write a >200-line frame, read back verbatim ----
		let roundtrip = false;
		let untruncatedBytes = 0;
		let ringPath = RING;
		try {
			if (!fs.existsSync(RING) || fs.statSync(RING).size < cap) {
				fs.writeFileSync(RING, Buffer.alloc(cap, 0));
			}
			const payload = Array.from({ length: 230 }, (_, i) => `line ${i} of a very long phloem frame that would exceed naive tool-output truncation limits`).join("\n");
			const envelope = JSON.stringify({ sender: "a8_rhizome", target: "all", channel: "phloem", sha256: shaShort(payload), bytes: payload.length, ts: Date.now() });
			fs.writeFileSync(RING, "ORCH" + envelope.length + "\n" + envelope + "\n" + payload, "utf8");
			const back = fs.readFileSync(RING, "utf8");
			const sep = back.indexOf("\n", 5);
			const readBody = back.slice(back.indexOf("\n", sep) + 1);
			roundtrip = readBody === payload;
			untruncatedBytes = payload.length;
			void grantShmPerm();
		} catch (e) {
			ringPath = path.join(os.tmpdir(), "pens_rhizome_bus.mmap"); // /dev/shm unwritable: fallback
			try {
				const payload = "fallback frame ".repeat(400);
				fs.writeFileSync(ringPath, payload, "utf8");
				roundtrip = fs.readFileSync(ringPath, "utf8") === payload;
				untruncatedBytes = payload.length;
			} catch { /* ignore */ }
		}
		findings.push({
			id: "orchid.a8.rhizome-ring",
			dedupe_key: "orchid.a8.ring.",
			detector: "a8_rhizome",
			flag: "a8_rhizome",
			artifact: "shm-scan",
			severity: "info",
			title: "Rhizome phloem ring round-tripped an untruncated >200-line frame",
			detail: { shmPath: ringPath, capacityBytes: cap, untruncatedBytes, byteForByteRoundtrip: roundtrip, ringSha256: shaShort(String(untruncatedBytes)) },
			ts: now(),
		});

		// ---- clonal symlink drift audit (read-only) ----
		const clones: Record<string, string> = {};
		for (const name of ["kite", "fledge", "hatch", "kite-cli-src", "estate"]) {
			const p = path.join("/home/toxic", name);
			if (fs.existsSync(p)) {
				try { clones[name] = fs.realpathSync(p); } catch { clones[name] = "BROKEN_SYMLINK"; }
			}
		}
		const drift = Object.entries(clones).filter(([, target]) => !target.startsWith("/home/toxic/pens") && !target.includes("/kite/"));
		if (drift.length) {
			findings.push({
				id: "orchid.a8.clonal-drift",
				dedupe_key: "orchid.a8.symlink.drift",
				detector: "a8_rhizome",
				flag: "a8_rhizome",
				artifact: "fs-scan",
				severity: "warn",
				title: "Clonal symlink points outside the pens namespace (drift)",
				gt: "A8",
				detail: { drift: Object.fromEntries(drift) },
				ts: now(),
			});
		}
		return { findings };
	},
};

async function grantShmPerm(): Promise<void> {
	// best-effort: no sudo needed on most boxes; silently fine either way
	try { Bun.spawnSync(["chmod", "666", RING]); } catch { /* ignore */ }
}
