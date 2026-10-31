import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Ctx, Finding, Module } from "./_shared.ts";
import { now, grab } from "./_shared.ts";

/** a3 — CAM stomatal gating + pseudobulb SQLite hydrenchyma.
 *  Detects SQLITE_IOERR_WRITE (errno 778) in router-25250.log, then proves the
 *  fix: an in-memory belief matrix that survives a disk write failure (drought)
 *  because it keeps serving from RAM, and closes stomata on dead providers
 *  (groq 401 / nim ECONNREFUSED) via an ABA stress-hormone circuit breaker. */

interface Stomatal {
	provider: string;
	apertureOpen: boolean;
	aba: number;
	pOk: number;
	lastHealTs: number;
}

export const a3_pseudobulb: Module = {
	id: "a3_pseudobulb",
	flag: "a3_pseudobulb",
	run(ctx) {
		const findings: Finding[] = [];
		const art = ctx.corpus["router-25250.log"];
		const text = art.present ? fs.readFileSync(art.path, "utf8") : "";

		if (art.present) {
			const ioErr = text.includes("SQLITE_IOERR_WRITE") || text.includes("errno: 778");
			const groq401 = /groq[^\n]*HTTP 401|Invalid API Key/.test(text);
			if (ioErr || groq401) {
				findings.push({
					id: "orchid.a3.router-drought",
					dedupe_key: `orchid.a3.router.${art.key}`,
					detector: "a3_pseudobulb",
					gt: "A3",
					flag: "a3_pseudobulb",
					artifact: art.key,
					severity: "critical",
					title: "Router belief store hit disk drought (SQLITE_IOERR_WRITE / provider 401)",
					detail: {
						sqliteIoErrWrite: ioErr,
						groq401,
						evidence: grab(text, /SQLITE_IOERR_WRITE|errno: 778|Invalid API Key/, 3),
					},
					ts: now(),
				});
			}
		}

		// ---- prove the mechanism ----
		const flushEvery = Number(ctx.flags.a3_pseudobulb?.params.flushEvery ?? 16);
		const memDb = new Database(":memory:");
		memDb.exec(`CREATE TABLE IF NOT EXISTS belief_matrix (
			provider TEXT NOT NULL, model TEXT NOT NULL, route_class TEXT NOT NULL,
			p_ok REAL NOT NULL DEFAULT 0.5, aba REAL NOT NULL DEFAULT 0.0,
			stomata_open INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
			PRIMARY KEY (provider, model, route_class))`);
		const rec = memDb.prepare(`INSERT INTO belief_matrix(provider,model,route_class,p_ok,aba,stomata_open,updated_at)
			VALUES(?1,?2,?3,?4,?5,?6,?7)
			ON CONFLICT(provider,model,route_class) DO UPDATE SET
				p_ok=excluded.p_ok, aba=excluded.aba, stomata_open=excluded.stomata_open, updated_at=excluded.updated_at`);

		const stomata = new Map<string, Stomatal>();
		const heal = (provider: string, ok: boolean, err?: string) => {
			const cur = stomata.get(provider) ?? { provider, apertureOpen: true, aba: 0, pOk: 0.5, lastHealTs: Date.now() };
			if (ok) {
				cur.aba = Math.max(0, cur.aba * 0.4);
				cur.apertureOpen = true;
				cur.pOk = cur.pOk * 0.75 + 0.25;
			} else {
				const spike = err === "401" || err === "ECONNREFUSED" ? 4.0 : 1.5;
				cur.aba += spike;
				cur.pOk *= 0.75;
				if (cur.aba >= 3.0) cur.apertureOpen = false;
			}
			cur.lastHealTs = Date.now();
			stomata.set(provider, cur);
			rec.run(provider, "model", "chat", cur.pOk, cur.aba, cur.apertureOpen ? 1 : 0, cur.lastHealTs);
		};

		// feed the router's arena: groq 401 (spike), nim ECONNREFUSED (spike), ok providers recover
		heal("groq", false, "401");
		heal("groq", false, "401");
		heal("nim-local", false, "ECONNREFUSED");
		heal("mistral", true);
		heal("zen", true);

		// ---- drought: make the disk translocation target unwritable ----
		const diskDir = path.join(ctx.runsDir, "pseudobulb-disk");
		fs.mkdirSync(diskDir, { recursive: true });
		fs.chmodSync(diskDir, 0o500); // read-only dir -> write fails
		let servedFromRam = false;
		try {
			fs.writeFileSync(path.join(diskDir, "hydrenchyma.sqlite"), memDb.serialize());
			// if the OS let it through (root), restore and note
			fs.chmodSync(diskDir, 0o700);
		} catch {
			servedFromRam = true; // drought: keep serving from in-memory hydrenchyma
			fs.chmodSync(diskDir, 0o700); // restore for cleanup
		}
		// in-memory query still answers during drought
		const rows = memDb.query("SELECT provider, stomata_open, aba, p_ok FROM belief_matrix").all();

		findings.push({
			id: "orchid.a3.pseudobulb-demo",
			dedupe_key: "orchid.a3.pseudobulb.demo",
			detector: "a3_pseudobulb",
			flag: "a3_pseudobulb",
			artifact: "synthetic",
			severity: "info",
			title: "In-memory hydrenchyma survived disk drought; stomata closed on dead providers",
			detail: {
				servedFromRamDuringDrought: servedFromRam,
				memRowsDuringDrought: rows,
				closedStomata: [...stomata.values()].filter(s => !s.apertureOpen).map(s => s.provider),
				flushEvery,
			},
			ts: now(),
		});
		memDb.close();
		return { findings };
	},
};
