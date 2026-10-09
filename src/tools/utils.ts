import path from "node:path";

//Models give relative paths("src/app.ts") or absolute ones. Normalize. 
export function resolvePath(cwd: string, p: string): string {
    return path.resolve(cwd, p);
}

// show paths as relative to the project when we can. It's shorter ofr the humans and for the model. 
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

export function countLines(text: string): number {
    return text === "" ? 0 : text.split("\n").length;
}
