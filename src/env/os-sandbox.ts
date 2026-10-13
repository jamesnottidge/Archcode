import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scrubbedEnv } from "./host.ts";
import { HostFs } from "./host-fs.ts";
import { buildPolicy, type FsPolicy } from "./policy.ts";
import { run, runProcess, spawnQuiet } from "./process.ts";
import { type AllowHost, EgressProxy } from "./proxy.ts";
import type { ExecOptions, ExecResult, ExecutionEnv } from "./types.ts";

// The OS sandbox: the agent still works on your machine, in your real project folder (its changes
// are live, as in host mode), but every bash command runs inside a jail the operating system
// enforces. No container, no copy, no Docker. It's how Claude Code and Codex sandbox their bash.
//   macOS: Seatbelt, via sandbox-exec and a profile we generate (seatbeltProfile below)
//   Linux: bubblewrap (bwrap), which builds a private view of the filesystem with mounts
// The rules (policy.ts): write only inside the project; .git/hooks, .git/config and .arch-code/
// stay read-only; secrets are hidden; the network only through our proxy, which asks you.

export interface OsSandboxOptions {
  cwd: string;
  sessionId: string;
  allowHost: AllowHost; // the permission gate's answer for "may a command connect to <host>?"
  platform?: NodeJS.Platform; // tests override these
  home?: string;
  upstreamProxy?: string | null; // default: arch-code's own HTTPS_PROXY, if any
}

const BRIDGE_PORT = 3128; // Linux: inside the sandbox's own network namespace, so it can't clash
const PROXY_SOCKET = "/run/arch-code-proxy.sock"; // Linux: where the proxy's socket appears inside

export class OsSandboxEnv implements ExecutionEnv {
  readonly kind = "os";
  readonly cwd: string;
  fs: HostFs;
  private opts: OsSandboxOptions;
  private platform: NodeJS.Platform;
  private policy: FsPolicy | null = null;
  private proxy: EgressProxy | null = null;
  private proxyPort: number | null = null; // macOS
  private proxySocket: string | null = null; // Linux
  private cacheDir: string;
  private tmpDir: string;

  constructor(opts: OsSandboxOptions) {
    this.opts = opts;
    this.cwd = opts.cwd;
    this.platform = opts.platform ?? process.platform;
    // Package managers write caches to your home folder, which is off-limits. Give them one here.
    const uid = process.getuid?.() ?? 0;
    this.cacheDir = path.join(tmpdir(), `arch-code-cache-${uid}`);
    this.tmpDir = path.join(this.cacheDir, `tmp-${opts.sessionId.slice(0, 8)}`);
    this.fs = new HostFs(); // replaced in start(), once the policy exists
  }

  get bashNotes(): string {
    return [
      `Commands run in an OS sandbox (${this.platform === "darwin" ? "macOS Seatbelt" : "bubblewrap"}) on the user's machine, in their real project folder: your changes are live.`,
      `You can only write inside ${this.cwd} (and /tmp); .git/hooks, .git/config and .arch-code are read-only, and secret files (~/.ssh, ~/.aws, .env...) are hidden.`,
      "Internet access goes through a proxy, and the user approves each new site: if a download fails with 403 from the proxy, the user said no, so don't retry it.",
      "Each call is a fresh shell in the project folder: cd and export don't carry over.",
    ].join(" ");
  }

  describe(): string {
    return `OS sandbox (${this.platform === "darwin" ? "Seatbelt" : "bubblewrap"})`;
  }

  async start(): Promise<void> {
    await checkOsSandbox(this.platform);
    mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    this.policy = buildPolicy(this.cwd, { cacheDir: this.cacheDir, home: this.opts.home });
    this.fs = new HostFs({ policy: this.policy });
    this.proxy = new EgressProxy(this.opts.allowHost, this.opts.upstreamProxy === undefined ? undefined : (this.opts.upstreamProxy ?? ""));
    if (this.platform === "darwin") {
      this.proxyPort = await this.proxy.listen({ port: 0 });
    } else {
      this.proxySocket = path.join(this.cacheDir, `proxy-${randomUUID().slice(0, 8)}.sock`);
      await this.proxy.listen({ socket: this.proxySocket });
    }
  }

  exec(command: string, options: ExecOptions): Promise<ExecResult> {
    if (!this.policy || !this.proxy) throw new Error("The OS sandbox isn't started.");
    this.proxy.newCommand();
    const [file, ...args] = this.platform === "darwin" ? this.seatbeltArgs(command) : this.bwrapArgs(command);
    const child = spawnQuiet(file, args, { cwd: this.cwd, env: this.env(), detached: true });
    return runProcess(child, options, (c) => {
      try {
        process.kill(-c.pid!, "SIGKILL"); // the whole group; bwrap takes everything inside with it
      } catch {
        // already gone
      }
    });
  }

  async handBack(): Promise<string | null> {
    return null; // the agent worked on your real files: nothing to bring back
  }

  async close(): Promise<void> {
    await this.proxy?.close();
    this.proxy = null;
    if (this.proxySocket) await rm(this.proxySocket, { force: true });
  }

  // What the command sees. Your API keys are scrubbed as in host mode, and SSH_AUTH_SOCK goes too:
  // it would let a command use your SSH keys through the agent, without ever reading them.
  private env(): NodeJS.ProcessEnv {
    const { SSH_AUTH_SOCK, NO_PROXY, no_proxy, ...env } = scrubbedEnv();
    const proxy = this.platform === "darwin" ? `http://127.0.0.1:${this.proxyPort}` : `http://127.0.0.1:${BRIDGE_PORT}`;
    return {
      ...env,
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
      NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1", // Node's own fetch() ignores HTTP_PROXY unless told
      npm_config_cache: path.join(this.cacheDir, "npm"),
      XDG_CACHE_HOME: this.cacheDir,
      TMPDIR: this.platform === "darwin" ? this.tmpDir : "/tmp",
    };
  }

  // ── macOS ──
  private seatbeltArgs(command: string): string[] {
    return ["/usr/bin/sandbox-exec", "-p", seatbeltProfile(this.policy!, { tmpDir: this.tmpDir, proxyPort: this.proxyPort! }), "/bin/bash", "-c", command];
  }

  // ── Linux ──
  // bwrap builds the sandbox's filesystem out of mounts, in order (later ones cover earlier ones):
  // everything read-only, a private /tmp and /run, then the project writable again, its protected
  // parts read-only again, and the secrets covered up.
  private bwrapArgs(command: string): string[] {
    const p = this.policy!;
    const args = [
      "bwrap",
      "--die-with-parent", "--new-session",
      "--unshare-net", // no network at all, except the proxy socket below
      "--unshare-pid", // its own process list: it can't see or signal your processes
      "--ro-bind", "/", "/",
      "--dev", "/dev", "--proc", "/proc",
      "--bind", this.tmpDir, "/tmp", // a /tmp of its own, kept between this session's commands
      "--tmpfs", "/run", // hides the sockets in /run: Docker's (root on your machine!), ssh-agent, D-Bus
    ];
    for (const dir of p.writable) args.push("--bind", dir, dir);
    // .git mounted onto itself: a mount point can't be renamed, so `mv .git elsewhere` followed by
    // a fresh .git with a hook in it fails. (Its contents stay writable: commits work.)
    const git = path.join(p.project, ".git");
    if (existsSync(git) && statSync(git).isDirectory()) args.push("--bind", git, git);
    for (const ro of p.readOnly) if (existsSync(ro)) args.push("--ro-bind", ro, ro);
    for (const h of p.hidden) {
      if (!existsSync(h)) continue;
      if (statSync(h).isDirectory()) args.push("--tmpfs", h);
      else args.push("--ro-bind", "/dev/null", h);
    }
    args.push("--bind", this.proxySocket!, PROXY_SOCKET, "--chdir", this.cwd, "/bin/bash", "-c", LINUX_WRAPPER, command, process.execPath);
    return args;
  }
}

// Inside bwrap: start a tiny bridge from 127.0.0.1:3128 to the proxy's socket, wait until it
// listens, then become the command ($0). It's node because node is certainly installed: it's
// running arch-code. ($1 is node's path.)
const BRIDGE_JS = `require("net").createServer(c=>{const u=require("net").connect(${JSON.stringify(PROXY_SOCKET)});c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());c.pipe(u).pipe(c)}).listen(${BRIDGE_PORT},"127.0.0.1")`;
const LINUX_WRAPPER = `env -u NODE_USE_ENV_PROXY "$1" -e '${BRIDGE_JS}' & for _ in $(seq 50); do (: <>/dev/tcp/127.0.0.1/${BRIDGE_PORT}) 2>/dev/null && break; sleep 0.02; done; exec bash -c "$0"`;

// The macOS profile, in Apple's sandbox language (SBPL, a Lisp). When rules conflict, the LAST
// matching rule wins, so: allow everything, then take away writing, give writing back for the
// project, take it away again for the protected parts, hide the secrets, and cut the network
// down to the proxy and localhost.
export function seatbeltProfile(policy: FsPolicy, opts: { tmpDir: string; proxyPort: number }): string {
  const q = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  const writable = [...policy.writable, real(opts.tmpDir), "/private/tmp"].map((d) => `(subpath ${q(d)})`);
  const readOnly = policy.readOnly.map((p) => `(subpath ${q(p)})`);
  const hidden = policy.hidden.map((p) => `(subpath ${q(p)})`);
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.join(" ")} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
    // .git itself too: renaming the folder away and making a new one would dodge the rules below.
    `(deny file-write* (literal ${q(path.join(policy.project, ".git"))}) ${readOnly.join(" ")})`,
    ...(hidden.length ? [`(deny file-read* file-write* ${hidden.join(" ")})`] : []),
    // No network, which on macOS also means no unix sockets: no Docker socket, no ssh-agent.
    "(deny network*)",
    // ...except our proxy, and servers the command itself starts on localhost (tests do that).
    // Unlike on Linux, this also reaches other services listening on localhost on your Mac.
    `(allow network-outbound (remote ip "localhost:${opts.proxyPort}"))`,
    '(allow network-bind network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
  ].join("\n");
}

// The startup guard: say what's missing instead of failing on the first command.
export async function checkOsSandbox(platform: NodeJS.Platform): Promise<void> {
  if (platform === "darwin") {
    if (!existsSync("/usr/bin/sandbox-exec")) throw new Error("sandbox-exec wasn't found: the OS sandbox needs macOS's built-in Seatbelt.");
    return;
  }
  if (platform !== "linux") throw new Error(`The OS sandbox works on macOS and Linux, not ${platform}. Try /docker-sandbox.`);
  try {
    await run("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "--unshare-pid", "--dev", "/dev", "--proc", "/proc", "true"]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("bubblewrap isn't installed. Install it (Debian/Ubuntu: sudo apt install bubblewrap; Fedora: sudo dnf install bubblewrap) or use /docker-sandbox.");
    }
    throw new Error(`bubblewrap can't create a sandbox here: ${(err as Error).message.split("\n")[0]}. (Some systems block unprivileged user namespaces.)`);
  }
}