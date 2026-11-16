// rename.ts — `lapidary rename <repo> --rules <files> [--dry-run] [--commit] [--undo]`
// Applies .lapidary rule files over a repo's tracked+untracked files, with a
// reversible undo journal. The core transform engine (see core.ts).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadRules, applyRules, listAllFiles, isSymlink, journalRun, journalWrite } from "../core.ts";

export function run(args: string[]): void {
	const get = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
	const rulesArg = get("--rules") ?? get("--pairs");
	const repo = get("--repo");
	const force = args.includes("--force");
	const dryRun = args.includes("--dry-run") && !force;
	const commitMsg = get("--commit");
	const undo = args.includes("--undo");
	if (!rulesArg || !repo) {
		console.error("lapidary rename: --repo and --rules are required");
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
			if (createHash("sha256").update(current).digest("hex") === entry.hash) { fs.writeFileSync(full, entry.before); console.log(`undone: ${entry.file}`); }
			else console.log(`skip (changed since): ${entry.file}`);
		}
		return;
	}

	for (const rel of listAllFiles(repo)) {
		if (isSymlink(repo, rel)) continue;
		const full = path.join(repo, rel);
		let content: string;
		try {
			if (!fs.statSync(full).isFile()) continue;
			const sniff = Buffer.from(fs.readFileSync(full).subarray(0, 8192));
			if (sniff.includes(0)) continue;
			let fffd = 0;
			for (let i = 0; i + 2 < sniff.length; i += 1) { if (sniff[i] === 0xef && sniff[i + 1] === 0xbf && sniff[i + 2] === 0xbd) { fffd += 1; i += 2; } }
			if (fffd > 4) continue;
			content = fs.readFileSync(full, "utf8");
		} catch { continue; }
		const applied = applyRules(content, rules, excludes, rel, globalInclude, globalIgnore);
		if (applied.edits === 0) continue;
		totalFiles++;
		totalEdits += applied.edits;
		mapOut.push(...applied.map);
		console.log(`== ${rel} ==`);
		if (!dryRun) {
			fs.appendFileSync(undoPath, JSON.stringify({ file: rel, before: content, hash: createHash("sha256").update(applied.content).digest("hex"), at: new Date().toISOString() }) + "\n");
			fs.writeFileSync(full, applied.content);
		}
	}
	console.log(`edits=${totalEdits} files=${totalFiles}${dryRun ? " (dry-run)" : ""}`);
	journalRun({ mode: dryRun ? "rewrite-dry" : "rewrite", repo, edits: totalEdits, files: totalFiles });
	if (!dryRun) {
		fs.writeFileSync(path.join(repo, "rename.map"), JSON.stringify(mapOut, null, 2));
		if (commitMsg && totalFiles > 0) {
			execFileSync("git", ["add", "-A"], { cwd: repo });
			execFileSync("git", ["commit", "-m", commitMsg], { cwd: repo });
			console.log(`committed: ${commitMsg}`);
		}
	}
}