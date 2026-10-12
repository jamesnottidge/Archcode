import TurndownService from "turndown";
import { z } from "zod";
import { defineTool, ToolError } from "./helpers/types.ts";

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB: plenty for docs pages, protects us from giant downloads
const TIMEOUT_MS = 30_000;
const TEXT_TYPES = ["text/", "application/json", "application/xml", "application/xhtml", "+json", "+xml"];

export const webFetchTool = defineTool({
  name: "web_fetch",
  kind: "network",
  subject: (args) => args.url, 
  description:
    "Download a web page or text resource (docs, READMEs, JSON APIs) and return it as text. HTML is converted to Markdown.",
  schema: z.object({
    url: z.url().describe("The http(s) URL to fetch"),
  }),

  describeAction: ({ url }) => `fetch ${url}`,

  async execute({ url }, ctx) {
    if (!/^https?:\/\//.test(url)) throw new ToolError("Only http:// and https:// URLs are supported.");

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "arch-code/0.1 (coding agent)" },
        redirect: "follow",
        // Give up after 30 s, or immediately if the user presses Esc.
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (err) {
      throw new ToolError(`Request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new ToolError(`HTTP ${res.status} ${res.statusText} for ${url}`);

    const type = res.headers.get("content-type") ?? "";
    if (!TEXT_TYPES.some((t) => type.includes(t))) {
      throw new ToolError(`Refusing non-text content (${type || "unknown type"}).`);
    }

    const body = await readCapped(res, MAX_BYTES);
    const text = type.includes("html") ? htmlToMarkdown(body) : body;
    return `HTTP ${res.status} ${res.url}\n\n${text}`;
  },
});

// Read the body chunk by chunk and stop at the cap, instead of trusting Content-Length.
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of res.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      await res.body.cancel().catch(() => {});
      return `${text}\n\n[Body truncated at ${maxBytes} bytes]`;
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  turndown.remove(["head", "script", "style", "noscript", "iframe", "svg"]);
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  const markdown = turndown.turndown(html);
  return title ? `# ${title}\n\n${markdown}` : markdown;
}