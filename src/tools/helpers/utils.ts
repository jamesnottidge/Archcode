import path from "node:path";

//Models give relative paths("src/app.ts") or absolute ones. Normalize. 
export function resolvePath(cwd: string, p: string): string {
    return path.resolve(cwd, p);
}

// show paths as relative to the project when we can. It's shorter for the humans and for the model. 
export function displayPath(cwd: string, absolute: string): string {
    const rel = path.relative(cwd, absolute); 
    return rel.startsWith("..") ? absolute : rel || "."; 
}

//Tool output goes straight intothe context window, which is a tightly managed budget. 
// A 5 MB log would blow it in one call, so we keep the start and the end(where errors often are)
// and cut the middle
export function truncateMiddle(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    // 60% is from the start of the log
    const head = Math.floor(maxChars * 0.6);
    // 40% from the tail 
    const tail = maxChars - head;
    const omitted = text.length - head - tail;
    return `${text.slice(0, head)}\n\n[... ${omitted} characters omitted ...]\n\n${text.slice(-tail)}`;
}


// "a\nb\n" is two lines, not three: a final line break ends the last line, it doesn't start a new one.
export function splitLines(text: string): string[] {
    if (text === "") return [];
    return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

export function countLines(text: string): number {
    return splitLines(text).length;
}

export function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// The LCS table has (n+1) x (m+1) cells, so 2,000 lines a side is ~4M cells (8 MB, a few ms).
// Past that, a huge rewrite could freeze the approval prompt.
export const MAX_DIFF_LINES = 2000;

// A small diff for approval prompts: one "@@ line N @@" hunk per run of changed lines,
// as -removed / +added lines. N counts lines in `before`, starting at `firstLine`.
export function diffLines(before: string, after: string, firstLine = 1): string[] {
    const a = before.split("\n");
    const b = after.split("\n");
    // Lines both versions share at the start and the end can't be part of any change.
    // Dropping them is cheap, and usually leaves the expensive part below tiny.
    let top = 0;
    while (top < a.length && top < b.length && a[top] === b[top]) top++;
    let endA = a.length;
    let endB = b.length;
    while (endA > top && endB > top && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    const midA = a.slice(top, endA);
    const midB = b.slice(top, endB);
    if (midA.length === 0 && midB.length === 0) return [];
    if (midA.length > MAX_DIFF_LINES || midB.length > MAX_DIFF_LINES) {
      return hunk(firstLine + top, midA, midB); // too big to diff line by line: one block
    }

    // Walk the edit script, closing a hunk whenever an unchanged line separates two changes.
    const out: string[] = [];
    let line = firstLine + top; // the line in `before` we've reached
    let open: { at: number; removed: string[]; added: string[] } | null = null;
    for (const op of lcs(midA, midB)) {
      if (op.kind === "=") {
        if (open) out.push(...hunk(open.at, open.removed, open.added));
        open = null;
        line++;
        continue;
      }
      open ??= { at: line, removed: [], added: [] };
      if (op.kind === "-") {
        open.removed.push(op.line);
        line++;
      } else {
        open.added.push(op.line);
      }
    }
    if (open) out.push(...hunk(open.at, open.removed, open.added));
    return out;
}

function hunk(at: number, removed: string[], added: string[]): string[] {
    return [`@@ line ${at} @@`, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)];
}

type DiffOp = { kind: "=" | "-" | "+"; line: string };

// The classic dynamic-programming line diff: find the longest common subsequence (the most
// lines both versions keep, in order). Everything else in `a` was removed, everything else in `b` added.
function lcs(a: string[], b: string[]): DiffOp[] {
    const n = a.length;
    const m = b.length;
    const w = m + 1;
    // len[i * w + j] = LCS length of a[i..] and b[j..]. Filled from the end, so we can then walk
    // forward from the start. Uint16 is enough: an LCS is never longer than MAX_DIFF_LINES.
    const len = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        len[i * w + j] = a[i] === b[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
      }
    }
    const ops: DiffOp[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ kind: "=", line: a[i] });
        i++;
        j++;
      } else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) {
        ops.push({ kind: "-", line: a[i++] }); // dropping a[i] loses nothing
      } else {
        ops.push({ kind: "+", line: b[j++] });
      }
    }
    while (i < n) ops.push({ kind: "-", line: a[i++] });
    while (j < m) ops.push({ kind: "+", line: b[j++] });
    return ops;
}
  
  // Keep a preview readable: at most `max` lines, each at most 300 characters.
  export function capLines(lines: string[], max: number): string[] {
    const shown = lines.slice(0, max).map((l) => (l.length > 300 ? `${l.slice(0, 299)}…` : l));
    return lines.length > max ? [...shown, `… ${plural(lines.length - max, "more line")}`] : shown;
}
  
  // Offset -> 1-based line number, by binary search over where each line starts.
  export interface LineIndex {
    starts: number[];
    lineAt(offset: number): number;
}
  export function lineIndex(text: string): LineIndex {
    const starts = [0];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
    return {
      starts,
      lineAt(offset) {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid] <= offset) lo = mid;
          else hi = mid - 1;
        }
        return lo + 1;
      },
    };
}

const SAFE = [/^ls(\s|$)/, /^cat\s/, /^git (status|diff)(\s|$)/];
const SHELL_SYNTAX = /[;&|<>`$()\n\\]/; // chaining, pipes, redirects, substitution

export function isSafeCommand(command: string): boolean {
const cmd = command.trim();
if (SHELL_SYNTAX.test(cmd) || /\s--output/.test(cmd)) return false; // git diff --output=f writes a file
return SAFE.some((re) => re.test(cmd));
}