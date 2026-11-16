// merge.ts — `lapidary merge <from-path> <into-path> [--dry-run]`
// Absorbs one folder's ENTIRE content into another (bornite -> mimetite):
// full move (incl. .git/node_modules), continuity symlink, ref rewrite.
import * as fs from "node:fs";
import * as path from "node:path";
import { walkPens, readTextIfSafe, journalWrite, journalRun } from "../core.ts";

export function run(args: string[]): void {
	const fromPath = args[0];
	const intoPath = args[1];
	const dryRun = args.includes("--dry-run");
	if (!fromPath || !intoPath) { console.error("lapidary merge: requires <from-path> <into-path>"); process.exit(2); }
	if (!fs.existsSync(fromPath)) { console.error(`lapidary: source not found: ${fromPath}`); process.exit(2); }
	if (!fs.existsSync(intoPath)) { console.error(`lapidary: target not found: ${intoPath}`); process.exit(2); }
	const fromProduct = path.basename(fromPath);
	const intoProduct = path.basename(intoPath);
	console.log(`[merge] ${fromPath} -> ${intoPath}`);

	// 1. FULL move: every entry in the source goes into the target; a
	//    same-named existing target entry gets the source subtree merged under it.
	let moved = 0;
	for (const entry of fs.readdirSync(fromPath)) {
		const src = path.join(fromPath, entry);
		const dst = path.join(intoPath, entry);
		if (fs.existsSync(dst)) {
			console.log(`  merge-into-existing: ${entry}`);
			if (!dryRun) {
				if (fs.statSync(src).isDirectory() && fs.statSync(dst).isDirectory()) {
					for (const sub of fs.readdirSync(src)) { fs.renameSync(path.join(src, sub), path.join(dst, sub)); }
					fs.rmSync(src, { recursive: true, force: true });
				} else { fs.rmSync(dst, { recursive: true, force: true }); fs.renameSync(src, dst); }
			}
		} else {
			console.log(`  moving: ${entry}`);
			if (!dryRun) fs.renameSync(src, dst);
		}
		moved++;
	}

	// 2. continuity symlink: source dir -> target dir.
	if (!dryRun) { fs.rmSync(fromPath, { recursive: true, force: true }); fs.symlinkSync(intoProduct, fromPath); console.log(`  symlink: ${fromPath} -> ${intoProduct}`); }

	// 3. rewrite path refs tree-wide.
	const rules = [
		`products/${fromProduct}/`, `products/${intoProduct}/`,
		`products/${fromProduct}`, `products/${intoProduct}`,
		`/products/${fromProduct}/`, `/products/${intoProduct}/`,
		`/products/${fromProduct}`, `/products/${intoProduct}`,
	];
	const undoPath = path.join("/home/toxic/pens", ".lapidary-undo.jsonl");
	const mapOut: Array<{ from: string; to: string; file: string }> = [];
	let totalFiles = 0;
	for (const rel of walkPens("/home/toxic/pens")) {
		if (rel.startsWith(`products/${intoProduct}/`)) continue;
		const full = path.join("/home/toxic/pens", rel);
		const content = readTextIfSafe(full);
		if (content === null) continue;
		let edited = content;
		for (let i = 0; i < rules.length; i += 2) edited = edited.split(rules[i]).join(rules[i + 1]);
		if (edited !== content) {
			totalFiles++;
			mapOut.push({ from: fromProduct, to: intoProduct, file: rel });
			console.log(`== ${rel} ==`);
			if (!dryRun) { journalWrite(undoPath, rel, content, edited); fs.writeFileSync(full, edited); }
		}
	}
	console.log(`moved=${moved} refs=${totalFiles} files${dryRun ? " (dry-run)" : ""}`);
	if (!dryRun) fs.writeFileSync(path.join("/home/toxic/pens", "rename.map"), JSON.stringify(mapOut, null, 2));
	journalRun({ mode: dryRun ? "merge-dry" : "merge", repo: "/home/toxic/pens", edits: totalFiles, files: totalFiles });

	if (!dryRun) {
		console.log("\nVerifying no stale refs...");
		const grep = Bun.spawnSync(["rg", "-l", "-i", "-g", "!node_modules/**", "-g", "!**/.git/**", "-g", "!**/.cache/**", "-g", "!**/target/**", "-g", "!**/dist/**", "-g", "!**/blobs/**", `products/${fromProduct}`, "/home/toxic/pens"], { stdout: "pipe" });
		const hits = Buffer.from(grep.stdout ?? Buffer.alloc(0)).toString("utf8").split("\n").filter(Boolean);
		for (const hit of hits) console.log(`stale-ref: ${hit}`);
		console.log(`merge: ${hits.length} stale refs for products/${fromProduct}`);
		process.exit(hits.length > 0 ? 1 : 0);
	}
	process.exit(0);
}