// Tests for diffLines, the line diff shown in write and edit approval prompts. Run with: npm test
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { diffLines, MAX_DIFF_LINES } from "../src/tools/helpers/utils.ts";

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

describe("diffLines", () => {
  test("identical text has no hunks", () => {
    assert.deepEqual(diffLines("a\nb\n", "a\nb\n"), []);
  });

  test("two far-apart changes get a hunk each, not one big block", () => {
    const before = numbered(100);
    const after = [...before];
    after[4] = "five";
    after[89] = "ninety";
    assert.deepEqual(diffLines(before.join("\n"), after.join("\n")), [
      "@@ line 5 @@",
      "-line 5",
      "+five",
      "@@ line 90 @@",
      "-line 90",
      "+ninety",
    ]);
  });

  test("insertions and deletions are numbered by the line in the old text", () => {
    // delete line 2, insert a line before line 5
    assert.deepEqual(diffLines("1\n2\n3\n4\n5", "1\n3\n4\nnew\n5"), ["@@ line 2 @@", "-2", "@@ line 5 @@", "+new"]);
  });

  test("firstLine offsets the numbers (edit diffs a slice from the middle of a file)", () => {
    assert.deepEqual(diffLines("a\nb\nc", "a\nB\nc", 40), ["@@ line 41 @@", "-b", "+B"]);
  });

  test("still diffs line by line right at the cap", () => {
    const before = numbered(MAX_DIFF_LINES);
    const after = [...before];
    after[0] = "first";
    after[MAX_DIFF_LINES - 1] = "last";
    const out = diffLines(before.join("\n"), after.join("\n"));
    assert.equal(out.filter((l) => l.startsWith("@@")).length, 2);
  });

  test("past the cap, falls back to one block instead of freezing", () => {
    const n = MAX_DIFF_LINES + 1000;
    const before = numbered(n);
    const after = [...before];
    after[0] = "first";
    after[n - 1] = "last";
    const started = performance.now();
    const out = diffLines(before.join("\n"), after.join("\n"));
    assert.ok(performance.now() - started < 500, "should not run the LCS table");
    assert.equal(out[0], "@@ line 1 @@");
    assert.equal(out.length, 1 + n + n); // header, every old line removed, every new line added
  });
});
