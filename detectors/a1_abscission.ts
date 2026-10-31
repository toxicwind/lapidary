import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Ctx, Finding, Module } from "./_shared.ts";
import { now, shaShort, grab } from "./_shared.ts";

/** a1 — ethylene-auxin Abscission Zone: cgroup.v2 guillotine + pgroup fallback.
 *  Detects the 60001ms child-session hang in kappa-suite-serial.log, then
 *  PROVES severance by spawning a stuck branch (grandchild included) and
 *  freezing->killing it at the AUXIN_COLLAPSE threshold. Non-destructive:
 *  only touches its own scratch cgroup + pgroup; never kappa's live suite. */

export const a1_abscission: Module = {
	id: "a1_abscission",
	flag: "a1_abscission",
	async run(ctx) {
		const findings: Finding[] = [];
		const art = ctx.corpus["kappa-suite-serial.log"];
		const text = art.present ? fs.readFileSync(art.path, "utf8") : "";

		// 1) detect the hang in the real artifact
		if (art.present) {
			const summary = text.match(/296 files \| \d+ passed \| \d+ failed \| [\d.]+s/)?.[0];
			const hang = text.match(/cancel(s|ling)?s? child session when abort signal fires\s*\[(\d+\.?\d*)ms\]/);
			if (summary || hang) {
				findings.push({
					id: "orchid.a1.hang-detected",
					dedupe_key: `orchid.a1.hang.${art.key}`,
					detector: "a1_abscission",
					gt: "A1",
					flag: "a1_abscission",
					artifact: art.key,
					severity: "critical",
					title: "Un-abscised child session hung the serial suite",
					detail: {
						summary: summary ?? null,
						hangMs: hang?.[2] ? Number(hang[2]) : null,
						evidence: grab(text, /child session when abort signal fires/, 1),
					},
					ts: now(),
				});
			}
		}

		// 2) PROVE severance: spawn a stuck branch + grandchild, guillotine it
		const threshold = Number(ctx.flags.a1_abscission?.params.ethyleneThresholdMs ?? 1800);
		const maxMs = Number(ctx.flags.a1_abscission?.params.maxChildMs ?? 5000);
		const id = `az_${process.pid}_${Date.now()}`;

		// child: prints (auxin flow) once, then stalls; spawns a 30s grandchild,
		// writing the grandchild pid to a scratch file (avoids stream-decode races)
		const pidFile = path.join(os.tmpdir(), `orchid_a1_gc_${process.pid}`);
		// A guaranteed-hang child (bun -e, tight loop) + a same-pgroup grandchild,
		// so the cgroup/pgroup guillotine is PROVEN against a truly stuck branch.
		const childScript =
			"const fs=require('fs');" +
			"fs.writeFileSync(process.env.OGC_GCFILE, String(require('child_process').spawn('sleep',['30']).pid));" +
			"console.log('AUXIN_BOOT');" +
			"while(true){}";
		const proc = Bun.spawn({
			cmd: ["bun", "-e", childScript],
			stdout: "pipe",
			stderr: "pipe",
			processGroupLeader: true,
			env: { ...process.env, OGC_GCFILE: pidFile },
		});

		const start = performance.now();
		let reason: "AUXIN_COLLAPSE" | "CLEAN_SENESCENCE" = "CLEAN_SENESCENCE";
		let ethyleneMs = 0;

		// Best-effort cgroup.v2 AZ (bounded: 1500ms. If sudo/cgroup is unavailable
		// we fall back to pgroup SIGKILL, which already severs descendants via the
		// process-group leader). NEVER block the event loop on a hung sudo.
		const cgroup = `/sys/fs/cgroup/orchid_${process.pid}/${id}`;
		const cgroupOk = (() => {
			if (!shTime(["sudo", "-n", "mkdir", "-p", cgroup], 1500).ok) return false;
			return shTime(["sudo", "-n", "sh", "-c", `chmod 777 ${cgroup}; echo ${proc.pid} > ${cgroup}/cgroup.procs`], 1500).ok;
		})();

		const t0 = performance.now();
		const watchdog = setInterval(() => {
			const idleMs = performance.now() - t0;
			ethyleneMs = idleMs;
			if (idleMs >= threshold) {
				reason = "AUXIN_COLLAPSE";
				clearInterval(watchdog);
				// pgroup-first: synchronous kill is fast; cgroup.kill is best-effort
				try { process.kill(-(proc.pid as number), "SIGKILL"); } catch { /* gone */ }
				if (cgroupOk) {
					void Bun.spawn(["sudo", "-n", "sh", "-c", `echo 1 > ${cgroup}/cgroup.kill`], { stdout: "ignore", stderr: "ignore" });
				}
			}
		}, 50);

		// grandchild pid: read the scratch file the child wrote
		let grandchildPid = 0;
		for (let tries = 0; tries < 20 && !fs.existsSync(pidFile); tries++) await Bun.sleep(10);
		if (fs.existsSync(pidFile)) grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim());
		// await exit with cap
		const exited = await awaitExit(proc, maxMs);
		clearInterval(watchdog);
		if (!exited) {
			try { process.kill(-(proc.pid as number), "SIGKILL"); } catch { /* gone */ }
			try { proc.kill("SIGKILL"); } catch { /* gone */ }
		}
		const wallMs = performance.now() - start;

		// grandchild severed?
		let grandchildState = "NO_GC";
		if (grandchildPid) {
			// A zombie (state Z) is already dead-but-unreaped, so "severed" means
			// GONE or Z — mere /proc existence would mislabel a dying zombie alive.
			await Bun.sleep(150);
			try {
				const stat = fs.readFileSync(`/proc/${grandchildPid}/stat`, "utf8");
				grandchildState = stat.match(/\)\s+(.)/)?.[1] ?? "?";
			} catch {
				grandchildState = "GONE";
			}
			try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
		}
		if (cgroupOk) shTime(["sudo", "-n", "rmdir", cgroup], 1000);
		const grandchildSevered = grandchildState === "GONE" || grandchildState === "Z";

		findings.push({
			id: "orchid.a1.severance-demo",
			dedupe_key: `orchid.a1.sever.${id}`,
			detector: "a1_abscission",
			flag: "a1_abscission",
			artifact: "synthetic",
			severity: reason === "AUXIN_COLLAPSE" ? "warn" : "info",
			title: `Abscission severed stalled branch via ${cgroupOk ? "cgroup.kill" : "pgroup SIGKILL"} (${reason})`,
			detail: {
				branchId: id,
				reason,
				wallMs: Math.round(wallMs),
				ethyleneAccumulationMs: Math.round(ethyleneMs),
				thresholdMs: threshold,
				withinBudget: wallMs <= maxMs,
				grandchildSevered,
				grandchildState,
				transport: cgroupOk ? "cgroup.kill" : "pgroup-sigkill",
				scarHash: shaShort(`${id}#${reason}#${Math.round(wallMs)}`),
			},
			ts: now(),
		});

		return { findings };
	},
};

function awaitExit(proc: { exited: Promise<number> }, maxMs: number): Promise<boolean> {
	return new Promise(resolve => {
		const t = setTimeout(() => resolve(false), maxMs);
		void proc.exited.then(() => {
			clearTimeout(t);
			resolve(true);
		}).catch(() => {
			clearTimeout(t);
			resolve(false);
		});
	});
}

/** bounded spawnSync — never lets a hung sudo serialize the event loop */
function shTime(args: string[], timeoutMs: number): { ok: boolean; out: string; err: string } {
	const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
	return {
		ok: r.exitCode === 0,
		out: new TextDecoder().decode(r.stdout),
		err: new TextDecoder().decode(r.stderr),
	};
}
