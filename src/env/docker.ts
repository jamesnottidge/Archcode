import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { HostFs } from "./host-fs.ts";
import { PID_WRAPPER, run, runProcess, spawnQuiet } from "./process.ts";
import type { ExecOptions, ExecResult, ExecutionEnv } from "./types.ts";
import { cloneWorkspace, createStaging, handBack, loadMeta, saveMeta, type WorkspaceMeta } from "./workspace.ts";

export const WORKSPACE = "/workspace";
// Debian 12 with Node 24, git, python3, make, gcc and curl. Big (about 400 MB to download, once),
// but it has the tools an agent reaches for. Use --sandbox-image for your own toolchain.
export const DEFAULT_IMAGE = "node:24-bookworm";

export interface DockerOptions {
  sessionId: string;
  dataDir: string; // <project>/.arch-code
  source: string | null; // the repo to clone into the workspace (null: start empty)
  image: string;
  network: boolean;
  log: (line: string) => void; // progress for the human ("pulling image...")
}

// One container per session, kept alive with `sleep infinity`; every command is a fresh
// `docker exec` into it. The project lives on YOUR disk (in .arch-code/sandbox/<id>) and is
// bind-mounted at /workspace, so the file tools work on it directly from the host while bash
// runs inside. The container can see that folder and nothing else of your machine.
export class DockerEnv implements ExecutionEnv {
  readonly kind = "docker";
  readonly cwd = WORKSPACE;
  readonly fs: HostFs;
  private opts: DockerOptions;
  private hostDir: string;
  private metaFile: string;
  private meta: WorkspaceMeta | null = null;
  private name: string;
  private execCount = 0;
  private running = false;

  constructor(opts: DockerOptions) {
    this.opts = opts;
    const dir = path.join(opts.dataDir, "sandbox");
    this.hostDir = path.join(dir, opts.sessionId);
    this.metaFile = path.join(dir, `${opts.sessionId}.json`);
    this.name = `arch-code-${opts.sessionId.slice(0, 8)}`;
    this.fs = new HostFs({ mount: { logical: WORKSPACE, host: this.hostDir } });
  }

  get bashNotes(): string {
    return [
      "Commands run in an isolated Linux container (Debian 12 with Node 24, git, python3), not on the user's machine.",
      this.meta
        ? `${WORKSPACE} is a copy of the user's project (a git clone, including their uncommitted changes; gitignored files like .env are not in it). Their real files don't change: when the user leaves the sandbox, your work is handed back to them as the git branch ${this.meta.branch}. Commit as you like; uncommitted work is committed for you.`
        : `${WORKSPACE} started empty.`,
      `Each call is a fresh shell in ${WORKSPACE}: cd and export don't carry over, so chain commands with && when needed.`,
      "You can't use sudo or apt-get; only /workspace and /tmp are writable.",
      this.opts.network ? "The network is on (npm install etc. work)." : "There is no network access.",
    ].join(" ");
  }

  describe(): string {
    return `Docker sandbox${this.opts.network ? "" : ", no network"} (${this.name})`;
  }

  async start(): Promise<void> {
    await checkDocker();
    await this.ensureImage();
    await this.prepareWorkspace();
    await this.startContainer();
  }

  // ── bash ──
  // `docker exec` starts each command as its own process group inside the container. We note
  // its pid in a file first, so a timeout or Esc can kill that whole group in there. (Killing
  // only the `docker exec` client on our side would leave the command running in the container.)
  async exec(command: string, options: ExecOptions): Promise<ExecResult> {
    const result = await this.execOnce(command, options);
    // The container can die under us: out of memory, or the agent ran `kill 1`. The files are
    // safe on the mount, so start a fresh container and try once more.
    if (result.exitCode !== 0 && /No such container|is not running/.test(result.output) && !options.signal.aborted) {
      this.opts.log("The sandbox container stopped; starting a new one (files are kept).");
      await this.startContainer();
      const retry = await this.execOnce(command, options);
      return { ...retry, output: `[The sandbox container had stopped and was restarted. Files in ${WORKSPACE} are intact; running processes and /tmp were lost.]\n${retry.output}` };
    }
    return result;
  }

  private execOnce(command: string, options: ExecOptions): Promise<ExecResult> {
    const pidFile = `/tmp/.arch-exec-${++this.execCount}.pid`;
    const child = spawnQuiet("docker", ["exec", "-w", WORKSPACE, this.name, "bash", "-c", PID_WRAPPER, pidFile, command]);
    return runProcess(child, options, async (c) => {
      await run("docker", ["exec", this.name, "bash", "-c", `kill -KILL -- -"$(cat ${pidFile})"`]).catch(() => {});
      c.kill("SIGKILL"); // and the client, in case the container itself is wedged
    });
  }

  async handBack(): Promise<string | null> {
    if (!this.meta) return null;
    const message = await handBack(this, this.meta, this.opts.sessionId);
    saveMeta(this.metaFile, this.meta); // remember what was shipped
    return message;
  }

  async close(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await run("docker", ["rm", "-f", this.name]).catch(() => {}); // --rm is the backstop if we crash
  }

  // ── setup ──


  private async ensureImage(): Promise<void> {
    const { image, log } = this.opts;
    const present = await run("docker", ["image", "inspect", image]).then(() => true, () => false);
    if (present) return;
    log(`Downloading the sandbox image ${image} (first time only, this can take a few minutes)...`);
    await run("docker", ["pull", "--quiet", image]);
  }

  // First time in this session: copy the project into its own folder. Coming back later (a second
  // /docker-sandbox, or a resumed session with -c, -r) finds the folder there and carries on.
  private async prepareWorkspace(): Promise<void> {
    this.meta = loadMeta(this.metaFile);
    if (existsSync(this.hostDir) && readdirSync(this.hostDir).length > 0) return;
    mkdirSync(path.dirname(this.hostDir), { recursive: true });
    const { source, log, sessionId } = this.opts;
    if (!source) {
      mkdirSync(this.hostDir, { recursive: true });
      return;
    }
    log(`Cloning ${source} into the sandbox workspace...`);
    this.meta ??= await createStaging(source, path.join(path.dirname(this.hostDir), `${sessionId}.git`), sessionId);
    saveMeta(this.metaFile, this.meta);
    await cloneWorkspace(this.meta, this.hostDir);
  }

  private async startContainer(): Promise<void> {
    await run("docker", ["rm", "-f", this.name]).catch(() => {}); // a leftover from a crash
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    await run("docker", [
      "run", "--detach", "--rm", "--init",
      "--name", this.name,
      "--label", `arch-code.session=${this.opts.sessionId}`,
      // Run as YOU (your uid), not root: files it creates in the workspace are yours on the host.
      "--user", `${uid}:${gid}`,
      // Least privilege: no Linux capabilities, no setuid escalation (sudo is useless in here).
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      // The image itself is read-only. Writable: the workspace, and a scratch /tmp in memory.
      "--read-only",
      "--tmpfs", "/tmp:rw,exec,size=1g",
      // A runaway command (a fork bomb, a memory leak) hits these walls instead of your Mac.
      "--memory", "4g", "--cpus", "2", "--pids-limit", "512",
      "--network", this.opts.network ? "bridge" : "none",
      // An EXPLICIT environment: nothing from your shell (API keys!) leaks in.
      "--env", "HOME=/tmp",
      "--env", "GIT_AUTHOR_NAME=arch-code", "--env", "GIT_AUTHOR_EMAIL=arch-code@localhost",
      "--env", "GIT_COMMITTER_NAME=arch-code", "--env", "GIT_COMMITTER_EMAIL=arch-code@localhost",
      // Through Docker Desktop's file sharing, the workspace's owner may not look like the user
      // in here, and git then refuses the repo as "dubious ownership". Inside the sandbox that
      // check protects nothing, so switch it off.
      "--env", "GIT_CONFIG_COUNT=1", "--env", "GIT_CONFIG_KEY_0=safe.directory", "--env", "GIT_CONFIG_VALUE_0=*",
      "--volume", `${this.hostDir}:${WORKSPACE}`,
      "--workdir", WORKSPACE,
      this.opts.image,
      "sleep", "infinity",
    ]);
    if (!this.running) {
      // close() is the normal way out. If arch-code crashes, "exit" still fires: remove the
      // container synchronously there, or it would sleep forever. (List strays with:
      // docker ps --filter label=arch-code.session)
      process.once("exit", () => {
        if (this.running) spawnSync("docker", ["rm", "-f", this.name], { stdio: "ignore" });
      });
    }
    this.running = true;
  }
}

// The startup guard: a clear sentence instead of a stack trace when Docker isn't there.
export async function checkDocker(): Promise<void> {
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Docker isn't installed. Install Docker Desktop (https://docs.docker.com/desktop/) to use the Docker sandbox, or try /sandbox.");
    }
    throw new Error("Docker isn't running. Start Docker Desktop and try again, or try /sandbox.");
  }
}