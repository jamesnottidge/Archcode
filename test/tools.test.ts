// Tests for the file tools. Run them with: npm test
// Each test gets its own temporary folder, and calls tools exactly the way the agent loop
// does: through the registry, with JSON arguments, so validation and approval run too.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { PermissionGate } from "../src/agent/permissions.ts";
import { ALL_TOOLS, ToolRegistry } from "../src/tools/registry.ts";
import type { ToolContext } from "../src/tools/helpers/types.ts";

async function setup() {
  const cwd = await mkdtemp(path.join(tmpdir(), "arch-code-test-"));
  // Approve everything, but remember each approval prompt so tests can check what it said.
  const prompts: string[] = [];
  const gate = new PermissionGate({
    yolo: false,
    ask: async (_tool, summary) => {
      prompts.push(summary);
      return "yes";
    },
  });
  const registry = new ToolRegistry(ALL_TOOLS, gate);
  const ctx: ToolContext = {
    cwd,
    signal: new AbortController().signal,
    emit: () => {},
    askUser: async () => null,
    todos: [],
    readFiles: new Map(),
  };
  return {
    cwd,
    ctx,
    prompts,
    call: (name: string, args: object) => registry.run({ id: "t", type: "function", function: { name, arguments: JSON.stringify(args) } }, ctx),
    put: (file: string, content: string | Uint8Array) => writeFile(path.join(cwd, file), content),
    get: (file: string) => readFile(path.join(cwd, file), "utf8"),
    bytes: (file: string) => readFile(path.join(cwd, file)),
  };
}

describe("edit", () => {
  test("a fuzzy match keeps the file's indentation (Python)", async () => {
    const t = await setup();
    await t.put("f.py", "def f():\n    if x:\n        return 1\n");
    const r = await t.call("edit", { path: "f.py", old_string: "if x:\n  return 1", new_string: "if x:\n  return 2" });
    assert.equal(r.isError, false, r.output);
    assert.equal(await t.get("f.py"), "def f():\n    if x:\n        return 2\n");
    assert.match(r.output, /re-indented/);
  });

  test("a fuzzy match keeps the file's tabs", async () => {
    const t = await setup();
    await t.put("a.js", "\tif (a) {\n\t\tb();\n\t}\n");
    const r = await t.call("edit", { path: "a.js", old_string: "  if (a) {\n    b();", new_string: "  if (a) {\n    c();" });
    assert.equal(r.isError, false, r.output);
    assert.equal(await t.get("a.js"), "\tif (a) {\n\t\tc();\n\t}\n");
  });

  test("new indent levels are added in the file's own unit", async () => {
    const t = await setup();
    await t.put("f.py", "def f():\n    return 1\n");
    // Trailing spaces make the exact match fail; the model indents with 2 spaces, the file with 4.
    const r = await t.call("edit", { path: "f.py", old_string: "  return 1  ", new_string: "  if x:\n    return 2" });
    assert.equal(r.isError, false, r.output);
    assert.equal(await t.get("f.py"), "def f():\n    if x:\n        return 2\n");
  });

  test("refuses to guess when the model's indentation contradicts the file's", async () => {
    const t = await setup();
    await t.put("a.js", "\tif (a) {\n\t\tb();\n\t}\n");
    const r = await t.call("edit", { path: "a.js", old_string: "if (a) {\nb();", new_string: "if (a) {\nc();" });
    assert.equal(r.isError, true);
    assert.match(r.output, /would be a guess/);
  });

  test("binary files are refused, not corrupted", async () => {
    const t = await setup();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x41]);
    await t.put("img.png", png);
    const r = await t.call("edit", { path: "img.png", old_string: "PNG", new_string: "PNX" });
    assert.equal(r.isError, true);
    assert.match(r.output, /binary/);
    assert.deepEqual(new Uint8Array(await t.bytes("img.png")), png);
  });

  test("files that aren't valid UTF-8 are refused, not corrupted", async () => {
    const t = await setup();
    const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
    await t.put("menu.txt", latin1);
    const r = await t.call("edit", { path: "menu.txt", old_string: "caf", new_string: "bar" });
    assert.equal(r.isError, true);
    assert.match(r.output, /not valid UTF-8/);
    assert.deepEqual(new Uint8Array(await t.bytes("menu.txt")), latin1);
  });

  test("overlapping matches count as ambiguous", async () => {
    const t = await setup();
    await t.put("a.txt", "aaa");
    const r1 = await t.call("edit", { path: "a.txt", old_string: "aa", new_string: "X" });
    assert.equal(r1.isError, true);
    assert.match(r1.output, /appears 2 times/);

    await t.put("b.js", "}\n}\n}");
    const r2 = await t.call("edit", { path: "b.js", old_string: "}\n}", new_string: "END" });
    assert.equal(r2.isError, true);
    assert.match(r2.output, /appears 2 times in b\.js \(lines 1, 2\)/);
    assert.equal(await t.get("b.js"), "}\n}\n}");
  });

  test("mixed line endings: only the edited spot changes", async () => {
    const t = await setup();
    await t.put("m.txt", "a\r\nb\nc\n");
    const r = await t.call("edit", { path: "m.txt", old_string: "c", new_string: "C" });
    assert.equal(r.isError, false, r.output);
    assert.equal(await t.get("m.txt"), "a\r\nb\nC\n");
  });

  test("a multi-line replacement uses the line endings of the text it replaces", async () => {
    const t = await setup();
    await t.put("m.txt", "x\r\ny\r\nz\n");
    await t.call("edit", { path: "m.txt", old_string: "x\ny", new_string: "x\nY\nW" });
    assert.equal(await t.get("m.txt"), "x\r\nY\r\nW\r\nz\n");
  });

  test("a CRLF file with a BOM keeps both", async () => {
    const t = await setup();
    await t.put("w.txt", "\uFEFFa\r\nb\r\n");
    await t.call("edit", { path: "w.txt", old_string: "b", new_string: "b\nc" });
    assert.equal(await t.get("w.txt"), "\uFEFFa\r\nb\r\nc\r\n");
  });

  test("errors say what actually went wrong", async () => {
    const t = await setup();
    await mkdir(path.join(t.cwd, "src"));
    const dir = await t.call("edit", { path: "src", old_string: "a", new_string: "b" });
    assert.match(dir.output, /is a directory/);
    const missing = await t.call("edit", { path: "nope.txt", old_string: "a", new_string: "b" });
    assert.match(missing.output, /File not found: nope\.txt/);
  });

  test("permission errors are reported as permission errors", { skip: process.getuid?.() === 0 && "root ignores file permissions" }, async () => {
    const t = await setup();
    await t.put("secret.txt", "a\n");
    await chmod(path.join(t.cwd, "secret.txt"), 0o000);
    const r = await t.call("edit", { path: "secret.txt", old_string: "a", new_string: "b" });
    assert.match(r.output, /EACCES/);
  });

  test("a loose match that changes nothing says so instead of 'Edited'", async () => {
    const t = await setup();
    await t.put("f.txt", "  foo\n");
    const r = await t.call("edit", { path: "f.txt", old_string: "foo  ", new_string: "foo" });
    assert.equal(r.isError, true);
    assert.match(r.output, /No change/);
  });

  test("old_string ending in a newline still matches loosely", async () => {
    const t = await setup();
    await t.put("f.txt", "  foo\n  bar\n");
    const r = await t.call("edit", { path: "f.txt", old_string: "foo \n", new_string: "baz\n" });
    assert.equal(r.isError, false, r.output);
    assert.equal(await t.get("f.txt"), "  baz\n  bar\n");
  });

  test("checks that don't need the file come first", async () => {
    const t = await setup();
    const r = await t.call("edit", { path: "missing.txt", old_string: "", new_string: "x" });
    assert.match(r.output, /old_string is empty/);
  });

  test("$& and $1 in new_string are inserted literally", async () => {
    const t = await setup();
    await t.put("p.js", "price = 1;\n");
    await t.call("edit", { path: "p.js", old_string: "1", new_string: "'$&$1'" });
    assert.equal(await t.get("p.js"), "price = '$&$1';\n");
  });

  test("replace_all changes every occurrence", async () => {
    const t = await setup();
    await t.put("r.js", "foo(1)\nfoo(2)\nbar\n");
    const r = await t.call("edit", { path: "r.js", old_string: "foo", new_string: "baz", replace_all: true });
    assert.equal(await t.get("r.js"), "baz(1)\nbaz(2)\nbar\n");
    assert.match(r.output, /2 replacements at lines 1, 2/);
  });

  test("curly quotes in old_string still match straight ones, and new_string follows the file", async () => {
    const t = await setup();
    await t.put("s.js", 'say("hi");\n');
    const r = await t.call("edit", { path: "s.js", old_string: "say(\u201Chi\u201D)", new_string: "say(\u201Cbye\u201D)" });
    assert.equal(r.isError, false, r.output);
    assert.equal(await t.get("s.js"), 'say("bye");\n');

    await t.put("doc.md", "It\u2019s fine.\n");
    await t.call("edit", { path: "doc.md", old_string: "It's fine", new_string: "It's great" });
    assert.equal(await t.get("doc.md"), "It\u2019s great.\n");
  });

  test("the result says where the edit landed and shows those lines", async () => {
    const t = await setup();
    await t.put("f.ts", "a\nb\nc\nd\ne\nf\n");
    const r = await t.call("edit", { path: "f.ts", old_string: "d", new_string: "D" });
    assert.match(r.output, /1 replacement at line 4/);
    assert.match(r.output, /Lines 2-6 now read:\nb\nc\nD\ne\nf/);
  });

  test("the approval prompt shows the diff", async () => {
    const t = await setup();
    await t.put("f.py", "def f():\n    return 1\n");
    await t.call("edit", { path: "f.py", old_string: "return 1", new_string: "return 2" });
    assert.equal(t.prompts[0], "edit f.py (1 replacement)\n@@ line 2 @@\n-    return 1\n+    return 2");
  });
});

describe("write", () => {
  test("creating a file says 'create' in the prompt", async () => {
    const t = await setup();
    const r = await t.call("write", { path: "new/dir/a.txt", content: "one\ntwo\n" });
    assert.equal(r.isError, false, r.output);
    assert.equal(t.prompts[0], "create new/dir/a.txt (2 lines)\n+one\n+two");
    assert.equal(await t.get("new/dir/a.txt"), "one\ntwo\n");
  });

  test("won't overwrite a file the model hasn't read, and doesn't even ask", async () => {
    const t = await setup();
    await t.put("a.txt", "precious\n");
    const r = await t.call("write", { path: "a.txt", content: "oops\n" });
    assert.equal(r.isError, true);
    assert.match(r.output, /haven't read it/);
    assert.equal(t.prompts.length, 0);
    assert.equal(await t.get("a.txt"), "precious\n");
  });

  test("won't overwrite a file that changed since the model read it", async () => {
    const t = await setup();
    await t.put("a.txt", "v1\n");
    await t.call("read", { path: "a.txt" });
    await t.put("a.txt", "v2, edited by the user\n");
    await utimes(path.join(t.cwd, "a.txt"), new Date(), new Date(Date.now() + 5000)); // make sure mtime moved
    const r = await t.call("write", { path: "a.txt", content: "v3\n" });
    assert.match(r.output, /changed on disk/);
    assert.equal(await t.get("a.txt"), "v2, edited by the user\n");
  });

  test("after a read, overwriting works and the prompt says 'overwrite' with a diff", async () => {
    const t = await setup();
    await t.put("a.txt", "one\ntwo\nthree\n");
    await t.call("read", { path: "a.txt" });
    const r = await t.call("write", { path: "a.txt", content: "one\n2\nthree\n" });
    assert.equal(r.isError, false, r.output);
    assert.equal(t.prompts[0], "overwrite a.txt (replacing 3 lines with 3)\n@@ line 2 @@\n-two\n+2");
  });

  test("overwriting keeps CRLF line endings and the BOM", async () => {
    const t = await setup();
    await t.put("w.txt", "\uFEFFa\r\nb\r\n");
    await t.call("read", { path: "w.txt" });
    const r = await t.call("write", { path: "w.txt", content: "a\nc\n" });
    assert.equal(await t.get("w.txt"), "\uFEFFa\r\nc\r\n");
    assert.match(r.output, /keeping its CRLF line endings and byte-order mark/);
  });

  test("overwriting keeps the file's permissions", async () => {
    const t = await setup();
    await t.put("run.sh", "echo hi\n");
    await chmod(path.join(t.cwd, "run.sh"), 0o755);
    await t.call("read", { path: "run.sh" });
    await t.call("write", { path: "run.sh", content: "echo bye\n" });
    assert.equal((await stat(path.join(t.cwd, "run.sh"))).mode & 0o777, 0o755);
  });

  test("the model's own writes and edits keep its read up to date", async () => {
    const t = await setup();
    await t.put("a.txt", "one\n");
    await t.call("read", { path: "a.txt" });
    await t.call("edit", { path: "a.txt", old_string: "one", new_string: "two" });
    await t.call("write", { path: "a.txt", content: "three\n" });
    const r = await t.call("write", { path: "a.txt", content: "four\n" });
    assert.equal(r.isError, false, r.output);
    assert.equal(await t.get("a.txt"), "four\n");
  });
});

describe("read", () => {
  test("hides the BOM and CRLF from the model", async () => {
    const t = await setup();
    await t.put("w.txt", "\uFEFFa\r\nb\r\n");
    const r = await t.call("read", { path: "w.txt" });
    assert.equal(r.output, "a\nb");
  });

  test("says when a file is empty", async () => {
    const t = await setup();
    await t.put("e.txt", "");
    assert.equal((await t.call("read", { path: "e.txt" })).output, "(e.txt is empty)");
  });

  test("counts lines correctly (a final newline isn't an extra line)", async () => {
    const t = await setup();
    await t.put("two.txt", "a\nb\n");
    const r = await t.call("read", { path: "two.txt", limit: 1 });
    assert.match(r.output, /Showing lines 1-1 of 2/);
  });

  test("stops at a whole line when the output gets big, and says where to continue", async () => {
    const t = await setup();
    await t.put("big.txt", `${"x".repeat(99)}\n`.repeat(1000)); // 100,000 characters
    const r = await t.call("read", { path: "big.txt" });
    assert.ok(r.output.length < 26_000, `output was ${r.output.length} characters`);
    assert.doesNotMatch(r.output, /characters omitted/); // not cut in the middle by the registry
    assert.match(r.output, /Showing lines 1-250 of 1000 in big\.txt\. Use offset=251/);
  });

  test("refuses special files instead of hanging on them", async () => {
    const t = await setup();
    execFileSync("mkfifo", [path.join(t.cwd, "pipe")]); // reading a named pipe would wait forever
    const r = await t.call("read", { path: "pipe" });
    assert.match(r.output, /not a regular file/);
  });

  test("notes when a file isn't valid UTF-8", async () => {
    const t = await setup();
    await t.put("menu.txt", Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const r = await t.call("read", { path: "menu.txt" });
    assert.match(r.output, /not valid UTF-8/);
  });
});

describe("bash", () => {
  test("a character split across two output chunks arrives intact", async () => {
    const t = await setup();
    // Writes the 3 bytes of "€" in two separate writes, 50 ms apart.
    const script = "process.stdout.write(Buffer.from([0xe2, 0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x0a])), 50)";
    const r = await t.call("bash", { command: `node -e "${script}"` });
    assert.match(r.output, /^€/);
  });

  test("keeps the END of a huge output (that's where the errors are)", async () => {
    const t = await setup();
    const r = await t.call("bash", { command: `node -e "process.stdout.write('x'.repeat(3e6) + 'THE END')"` });
    assert.match(r.output, /THE END\n\nExit code: 0$/);
  });

  test("a command killed by a signal says so", async () => {
    const t = await setup();
    const r = await t.call("bash", { command: "kill -TERM $$" }); // bash kills itself
    assert.match(r.output, /Killed by signal SIGTERM\.$/);
  });

  test("the approval prompt says 'run'", async () => {
    const t = await setup();
    await t.call("bash", { command: "echo hi" });
    assert.equal(t.prompts[0], "run: echo hi");
  });
});

// Root can read any file, so permission tests only mean something for a normal user.
const asRoot = process.getuid?.() === 0 && "root ignores file permissions";

describe("grep", () => {
  test("a glob that matches no files says so, instead of 'No matches'", async () => {
    const t = await setup();
    await t.put("a.ts", "export const x = 1;\n");
    for (const include of ["[", "**/*.{ts", "src\\*.ts"]) {
      const r = await t.call("grep", { pattern: "export", include });
      assert.match(r.output, /match include .*so nothing was searched/, `include ${include}`);
      assert.doesNotMatch(r.output, /No matches for/);
    }
  });

  test("says how many files it searched when nothing matches", async () => {
    const t = await setup();
    await t.put("a.ts", "one\n");
    await t.put("b.ts", "two\n");
    const r = await t.call("grep", { pattern: "three", include: "*.ts" });
    assert.equal(r.output, "No matches for /three/ in 2 files searched.");
  });

  test("an empty include is a clear validation error", async () => {
    const t = await setup();
    const r = await t.call("grep", { pattern: "x", include: "" });
    assert.equal(r.isError, true);
    assert.match(r.output, /Invalid arguments for grep:[\s\S]*include/);
  });

  test("files too big to search are reported, not silently skipped", async () => {
    const t = await setup();
    await t.put("big.json", `${"x".repeat(1_100_000)}\nneedle\n`);
    const r = await t.call("grep", { pattern: "needle" });
    assert.match(r.output, /No matches for \/needle\/ in 0 files searched\./);
    assert.match(r.output, /1 file over 1 MB not searched \(big\.json\)/);
  });

  test("^ and $ work in Windows files and files with a BOM", async () => {
    const t = await setup();
    await t.put("win.ts", "\uFEFFimport x\r\nfoo\r\n");
    assert.match((await t.call("grep", { pattern: "^import" })).output, /win\.ts:1: import x/);
    assert.match((await t.call("grep", { pattern: "foo$" })).output, /win\.ts:2: foo/);
  });

  test("a missing path is 'not found'", async () => {
    const t = await setup();
    const r = await t.call("grep", { pattern: "x", path: "nope" });
    assert.match(r.output, /Path not found: nope/);
  });

  test("an unreadable file or folder is skipped and reported, and the rest is still searched", { skip: asRoot }, async () => {
    const t = await setup();
    await t.put("ok.ts", "needle\n");
    await t.put("secret.ts", "needle\n");
    await mkdir(path.join(t.cwd, "private"));
    await t.put("private/hidden.ts", "needle\n");
    await chmod(path.join(t.cwd, "secret.ts"), 0o000);
    await chmod(path.join(t.cwd, "private"), 0o000);
    try {
      const r = await t.call("grep", { pattern: "needle" });
      assert.equal(r.isError, false, r.output);
      assert.match(r.output, /^ok\.ts:1: needle/);
      assert.match(r.output, /1 file couldn't be read \(secret\.ts\)/);
      assert.match(r.output, /Some folders couldn't be read/);
    } finally {
      await chmod(path.join(t.cwd, "private"), 0o755); // so the temp folder can be cleaned up
    }
  });

  test("Esc stops the search and says so", async () => {
    const t = await setup();
    await t.put("a.ts", "needle\n");
    const controller = new AbortController();
    t.ctx.signal = controller.signal;
    const run = t.call("grep", { pattern: "needle" });
    controller.abort();
    const r = await run;
    assert.equal(r.isError, true);
    assert.match(r.output, /Interrupted|interrupted/);
  });
});

describe("glob", () => {
  test("a missing directory is 'not found', not 'no files match'", async () => {
    const t = await setup();
    const r = await t.call("glob", { pattern: "**/*.ts", path: "nope" });
    assert.equal(r.isError, true);
    assert.match(r.output, /Directory not found: nope/);
  });

  test("no matches comes with a hint about glob syntax", async () => {
    const t = await setup();
    const r = await t.call("glob", { pattern: "src\\*.ts" });
    assert.match(r.output, /No files match .*forward slashes/);
  });

  test("an empty pattern is a clear validation error", async () => {
    const t = await setup();
    const r = await t.call("glob", { pattern: "" });
    assert.match(r.output, /Invalid arguments for glob/);
  });

  test("an unreadable folder doesn't sink the whole search", { skip: asRoot }, async () => {
    const t = await setup();
    await t.put("a.ts", "");
    await mkdir(path.join(t.cwd, "private"));
    await chmod(path.join(t.cwd, "private"), 0o000);
    try {
      const r = await t.call("glob", { pattern: "**/*.ts" });
      assert.equal(r.isError, false, r.output);
      assert.match(r.output, /^a\.ts/);
      assert.match(r.output, /Some folders couldn't be read/);
    } finally {
      await chmod(path.join(t.cwd, "private"), 0o755);
    }
  });
});