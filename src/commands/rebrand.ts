// rebrand.ts — `lapidary rebrand <root> <from> <to> [--dry-run] [--undo]`
// Mass case-preserving term rename across EVERY file + filename under a root
// (e.g. estate -> pens across /home/toxic). Journals every edit for undo.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readTextIfSafe, journalWrite } from "../core.ts";

const PRUNE = new Set([
  // project artifacts
  "node_modules", ".git", ".jj", "target", "dist", "build", "out",
  "runs", "blobs", "sessions", "installs", "cache", ".cache",
  "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache",
  ".turbo", ".corral", ".smithers", ".super-ralph", ".patch-backups",
  // toolchains / registries / SDKs / language caches
  ".cargo", ".rustup", ".bun", ".npm", ".yarn", ".pnpm-store", ".nvm",
  ".pyenv", ".conda", ".julia", ".gem", ".wine", ".sdkman", ".m2",
  ".ivy2", ".gradle", ".android-sdk-writable", ".android", ".sdk",
  "android-sdk", ".nuget", ".dotnet", ".templateengine",
  ".vscode", ".vscode-insiders", ".vscode-server-insiders", ".vscode-shared",
  ".claude", ".codex", ".copilot", ".config", ".local", ".ssh", ".gnupg",
  ".mise", ".kilo", ".ffs", ".gh-search-cache", ".openfang",
  ".cpanm", ".xerj", ".hardened-reorg", ".rhodochrosite-data", ".argos",
  ".gemini", ".gemini-sdk-venv", ".claude-server-commander",
  ".frag-snap-TvXEfk", ".squawk-bus", ".run-fast", ".scratch", ".rig",
  ".venvs", ".venv-guidellm", ".tau",
  // pens backups/archives (frozen snapshots)
  "archive", "backups", ".consolidate-backup-20261106", ".archive-pinax-20261026",
]);

interface RebrandPair { from: string; to: string; }

function pairs(term: string, replacement: string): RebrandPair[] {
  return [
    { from: term, to: replacement },
    { from: term[0].toUpperCase() + term.slice(1), to: replacement[0].toUpperCase() + replacement.slice(1) },
    { from: term.toUpperCase(), to: replacement.toUpperCase() },
    { from: term + "_", to: replacement + "_" },
    { from: term + "-", to: replacement + "-" },
    { from: "." + term, to: "." + replacement },
    { from: "/" + term, to: "/" + replacement },
  ];
}

function applyPairs(content: string, ps: RebrandPair[]): { content: string; count: number } {
  let count = 0;
  let out = content;
  for (const p of ps) {
    const re = new RegExp(p.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    out = out.replace(re, () => { count++; return p.to; });
  }
  return { content: out, count };
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    const abs = path.join(root, rel);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (PRUNE.has(e.name)) continue;
      const relChild = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(relChild);
      else if (e.isFile()) out.push(relChild);
    }
  }
  return out.sort();
}

export function run(args: string[]): void {
  const root = args[0];
  const from = args[1];
  const to = args[2];
  const dryRun = args.includes("--dry-run");
  const undo = args.includes("--undo");
  if (!root || !from || !to) {
    console.error("lapidary rebrand: <root> <from> <to> required");
    process.exit(2);
  }
  if (!fs.existsSync(root)) {
    console.error(`lapidary rebrand: root not found: ${root}`);
    process.exit(2);
  }

  const undoPath = path.join(root, ".lapidary-rebrand-undo.jsonl");
  const ps = pairs(from, to);
  let totalFiles = 0;
  let totalEdits = 0;

  if (undo) {
    if (!fs.existsSync(undoPath)) { console.error("no undo journal found"); process.exit(1); }
    const entries = fs.readFileSync(undoPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
    for (const entry of entries.reverse() as Array<{ file: string; before: string; hash: string }>) {
      const full = path.join(root, entry.file);
      try {
        const current = fs.readFileSync(full, "utf8");
        if (createHash("sha256").update(current).digest("hex") === entry.hash) {
          fs.writeFileSync(full, entry.before);
          console.log(`undone: ${entry.file}`);
        } else console.log(`skip (changed since): ${entry.file}`);
      } catch { console.log(`skip (missing): ${entry.file}`); }
    }
    return;
  }

  // 1. content edits
  for (const rel of walk(root)) {
    const full = path.join(root, rel);
    const content = readTextIfSafe(full);
    if (content === null) continue;
    const applied = applyPairs(content, ps);
    if (applied.count === 0) continue;
    totalFiles++;
    totalEdits += applied.count;
    console.log(`== ${rel} (${applied.count}) ==`);
    if (!dryRun) {
      journalWrite(undoPath, rel, content, applied.content);
      fs.writeFileSync(full, applied.content);
    }
  }

  // 2. filename/dir renames (deepest first)
  const dirs = new Set<string>();
  for (const rel of walk(root)) {
    let d = path.dirname(rel);
    while (d && d !== ".") { dirs.add(d); d = path.dirname(d); }
  }
  const renameTargets = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const rel of renameTargets) {
    const base = path.basename(rel);
    const applied = applyPairs(base, ps);
    if (applied.count === 0 || applied.content === base) continue;
    const parent = path.dirname(rel);
    const oldFull = path.join(root, rel);
    const newFull = path.join(root, parent === "." ? applied.content : `${parent}/${applied.content}`);
    if (fs.existsSync(newFull)) continue;
    console.log(`RENAME ${rel} -> ${parent === "." ? applied.content : `${parent}/${applied.content}`}`);
    if (!dryRun) fs.renameSync(oldFull, newFull);
  }

  console.log(`edits=${totalEdits} files=${totalFiles}${dryRun ? " (dry-run)" : ""}`);
}
