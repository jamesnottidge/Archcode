import { stat } from "node:fs/promises";
import { ToolError } from "./types.ts";
import { displayPath } from "./utils.ts";
import fg from "fast-glob";
import type { WorkspaceFs } from "../../env/types.ts";

// Folders that are huge and almost never what the model is looking for.
export const IGNORED = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.arch-code/**"];

// What to tell the model when a glob matches nothing. A malformed glob ("[", "**/*.{ts",
// "src\*.ts") doesn't throw: fast-glob just matches nothing, which looks exactly like
// "no such files". So say what usually goes wrong.
export const GLOB_HINT = "Globs are relative to the search directory, use forward slashes, and need balanced {} and [].";

// Shared by glob and grep: the files under `dir` that match `pattern`, relative to `dir`.
// Refuses a missing or non-directory `dir` instead of reporting "no matches".
export async function findFiles(fs: WorkspaceFs, pattern: string, dir: string, cwd: string, signal?: AbortSignal): Promise<{ files: string[]; note: string | null }> {
    const info = await fs.stat(dir); // EACCES and friends throw: the real reason
    if (!info) throw new ToolError(`Directory not found: ${displayPath(cwd, dir)}`);
    if (info.kind !== "dir") throw new ToolError(`${displayPath(cwd, dir)} is a file, not a directory.`);
    // fast-glob happily follows "../../*" or "{/etc,src}/*" out of `dir`. Searching elsewhere is
    // what `path` is for, and `path` is what the permission gate checks.
    if (pattern.includes("..") || /(^|[{,])\//.test(pattern)) {
    throw new ToolError(`The pattern must stay inside the search directory (no "..", no absolute paths). To search somewhere else, set path.`);
    }
    return fs.listFiles(dir, pattern, signal);
}
      
