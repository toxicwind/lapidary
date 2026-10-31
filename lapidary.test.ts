import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyCasePreserving,
	applyRules,
	combyToRegex,
	listTrackedFiles,
	loadRules,
	matchGlob,
	parseRuleFile,
	pathAllowed,
} from "./bin/lapidary";

const TMP: string[] = [];
function tmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lapidary-test-"));
	TMP.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of TMP) fs.rmSync(dir, { recursive: true, force: true });
});

describe("legacy line grammar (forward-only alias)", () => {
	test("parses word/substr/exclude/comments", () => {
		const dir = tmp();
		const file = path.join(dir, "x.lapidary");
		fs.writeFileSync(file, `# comment\nword: pinax => mimetite\nsubstr: PINAX_ => MIMETITE_\nexclude: PINAX_API_KEY\n`);
		const parsed = parseRuleFile(file);
		expect(parsed.rules).toHaveLength(2);
		expect(parsed.rules[0]).toMatchObject({ kind: "word", from: "pinax", to: "mimetite" });
		expect(parsed.excludes.has("PINAX_API_KEY")).toBe(true);
	});
});

describe("YAML schema — pattern-borrow grammar", () => {
	test("full maximal schema parses: regex/case/comby/scoping/exclude/extends", () => {
		const dir = tmp();
		const file = path.join(dir, "rebrand.lapidary");
		fs.writeFileSync(file, `id: pinax-to-mimetite
extends: [base.lapidary]
includePaths: ["packages/**"]
ignorePaths: ["**/dist/**"]
exclude: [PINAX_API_KEY]
rules:
  - word: pinax => mimetite
  - regex: 'pinax(\\w*)' => 'mimetite$1'
  - case: pinax => mimetite
  - comby: ':[[x]].pinax()' => ':[[x]].mimetite()'
`);
		const parsed = parseRuleFile(file);
		expect(parsed.globalInclude).toEqual(["packages/**"]);
		expect(parsed.globalIgnore).toEqual(["**/dist/**"]);
		expect(parsed.extends).toEqual(["base.lapidary"]);
		const kinds = parsed.rules.map(r => r.kind);
		expect(kinds).toEqual(["word", "regex", "case", "comby"]);
		expect(parsed.excludes.has("PINAX_API_KEY")).toBe(true);
	});

	test("ast-grep style match+fix pair compiles to comby", () => {
		const dir = tmp();
		const file = path.join(dir, "a.lapidary");
		fs.writeFileSync(file, `rules:\n  - match: ':[[x]].pinax()'\n    fix: ':[[x]].mimetite()'\n`);
		const parsed = parseRuleFile(file);
		expect(parsed.rules[0]!.kind).toBe("comby");
	});
});

describe("case-preserving transforms", () => {
	test("one rule rewrites every case style", () => {
		const { content, count } = applyCasePreserving(
			"pinax PINAX Pinax pinax_x pinaxApi PinaxApi",
			"pinax",
			"mimetite",
		);
		expect(content).toContain("MIMETITE");
		expect(content).toContain("Mimetite");
		expect(content).toContain("mimetite_x");
		expect(content).toContain("mimetiteApi");
		expect(content).toContain("MimetiteApi");
		expect(count).toBeGreaterThanOrEqual(4);
	});
});

describe("comby holes", () => {
	test(":[[hole]] capture and reuse", () => {
		const compiled = combyToRegex(":[[x]].pinax()", ":[[x]].mimetite()");
		expect(compiled).not.toBeNull();
		const out = "a.pinax(); b.pinax()".replace(compiled!.pattern, compiled!.replace);
		expect(out).toBe("a.mimetite(); b.mimetite()");
	});
});

describe("renovate-borrow path scoping", () => {
	test("ignorePaths veto, includePaths gate", () => {
		const rule = { id: "r", kind: "word" as const, from: "a", to: "b", file: "f", includePaths: ["packages/**"], ignorePaths: ["**/dist/**"] };
		expect(pathAllowed("packages/cli/src/x.ts", rule, [], [])).toBe(true);
		expect(pathAllowed("packages/cli/dist/x.js", rule, [], [])).toBe(false);
		expect(pathAllowed("docs/x.md", rule, [], [])).toBe(false);
		// globalIgnore wins over rule includes
		expect(pathAllowed("packages/cli/src/x.ts", rule, [], ["**/cli/**"])).toBe(false);
	});
	test("no scoping = allowed everywhere", () => {
		const rule = { id: "r", kind: "word" as const, from: "a", to: "b", file: "f" };
		expect(pathAllowed("any/where/x.ts", rule, [], [])).toBe(true);
	});
});

describe("glob matcher", () => {
	test("** crosses segments, * stays in segment", () => {
		expect(matchGlob("packages/**", "packages/a/b/c.ts")).toBe(true);
		expect(matchGlob("packages/*", "packages/a/b")).toBe(false);
		expect(matchGlob("packages/*.ts", "packages/x.ts")).toBe(true);
		expect(matchGlob("packages/*.ts", "packages/y.js")).toBe(false);
	});
});

describe("applyRules — edits, map, cross-file armor", () => {
	test("cross-file exclude armor leaves armored tokens untouched", () => {
		// Real armor case from the 2026-10-26 incident: word PINAX => MIMETITE
		// must NOT hit the live identifier PINAX_API_KEY even though \bPINAX\b
		// matches its prefix — the exclude armors the exact matched word.
		const rules = [{ id: "r1", kind: "word" as const, from: "PINAX", to: "MIMETITE", file: "f" }];
		const excludes = new Set(["PINAX_API_KEY"]);
		const { content } = applyRules("PINAX_API_KEY and PINAX", rules, excludes, "x.ts");
		expect(content).toBe("PINAX_API_KEY and MIMETITE");
	});
});
