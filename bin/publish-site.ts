#!/usr/bin/env bun
/**
 * publish-site — ship lapidary's generated benchmark compare to GitHub Pages.
 * Mirrors agentic-moment's compare-lab drop-in: builds an orphan `gh-pages`
 * branch from the current `site/` output and pushes it so the compare renders
 * at https://toxicwind.github.io/lapidary/. Pages is "drop-in or not, no
 * approval ritual."
 *
 * Requires a valid GitHub token (reads GH_TOKEN / GITHUB_TOKEN env; never
 * written to config). Usage: bun bin/publish-site.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SITE = path.join(ROOT, "site", "index.html");
const REPO = "https://github.com/toxicwind/lapidary.git";

function sh(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
	return execFileSync("git", args, {
		cwd: opts.cwd ?? ROOT,
		env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" },
		encoding: "utf8",
	});
}

if (!fs.existsSync(SITE)) {
	console.error("publish-site: no site/index.html — run `bun bin/lapidary.ts --detect --rules sources/orchid.lapidary --bench` first");
	process.exit(2);
}

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const pushUrl = token ? `https://x-access-token:${token}@github.com/toxicwind/lapidary.git` : REPO;
const tmp = fs.mkdtempSync(path.join("/tmp", "lapidary-site-"));

try {
	// orphan gh-pages branch in a scratch dir containing ONLY the site
	sh(["init", "-q", "-b", "gh-pages"], { cwd: tmp });
	sh(["config", "user.email", "tau@toxicwind.dev"], { cwd: tmp });
	sh(["config", "user.name", "tau"], { cwd: tmp });
	fs.copyFileSync(SITE, path.join(tmp, "index.html"));
	sh(["add", "index.html"], { cwd: tmp });
	sh(["commit", "-q", "-m", `orchid compare ${new Date().toISOString()}`], { cwd: tmp });
	sh(["remote", "add", "origin", pushUrl], { cwd: tmp });
	// --force: gh-pages is a published artifact, force-push is the published branch's contract
	sh(["push", "-f", "origin", "gh-pages"], { cwd: tmp });
	console.log("pushed site to gh-pages: https://toxicwind.github.io/lapidary/");
} finally {
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
