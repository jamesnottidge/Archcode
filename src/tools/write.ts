import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { file, z } from "zod";
import { defineTool } from "./types.ts";
import { countLines, displayPath, resolvePath } from "./utils.ts";
import { ToolError } from "./types.ts";

export const writeTool =  defineTool({
    name: "write", 
    description: "Create a file or completely overwrite an existing one. Creates parent directories. For small changes to an existing file, prefer edit.",
    schema: z.object({
        path: z.string().describe("Path to the file, relative to the working directory or absolute."), 
        content: z.string().describe("The full content to write"),
    }),

    describeAction: ({ path, content }) => `write ${path} (${countLines(content)} lines)`,
    
    async execute({ path: p, content }, ctx) {
        const file = resolvePath(ctx.cwd, p);
        const stats = await stat(file).catch(() => null);
        if (stats?.isDirectory()) {
            throw new ToolError(`${displayPath(ctx.cwd, file)} is a directory, not a file.`);
        }
        const existed = stats !== null;
        
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content, "utf8");
        const verb = existed ? "Overwrote" : "Created";
        return `${verb} ${displayPath(ctx.cwd, file)} (${countLines(content)} lines).`;
      },


});