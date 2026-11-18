import { describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { computeEditResult, type Edit } from "../src/core/tools/edit-diff.ts";

/** Small deterministic generator (mulberry32), using the high bits. */
function createRandom(seed: number): (max: number) => number {
	let state = seed;
	return (max) => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
	};
}

// Repeated lines, trailing whitespace, smart quotes, Unicode dashes and spaces exercise the duplicate and fuzzy paths.
const LINES = [
	"a",
	"b",
	"",
	"}",
	"let x = 1;  ",
	"say \u201chi\u201d",
	"it\u2019s",
	"a \u2013 b",
	"x\u00a0y",
	"\tindent",
];
const ENDINGS = ["\n", "\r\n", "\r"];

function randomFile(random: (max: number) => number): string {
	const mixed = random(3) === 0;
	const fileEnding = ENDINGS[random(3)];
	const lines = Array.from({ length: random(30) }, () => LINES[random(LINES.length)]);
	const body = lines.map((line) => line + (mixed ? ENDINGS[random(3)] : fileEnding)).join("");
	return (random(4) === 0 ? "\uFEFF" : "") + (random(3) === 0 ? body.slice(0, -1) : body);
}

/** Make an exact match need pi's fuzzy matching: ASCII quotes and dashes, trailing whitespace dropped. */
function fuzzyVariant(text: string): string {
	return text
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.replace(/\u2013/g, "-")
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+$/gm, "");
}

function randomEdit(random: (max: number) => number, file: string): Edit {
	const text = file.replace(/^\uFEFF/, "");
	const start = random(text.length + 1);
	const slice = text.slice(start, start + random(40));
	const choice = random(10);
	const oldText = choice === 0 ? "" : choice === 1 ? "absent text" : choice < 4 ? fuzzyVariant(slice) : slice;
	const newText = random(5) === 0 ? oldText : ["", "NEW", "new line\nsecond", "\u201cq\u201d\r\n"][random(4)];
	return { oldText, newText };
}

const REFUSALS: [string, RegExp][] = [
	["empty", /oldText must not be empty/],
	["not found", /^Could not find/],
	["duplicate", /^Found \d+ occurrences/],
	["overlap", /overlap in/],
	["no change", /^No changes made/],
];

type Outcome = { written: string } | { error: string };

async function executeOutcome(file: string, edits: Edit[]): Promise<Outcome> {
	let written: string | undefined;
	const tool = createEditTool(process.cwd(), {
		operations: {
			access: async () => {},
			readFile: async () => Buffer.from(file, "utf-8"),
			writeFile: async (_path, content) => {
				written = content;
			},
		},
	});
	try {
		await tool.execute("edit-result", { path: "f.txt", edits });
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	if (written === undefined) throw new Error("edit returned without writing");
	return { written };
}

function computeOutcome(file: string, edits: Edit[]): Outcome {
	try {
		return { written: computeEditResult(file, edits, "f.txt").finalContent };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

describe("computeEditResult", () => {
	it("returns what the edit tool writes, and throws the edit tool's refusals", async () => {
		const random = createRandom(7);
		const kinds = new Set<string>();
		for (let run = 0; run < 3000; run++) {
			const file = randomFile(random);
			const edits = Array.from({ length: 1 + random(3) }, () => randomEdit(random, file));
			const outcome = computeOutcome(file, edits);
			expect(await executeOutcome(file, edits), `run ${run}`).toEqual(outcome);
			kinds.add(
				"written" in outcome
					? "written"
					: (REFUSALS.find(([, pattern]) => pattern.test(outcome.error))?.[0] ?? outcome.error),
			);
		}
		expect([...kinds].sort()).toEqual(["written", ...REFUSALS.map(([kind]) => kind)].sort());
	});

	it("keeps the BOM and untouched line endings, and returns the LF texts the edit tool diffs", () => {
		const result = computeEditResult(
			"\uFEFFsay \u201chi\u201d\r\nkeep\r\n",
			[{ oldText: 'say "hi"', newText: "a\nb" }],
			"f.txt",
		);
		expect(result.finalContent).toBe("\uFEFFa\r\nb\r\nkeep\r\n");
		expect(result.baseContent).toBe("say \u201chi\u201d\nkeep\n");
		expect(result.newContent).toBe("a\nb\nkeep\n");
	});
});
