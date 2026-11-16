// move.ts — `lapidary move <product> <from-pen> <to-pen> [--dry-run]`
// Moves a product directory between pens and updates ALL path references.
import * as fs from "node:fs";
import * as path from "node:path";
import { walkPens, readTextIfSafe, journalWrite, journalRun } from "../core.ts";

export function run(args: string[]): void {
	const product = args[0];
	const fromPen = args[1];
	const toPen = args[2];
	const dryRun = args.includes("--dry-run");
	if (!product || !fromPen || !toPen) {
		console.error("lapidary move: requires <product> <from-pen> <to-pen>");
		process.exit(2);
	}
	const fromPath = `/home/toxic/pens/${fromPen}/products/${product}`;
	const toPath = `/home/toxic/pens/${toPen}/products/${product}`;
	if (!fs.existsSync(fromPath)) { console.error(`lapidary: source not found: ${fromPath}`); process.exit(2); }
	if (fs.existsSync(toPath)) { console.error(`lapidary: destination exists: ${toPath}`); process.exit(2); }
	console.log(`Moving ${product}: ${fromPath} -> ${toPath}`);
	if (!dryRun) { fs.mkdirSync(path.dirname(toPath), { recursive: true }); fs.renameSync(fromPath, toPath); }

	const generatedRules: Array<{ kind: "word" | "substr"; from: string; to: string }> = [
		{ kind: "word", from: product, to: product },
		{ kind: "word", from: product.charAt(0).toUpperCase() + product.slice(1), to: product.charAt(0).toUpperCase() + product.slice(1) },
		{ kind: "word", from: product.toUpperCase(), to: product.toUpperCase() },
		{ kind: "substr", from: `pens/${fromPen}/products/${product}`, to: `pens/${toPen}/products/${product}` },
		{ kind: "substr", from: `pens/${fromPen}/products/${product}/`, to: `pens/${toPen}/products/${product}/` },
		{ kind: "substr", from: `/${fromPen}/products/${product}`, to: `/${toPen}/products/${product}` },
		{ kind: "substr", from: `"${fromPen}/products/${product}"`, to: `"${toPen}/products/${product}"` },
	];
	const undoPath = path.join("/home/toxic/pens", ".lapidary-undo.jsonl");
	const mapOut: Array<{ from: string; to: string; file: string }> = [];
	let totalFiles = 0;
	for (const rel of walkPens("/home/toxic/pens")) {
		if (rel.startsWith(`${toPen}/products/${product}/`)) continue;
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
			mapOut.push({ from: fromPath, to: toPath, file: rel });
			console.log(`== ${rel} ==`);
			if (!dryRun) { journalWrite(undoPath, rel, content, edited); fs.writeFileSync(full, edited); }
		}
	}
	console.log(`edits=${totalFiles} files=${totalFiles}${dryRun ? " (dry-run)" : ""}`);
	journalRun({ mode: dryRun ? "move-pen-dry" : "move-pen", repo: "/home/toxic/pens", edits: totalFiles, files: totalFiles });
	if (!dryRun) fs.writeFileSync(path.join("/home/toxic/pens", "rename.map"), JSON.stringify(mapOut, null, 2));

	console.log("\nVerifying no stale refs...");
	const staleTerms = [`pens/${fromPen}/products/${product}`, `${fromPen}/products/${product}`];
	let stale = 0;
	for (const term of staleTerms) {
		const grep = Bun.spawnSync(["rg", "-l", "-i", "-g", "!node_modules/**", "-g", "!**/.git/**", "-g", "!**/.cache/**", "-g", "!**/target/**", "-g", "!**/dist/**", "-g", "!**/blobs/**", term, "/home/toxic/pens"], { stdout: "pipe" });
		const hits = Buffer.from(grep.stdout ?? Buffer.alloc(0)).toString("utf8").split("\n").filter(Boolean);
		for (const hit of hits) { console.log(`stale-ref: ${hit}`); stale++; }
	}
	process.exit(stale > 0 ? 1 : 0);
}