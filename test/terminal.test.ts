// Tests for the terminal UI's defenses. Run them with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { visible } from "../src/ui/terminal.ts";

test("control characters are shown, not obeyed", () => {
  // A "\r" would let the second half of a command print over the first half.
  assert.equal(visible("rm -rf ~ \r ls"), "rm -rf ~ \\x0d ls");
  // An escape sequence (here: clear the screen) is shown as text.
  assert.equal(visible("\x1b[2Jhello"), "\\x1b[2Jhello");
  // A Unicode direction override ("Trojan Source") is made visible too.
  assert.equal(visible("a\u202Eb"), "a\\u202eb");
  // Newlines and tabs are normal text and stay; Windows line endings become plain ones.
  assert.equal(visible("one\ttwo\r\nthree\n"), "one\ttwo\nthree\n");
});