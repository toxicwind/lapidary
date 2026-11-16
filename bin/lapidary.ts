#!/usr/bin/env bun
/**
 * lapidary — the geode rename + detect engine (thin dispatcher).
 *
 * Subcommand CLI (modularized 2026-11-12 from the monolithic flag-sprawl):
 *   lapidary rename  <repo> --rules <files> [--dry-run] [--commit] [--undo]
 *   lapidary detect  --rules <manifest> [--flags] [--bench]
 *   lapidary move    <product> <from-pen> <to-pen> [--dry-run]
 *   lapidary retire  <old-pen> <target-pen> [--dry-run] [--delete-repo]
 *   lapidary merge   <from-path> <into-path> [--dry-run]
 *   lapidary verify  <dir> <term>
 *
 * Each command lives in src/commands/*.ts; shared engine in src/core.ts.
 */
import { run as rename } from "../src/commands/rename.ts";
import { run as detect } from "../src/commands/detect.ts";
import { run as move } from "../src/commands/move.ts";
import { run as retire } from "../src/commands/retire.ts";
import { run as merge } from "../src/commands/merge.ts";
import { run as verify } from "../src/commands/verify.ts";

// Public engine exports (used by lapidary.test.ts and embedders).
export {
  applyCasePreserving,
  applyRules,
  combyToRegex,
  listTrackedFiles,
  loadRules,
  matchGlob,
  parseRuleFile,
  pathAllowed,
} from "../src/core.ts";

const HELP = `lapidary — geode rename + detect engine

usage:
  lapidary rename  <repo> --rules <files> [--dry-run] [--commit "msg"] [--undo]
  lapidary detect  --rules <manifest> [--flags ORCHID_FLAGS] [--bench]
  lapidary move    <product> <from-pen> <to-pen> [--dry-run]
  lapidary retire  <old-pen> <target-pen> [--dry-run] [--delete-repo]
  lapidary merge   <from-path> <into-path> [--dry-run]
  lapidary verify  <dir> <term>
  lapidary help

rename: apply .lapidary rule files (word/substr/regex/case/comby) over a repo.
detect: run orchid detectors (a1..a9) over the corpus, feature-flag-gated.
move:   move a product between pens, update all path refs, verify no stale.
retire: drain a whole pen's products/docs/ssot into another pen.
merge:  absorb one folder's ENTIRE content into another, symlink, rewrite refs.
verify: pens-wide stale-ref scan (content + filename + argos corpus).
`;

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const cmd = argv[0];
	if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") { console.log(HELP); process.exit(0); }
	const rest = argv.slice(1);
	switch (cmd) {
		case "rename": rename(rest); break;
		case "detect": detect(rest); break;
		case "move": move(rest); break;
		case "retire": retire(rest); break;
		case "merge": merge(rest); break;
		case "verify": await verify(rest); break;
		default:
			console.error(`lapidary: unknown command "${cmd}"`);
			console.log(HELP);
			process.exit(2);
	}
}

if (import.meta.main) await main();