import { stat } from "node:fs/promises";
import { ToolError } from "./types.ts";
import { displayPath } from "./utils.ts";
import fg from "fast-glob";

// Folders that are huge and almost never what the model is looking for.
export const IGNORED = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.arch-code/**"];

// What to tell the model when a glob matches nothing. A malformed glob ("[", "**/*.{ts",
// "src\*.ts") doesn't throw: fast-glob just matches nothing, which looks exactly like
// "no such files". So say what usually goes wrong.
export const GLOB_HINT = "Globs are relative to the search directory, use forward slashes, and need balanced {} and [].";

// Shared by glob and grep: the files under `dir` that match `pattern`, relative to `dir`.
// Refuses a missing or non-directory `dir` instead of reporting "no matches".
export async function findFiles(pattern: string, dir: string, cwd: string): Promise<{ files: string[]; note: string | null }> {
  const info = await stat(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw new ToolError(`Directory not found: ${displayPath(cwd, dir)}`);
    throw err; // EACCES and friends: the real reason
  });
  if (!info.isDirectory()) throw new ToolError(`${displayPath(cwd, dir)} is a file, not a directory.`);

  const options = { cwd: dir, ignore: IGNORED, dot: true, onlyFiles: true };
  try {
    return { files: (await fg(pattern, options)).sort(), note: null };
  } catch (err) {
    // By default fast-glob gives up on the WHOLE search when one folder can't be read.
    // Search the rest instead, and say what was missed.
    const { code, path: where } = err as NodeJS.ErrnoException;
    if (code !== "EACCES" && code !== "EPERM") throw err;
    const files = (await fg(pattern, { ...options, suppressErrors: true })).sort();
    return { files, note: `Some folders couldn't be read and were skipped (permission denied${where ? `, e.g. ${displayPath(cwd, where)}` : ""}).` };
  }
}
