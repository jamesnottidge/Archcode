import { readFile, stat } from "node:fs/promises";
import z from "zod";
import { defineTool, ToolError } from "./types.ts";
import { displayPath, resolvePath } from "./utils.ts";

const DEFAULT_LIMIT = 2000; //lines
const MAX_LINE_LENGTH = 2000; // characters: minified lines have absurd lines


export const readTool = defineTool({
    name: "read", 
    description: "Read a text file. Returns up to 2000 lines by default; use offset and limit to page through bigger files.",
    schema: z.object({
        path: z.string().describe("Path to the file, relative to the working directory or absolute"),
        offset: z.number().int().min(1).optional().describe("1-based line number to start from"),
        limit: z.number().int().min(1).optional().describe("Maximum number of lines to return"),
      }),
    async execute({ path, offset = 1, limit = DEFAULT_LIMIT }, ctx) {
        const file = resolvePath(ctx.cwd, path);
        const info = await stat(file).catch(() => null);
        if (!info) throw new ToolError(`File not found: ${path}`);
        if (info.isDirectory()) throw new ToolError(`${path} is a directory. Use glob to list files.`)
        
        const buffer =  await readFile(file); 

        // A NUL byte in the first 8kb almost always means binary (images, zips...). 

        if (buffer.subarray(0, 8192).includes(0)){
            throw new ToolError(`${path} looks like a binary file; not reading it.`)
        }

        const lines = buffer.toString("utf8").split("\n"); 
        const start = offset - 1; 
        if (start >= lines.length && lines.length > 0) {
            throw new ToolError(`offset ${offset} is past the end of the file (${lines.length} lines). `)
        }
        const slice = lines.slice(start, start + limit)
                        .map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(9, MAX_LINE_LENGTH)} ... [line truncated]` : line));
        let out = slice.join("\n");
        let end = start + slice.length; 
        if (start > 0 || end < lines.length) {
            // Tell the model there is more, and exactly how to get it.
            out += `\n\n[Showing lines ${start + 1}-${end} of ${lines.length} in ${displayPath(ctx.cwd, file)}.`;
            out += end < lines.length ? ` Use offset=${end + 1} to read more.]` : "]";
        }

        return out;
    },
})
