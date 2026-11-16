// retire.ts — `lapidary retire <old-pen> <target-pen> [--dry-run] [--delete-repo]`
// Drains a whole pen's products/docs/ssot into another pen and rewrites refs.
import * as fs from "node:fs";
import * as path from "node:path";
import { walkPens, readTextIfSafe, journalWrite } from "../core.ts";

export function run(args: string[]): void {
	const oldPen = args[0];
	const targetPen = args[1];
	const dryRun = args.includes("--dry-run");
	const deleteRepo = args.includes("--delete-repo");
	if (!oldPen || !targetPen) { console.error("lapidary retire: requires <old-pen> <target-pen>"); process.exit(2); }
	const oldPath = `/home/toxic/pens/${oldPen}`;
	const targetPath = `/home/toxic/pens/${targetPen}`;
	if (!fs.existsSync(oldPath)) { console.error(`lapidary: source pen not found: ${oldPath}`); process.exit(2); }
	if (!fs.existsSync(targetPath)) { console.error(`lapidary: target pen not found: ${targetPath}`); process.exit(2); }
	console.log(`[retire] ${oldPen} -> ${targetPen}...`);

	// 1. move products
	const oldProductsDir = path.join(oldPath, "products");
	const targetProductsDir = path.join(targetPath, "products");
	if (fs.existsSync(oldProductsDir)) {
		fs.mkdirSync(targetProductsDir, { recursive: true });
		for (const prod of fs.readdirSync(oldProductsDir)) {
			const srcP = path.join(oldProductsDir, prod);
			const dstP = path.join(targetProductsDir, prod);
			if (!fs.existsSync(dstP)) { console.log(`  moving product: ${prod}`); if (!dryRun) fs.renameSync(srcP, dstP); }
		}
	}
	// 2. move docs
	const oldDocsDir = path.join(oldPath, "docs");
	const targetDocsDir = path.join(targetPath, "docs");
	if (fs.existsSync(oldDocsDir)) {
		fs.mkdirSync(targetDocsDir, { recursive: true });
		for (const doc of fs.readdirSync(oldDocsDir)) {
			const srcD = path.join(oldDocsDir, doc);
			const dstD = path.join(targetDocsDir, doc);
			if (!fs.existsSync(dstD)) { console.log(`  moving doc: ${doc}`); if (!dryRun) fs.renameSync(srcD, dstD); }
		}
	}
	// 3. move metadata & ssot
	for (const item of ["ssot", "products.registry.json", "CHANGELOG.md", "CHANGELOG.agents.md"]) {
		const srcI = path.join(oldPath, item);
		const dstI = path.join(targetPath, item);
		if (fs.existsSync(srcI) && !fs.existsSync(dstI)) { console.log(`  moving metadata: ${item}`); if (!dryRun) fs.renameSync(srcI, dstI); }
	}

	// 4. rewrite refs
	const generatedRules = [
		{ kind: "word" as const, from: oldPen, to: targetPen },
		{ kind: "word" as const, from: oldPen.charAt(0).toUpperCase() + oldPen.slice(1), to: targetPen.charAt(0).toUpperCase() + targetPen.slice(1) },
		{ kind: "word" as const, from: oldPen.toUpperCase(), to: targetPen.toUpperCase() },
		{ kind: "substr" as const, from: `pens/${oldPen}`, to: `pens/${targetPen}` },
		{ kind: "substr" as const, from: `pens/${oldPen}/`, to: `pens/${targetPen}/` },
		{ kind: "substr" as const, from: `/pens/${oldPen}`, to: `/pens/${targetPen}` },
		{ kind: "substr" as const, from: `.${oldPen}`, to: `.${targetPen}` },
		{ kind: "substr" as const, from: `"${oldPen}"`, to: `"${targetPen}"` },
	];
	console.log(`[retire] Applying reference transforms across /home/toxic/pens...`);
	if (!dryRun) {
		const undoPath = path.join("/home/toxic/pens", ".lapidary-undo.jsonl");
		const mapOut: Array<{ from: string; to: string; file: string }> = [];
		let totalFiles = 0;
		for (const rel of walkPens("/home/toxic/pens")) {
			if (rel.startsWith(`${oldPen}/`)) continue;
			const full = path.join("/home/toxic/pens", rel);
			const content = readTextIfSafe(full);
			if (content === null) continue;
			let edited = content;
			for (const r of generatedRules) {
				if (r.kind === "word") edited = edited.replace(new RegExp(`\\b${r.from}\\b`, "g"), r.to);
				else edited = edited.replaceAll(r.from, r.to);
			}
			if (edited !== content) {
				totalFiles++;
				mapOut.push({ from: oldPen, to: targetPen, file: rel });
				console.log(`== ${rel} ==`);
				journalWrite(undoPath, rel, content, edited);
				fs.writeFileSync(full, edited);
			}
		}
		fs.writeFileSync(path.join("/home/toxic/pens", "rename.map"), JSON.stringify(mapOut, null, 2));
		console.log(`  updated ${totalFiles} files`);
	}
	if (deleteRepo && !dryRun) { console.log(`[retire] Removing retired folder ${oldPath}...`); fs.rmSync(oldPath, { recursive: true, force: true }); }
	console.log(`[retire] Successfully retired ${oldPen} -> ${targetPen}`);
	process.exit(0);
}