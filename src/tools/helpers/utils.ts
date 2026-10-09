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

// A small diff for approval prompts: drop the lines both versions share at the start and
// at the end, and show what's left in the middle as -removed / +added lines.
export function diffLines(before: string, after: string, firstLine = 1): string[] {
    const a = before.split("\n");
    const b = after.split("\n");
    let top = 0;
    while (top < a.length && top < b.length && a[top] === b[top]) top++;
    let endA = a.length;
    let endB = b.length;
    while (endA > top && endB > top && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    if (endA === top && endB === top) return [];
    return [
      `@@ line ${firstLine + top} @@`,
      ...a.slice(top, endA).map((line) => `-${line}`),
      ...b.slice(top, endB).map((line) => `+${line}`),
    ];
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
