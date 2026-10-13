import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";

// The OS sandbox's only door to the internet. Sandboxed commands can't open network connections
// themselves; they can only reach this proxy (HTTP_PROXY / HTTPS_PROXY point at it), and the proxy
// asks the permission gate about each new site: "a command wants to connect to registry.npmjs.org".
//
// It sees the destination of every connection but not the content: HTTPS goes through as an
// encrypted tunnel (CONNECT), so the proxy decides by host name only. That's the right level for
// a human to answer: "is npm allowed?", not "is this request allowed?".

export type AllowHost = (host: string) => Promise<boolean>;

export class EgressProxy {
  private server: Server;
  private allowHost: AllowHost;
  private sockets = new Set<Socket>();
  // Answers for the command that's running now, so `npm install` (hundreds of connections to the
  // same host) asks once, not hundreds of times. "always" answers live in the gate instead.
  private answers = new Map<string, Promise<boolean>>();

  // If arch-code itself has to go through a proxy (a company network), so do we.
  private upstream: URL | null;

  constructor(allowHost: AllowHost, upstream = process.env.HTTPS_PROXY ?? process.env.https_proxy) {
    this.allowHost = allowHost;
    this.upstream = upstream ? new URL(upstream) : null;
    this.server = createServer((req, res) => void this.forwardHttp(req, res));
    this.server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => void this.tunnel(req, client, head));
    this.server.on("connection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
  }

  // A TCP port on 127.0.0.1 (macOS), or a unix socket file (Linux: the sandbox has no network at
  // all, so the socket is mounted into it and bridged to a port in there).
  listen(where: { port: 0 } | { socket: string }): Promise<number | null> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      const done = () => {
        const address = this.server.address();
        resolve(typeof address === "object" && address ? address.port : null);
      };
      if ("socket" in where) this.server.listen(where.socket, done);
      else this.server.listen(0, "127.0.0.1", done);
    });
  }

  // Called before each command: forget the per-command answers.
  newCommand(): void {
    this.answers.clear();
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private decide(host: string): Promise<boolean> {
    let answer = this.answers.get(host);
    if (!answer) {
      answer = this.allowHost(host).catch(() => false);
      this.answers.set(host, answer); // concurrent connections to the same host share one question
    }
    return answer;
  }

  // HTTPS: "CONNECT registry.npmjs.org:443". Ask, then join the two sockets.
  private async tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on("error", () => {});
    const { host, port } = splitHostPort(req.url ?? "", 443);
    if (!host || !(await this.decide(subject(host, port, 443)))) {
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\narch-code: the user did not allow connections to ${host}\n`);
      return;
    }
    const join = (upstream: Socket) => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    };
    const fail = (why: string) => client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${why}\n`);
    if (!this.upstream) {
      const upstream = connect(port, host, () => join(upstream));
      upstream.on("error", (err) => fail(err.message));
      client.on("close", () => upstream.destroy());
      return;
    }
    // Through the upstream proxy: ask IT for a tunnel, then join.
    const upstream = connect(Number(this.upstream.port || 80), this.upstream.hostname, () => {
      upstream.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let reply = "";
    const onData = (chunk: Buffer) => {
      reply += chunk.toString("latin1");
      const end = reply.indexOf("\r\n\r\n");
      if (end === -1) return;
      upstream.off("data", onData);
      if (!/^HTTP\/1\.[01] 2\d\d/.test(reply)) return fail(`upstream proxy said: ${reply.split("\r\n")[0]}`);
      join(upstream);
      const rest = Buffer.from(reply.slice(end + 4), "latin1"); // anything that came after the reply
      if (rest.length) client.write(rest);
    };
    upstream.on("data", onData);
    upstream.on("error", (err) => fail(err.message));
    client.on("close", () => upstream.destroy());
  }

  // Plain HTTP: "GET http://example.com/x". Ask, then forward the request.
  private async forwardHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("arch-code proxy: expected an absolute URL\n");
      return;
    }
    const port = Number(url.port || 80);
    if (!(await this.decide(subject(url.hostname, port, 80)))) {
      res.writeHead(403, { "content-type": "text/plain" }).end(`arch-code: the user did not allow connections to ${url.hostname}\n`);
      return;
    }
    const via = this.upstream
      ? { host: this.upstream.hostname, port: Number(this.upstream.port || 80), path: url.href }
      : { host: url.hostname, port, path: url.pathname + url.search };
    const upstream = httpRequest({ ...via, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", (err) => res.writeHead(502).end(`${err.message}\n`));
    req.pipe(upstream);
  }
}

// What the gate sees: the host name, plus the port when it isn't the usual one.
function subject(host: string, port: number, usual: number): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return port === usual ? h : `${h}:${port}`;
}

function splitHostPort(target: string, defaultPort: number): { host: string; port: number } {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(target);
  return m ? { host: m[1], port: Number(m[2] ?? defaultPort) } : { host: "", port: defaultPort };
}