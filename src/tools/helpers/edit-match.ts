import type { Range } from "./text-file.ts";
import { ToolError } from "./types.ts";
import { type LineIndex, plural } from "./utils.ts";

// Finding what edit should replace. Kept apart from edit.ts because it's the subtle part:
// three tries from strict to forgiving, overlap-aware counting, and re-indenting.

// One spot to change. Offsets are into the normalized text the model sees.
export interface Match extends Range {
  replacement: string;
}

// Three tries, from strict to forgiving. Each one runs only if the previous one found nothing.
export function findMatches(
  text: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
  lines: LineIndex,
  shown: string,
): { matches: Match[]; notes: string[] } {
  // 1. Exact.
  let found = findAll(text, oldText);
  if (found.length > 0) {
    const picked = pick(found, replaceAll, lines, shown);
    return { matches: picked.ranges.map((r) => ({ ...r, replacement: newText })), notes: picked.notes };
  }

  // 2. Exact, after swapping look-alikes (curly quotes, non-breaking spaces) for plain characters.
  //    Each swap is one character for one character, so positions in the plain text are
  //    positions in the real text too.
  found = findAll(plainChars(text), plainChars(oldText));
  if (found.length > 0) {
    const picked = pick(found, replaceAll, lines, shown);
    return {
      matches: picked.ranges.map((r) => ({ ...r, replacement: matchQuoteStyle(newText, text.slice(r.start, r.end)) })),
      notes: ["old_string matched only after treating curly quotes and special spaces as plain ones", ...picked.notes],
    };
  }

  // 3. Whole lines, ignoring indentation and trailing spaces; then re-indent new_string to fit.
  return fuzzyLineMatches(text, oldText, newText, replaceAll, lines, shown);
}

// Every place `needle` occurs, INCLUDING overlapping ones: "aa" occurs twice in "aaa",
// and "}\n}" twice in "}\n}\n}". (text.split(needle) would count each of those once.)
function findAll(haystack: string, needle: string): Range[] {
  const found: Range[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    found.push({ start: i, end: i + needle.length });
  }
  return found;
}

// Enforce "exactly once", or with replace_all, skip any match that overlaps the one before it.
function pick(found: Range[], replaceAll: boolean, lines: LineIndex, shown: string): { ranges: Range[]; notes: string[] } {
  if (found.length > 1 && !replaceAll) {
    const at = [...new Set(found.map((r) => lines.lineAt(r.start)))];
    throw new ToolError(
      `old_string appears ${found.length} times in ${shown} (line${at.length === 1 ? "" : "s"} ${at.slice(0, 20).join(", ")}). Include more surrounding lines so it matches exactly once, or set replace_all to true to change every occurrence.`,
    );
  }
  const ranges: Range[] = [];
  for (const r of found) if (ranges.length === 0 || r.start >= ranges[ranges.length - 1].end) ranges.push(r);
  const skipped = found.length - ranges.length;
  return { ranges, notes: skipped > 0 ? [`skipped ${plural(skipped, "occurrence")} overlapping an earlier one`] : [] };
}

// Look-alike characters models swap in and out, mapped to their plain versions.
const LOOKALIKES = /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u00A0\u2007\u202F]/g;
function plainChars(s: string): string {
  return s.replace(LOOKALIKES, (c) => ("\u00A0\u2007\u202F".includes(c) ? " " : "\u201C\u201D\u201E\u201F".includes(c) ? '"' : "'"));
}

// The model and the file disagreed on quote style, so make new_string follow the file. For each
// kind of quote: if the replaced text used only straight ones, straighten new_string's; if it used
// only curly ones, curl them (it's an opening quote after a space or bracket, otherwise closing).
const QUOTE_KINDS = [
  { straight: '"', open: "\u201C", close: "\u201D" },
  { straight: "'", open: "\u2018", close: "\u2019" },
];
function matchQuoteStyle(replacement: string, replaced: string): string {
  let out = replacement;
  for (const { straight, open, close } of QUOTE_KINDS) {
    const fileCurly = replaced.includes(open) || replaced.includes(close);
    const fileStraight = replaced.includes(straight);
    if (fileStraight && !fileCurly) out = out.replaceAll(open, straight).replaceAll(close, straight);
    if (fileCurly && !fileStraight) {
      const chars = [...out];
      out = chars.map((c, i) => (c !== straight ? c : i === 0 || /[\s([{]/.test(chars[i - 1]) ? open : close)).join("");
    }
  }
  return out;
}

// ── try 3: whole lines, then re-indent ──

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];
const widthOf = (indent: string) => indent.replaceAll("\t", "    ").length; // a tab counts as 4 columns

function fuzzyLineMatches(
  text: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
  lines: LineIndex,
  shown: string,
): { matches: Match[]; notes: string[] } {
  // old_string ending in "\n" means "these whole lines, line break included". Split without that
  // final "\n", or it becomes an extra empty line that would have to match a blank line.
  const takesBreak = oldText.endsWith("\n");
  const oldLines = (takesBreak ? oldText.slice(0, -1) : oldText).split("\n");
  const key = (line: string) => plainChars(line.trim());
  const wanted = oldLines.map(key);
  const fileLines = text.split("\n");
  const fileKeys = fileLines.map(key);

  const notFound = new ToolError(
    `old_string not found in ${shown}, even ignoring indentation. Read the file again and copy the exact text, including whitespace.`,
  );
  if (wanted.every((w) => w === "")) throw notFound; // only blank lines: they'd match anywhere

  const found: Range[] = [];
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    if (!wanted.every((w, j) => fileKeys[i + j] === w)) continue;
    const last = i + oldLines.length - 1;
    const end = lines.starts[last] + fileLines[last].length;
    found.push({ start: lines.starts[i], end: takesBreak ? Math.min(end + 1, text.length) : end });
  }
  if (found.length === 0) throw notFound;

  const picked = pick(found, replaceAll, lines, shown);
  const unit = detectIndentUnit(fileLines);
  const matches = picked.ranges.map((r) => {
    const first = lines.lineAt(r.start) - 1;
    const replacement = reindent(newText, oldLines, fileLines.slice(first, first + oldLines.length), unit);
    if (replacement === null) {
      throw new ToolError(
        `old_string only matches ${shown} if indentation is ignored, and its indentation doesn't line up with the file's, so re-indenting new_string would be a guess. Copy the lines exactly as read shows them.`,
      );
    }
    return { ...r, replacement: matchQuoteStyle(replacement, text.slice(r.start, r.end)) };
  });
  return {
    matches,
    notes: ["old_string matched only after ignoring indentation and trailing spaces, so new_string was re-indented to fit the file", ...picked.notes],
  };
}

// We only get here because the model's indentation was off. Learn how ITS indentation maps to
// the FILE's from the old_string lines we matched, then apply that same mapping to new_string.
// Returns null when the mapping contradicts itself, because then we would be guessing.
function reindent(newText: string, oldLines: string[], fileBlock: string[], fileUnit: string | null): string | null {
  const map = new Map<number, string>(); // the model's indent width -> the file's indent string
  for (let j = 0; j < oldLines.length; j++) {
    if (oldLines[j].trim() === "") continue;
    const width = widthOf(indentOf(oldLines[j]));
    const fileIndent = indentOf(fileBlock[j]);
    const known = map.get(width);
    if (known === undefined) map.set(width, fileIndent);
    else if (widthOf(known) !== widthOf(fileIndent)) return null; // one model indent, two file indents
  }
  const known = [...map.keys()].sort((a, b) => a - b);
  // Deeper in the model's version must not mean shallower in the file.
  for (let i = 1; i < known.length; i++) {
    if (widthOf(map.get(known[i])!) < widthOf(map.get(known[i - 1])!)) return null;
  }

  // For indent levels old_string didn't show us, step in whole levels: how wide is one level
  // for the model (smallest gap between its indents), and what is one level in the file?
  const newLines = newText.split("\n");
  const widths = [...new Set([...known, ...newLines.filter((l) => l.trim() !== "").map((l) => widthOf(indentOf(l)))])].sort((a, b) => a - b);
  const gaps = widths.slice(1).map((w, i) => w - widths[i]);
  const modelUnit = gaps.length > 0 ? Math.min(...gaps) : 4;
  const unit = fileUnit ?? " ".repeat(modelUnit);

  return newLines
    .map((line) => {
      if (line.trim() === "") return "";
      const indent = indentOf(line);
      const width = widthOf(indent);
      let fileIndent = map.get(width);
      if (fileIndent === undefined) {
        const base = known.filter((k) => k <= width).at(-1) ?? known[0];
        fileIndent = shiftIndent(map.get(base)!, Math.round((width - base) / modelUnit), unit);
      }
      return fileIndent + line.slice(indent.length);
    })
    .join("\n");
}

function shiftIndent(indent: string, levels: number, unit: string): string {
  if (levels >= 0) return indent + unit.repeat(levels);
  let out = indent;
  for (let i = 0; i < -levels && out.endsWith(unit); i++) out = out.slice(0, -unit.length);
  return out;
}

// How does this file indent one level: "\t", "  ", "    "...? null if nothing is indented.
// Tabs if most indented lines start with a tab; otherwise the most common step in spaces
// between one line and a more-indented next line.
function detectIndentUnit(lines: string[]): string | null {
  let tabbed = 0;
  let spaced = 0;
  const steps = new Map<number, number>(); // "indent grew by N spaces" -> how often
  let previous = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (indent.startsWith("\t")) {
      tabbed++;
      continue;
    }
    if (indent.length > 0) spaced++;
    if (indent.length > previous) steps.set(indent.length - previous, (steps.get(indent.length - previous) ?? 0) + 1);
    previous = indent.length;
  }
  if (tabbed > spaced) return "\t";
  const best = [...steps].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return best ? " ".repeat(best[0]) : null;
}