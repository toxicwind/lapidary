// verify.ts — `lapidary verify <dir> <term>`
// Pens-wide stale-ref verification via content grep + filename scan + argos.
import * as fs from "node:fs";
import { journalRun } from "../core.ts";

export async function run(args: string[]): Promise<void> {
	const dir = args[0];
	const term = args[1];
	if (!dir || !term) { console.error("lapidary verify: requires <dir> <term>"); process.exit(2); }
	let stale = 0;
	const grep = Bun.spawnSync(["rg", "-l", "-i", "-g", "!node_modules/**", "-g", "!**/.git/**", "-g", "!**/.cache/**", "-g", "!**/target/**", "-g", "!**/dist/**", term, dir], { stdout: "pipe" });
	const contentHits = Buffer.from(grep.stdout ?? Buffer.alloc(0)).toString("utf8").split("\n").filter(Boolean);
	for (const hit of contentHits) { console.log(`stale-ref(content): ${hit}`); stale++; }

	const find = Bun.spawnSync(["rg", "--files", "-g", "!node_modules/**", "-g", "!**/.git/**", "-g", `*${term}*`, dir], { stdout: "pipe" });
	const nameHits = Buffer.from(find.stdout ?? Buffer.alloc(0)).toString("utf8").split("\n").filter(Boolean);
	for (const hit of nameHits) { console.log(`stale-ref(name): ${hit}`); stale++; }

	try {
		const res = await fetch(process.env.ARGOS_URL ?? "http://127.0.0.1:25254/pens-corpus/_search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: { bool: { should: [{ match_phrase: { text: term } }], minimum_should_match: 1 } }, _source: ["ax_path"], size: 20 }),
		});
		if (res.ok) {
			const j = await res.json();
			for (const h of j?.hits?.hits ?? []) {
				const ax = h._source?.ax_path ?? "";
				const rel = ax.replace(/^kind:[a-z]+\//, "");
				let full = `/home/toxic/pens/${rel}`;
				if (!fs.existsSync(full)) {
					const segs = rel.split("/");
					if (segs.length > 1) { const alt = `/home/toxic/pens/${segs[0]}/products/${segs.slice(1).join("/")}`; if (fs.existsSync(alt)) full = alt; }
				}
				if (full && !full.includes(`/${term}`)) { console.log(`stale-ref(argos): ${full}`); stale++; }
			}
		}
	} catch (e) { console.error(`lapidary: argos unavailable: ${(e as Error).message}`); }
	console.log(`\nverify: ${stale} stale refs for "${term}" in ${dir}`);
	journalRun({ mode: "verify", repo: dir, stale });
	process.exit(stale > 0 ? 1 : 0);
}