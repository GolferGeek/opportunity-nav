import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseEnv, getuid } from "node:process";
import { promisify } from "node:util";
import { childEnv } from "./system.ts";

const exec = promisify(execFile);
const envPath = () => join(homedir(), ".config/opportunity-nav/node.env");

export async function serviceEnv(): Promise<NodeJS.ProcessEnv> {
  const file = await open(envPath(), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (!file) throw new Error("Create ~/.config/opportunity-nav/node.env with mode 0600.");
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== getuid?.()) {
      throw new Error("Set ~/.config/opportunity-nav/node.env to mode 0600 and own it as the service user.");
    }
    const env = parseEnv(await file.readFile("utf8"));
    if (!env.OPNAV_SERVER_URL?.trim() || !env.OPNAV_NODE_TOKEN?.trim()) {
      throw new Error("Set OPNAV_SERVER_URL and OPNAV_NODE_TOKEN in node.env.");
    }
    return env;
  } finally {
    await file.close();
  }
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function unitArg(value: string) {
  return JSON.stringify(value.replaceAll("%", "%%").replaceAll("$", "$$"));
}

export async function manageService(action: "install-service" | "uninstall-service" | "status"): Promise<string> {
  const mac = process.platform === "darwin";
  if (!mac && process.platform !== "linux") throw new Error("User services are supported on macOS and Linux.");
  const label = "opnav-node";
  const unit = label + ".service";
  const domain = `gui/${getuid?.()}`;
  const target = `${domain}/${label}`;
  const path = mac ? join(homedir(), "Library/LaunchAgents", label + ".plist")
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user", unit);
  async function run(args: string[]) {
    return exec(mac ? "launchctl" : "systemctl", mac ? args : ["--user", ...args],
      { env: childEnv(process.env), timeout: 15_000 });
  }
  async function isLoaded() {
    if (mac) return run(["print", target]).then(() => true, () => false);
    const { stdout } = await run(["show", "--property=LoadState", "--value", unit]);
    return stdout.trim() !== "not-found";
  }
  if (action === "status") {
    if (!await isLoaded()) return "opnav-node is not installed.";
    const { stdout } = await run(mac ? ["print", target] : ["show", "--property=ActiveState", "--value", unit]);
    const running = mac ? /^\s*state = running\s*$/m.test(stdout) : stdout.trim() === "active";
    return running ? "opnav-node is running." : "opnav-node is stopped.";
  }
  if (action === "uninstall-service") {
    if (await isLoaded()) await run(mac ? ["bootout", target] : ["disable", "--now", unit]);
    await rm(path, { force: true });
    if (!mac) await run(["daemon-reload"]);
    return "opnav-node service removed.";
  }

  await serviceEnv();
  const args = [process.execPath, resolve(process.argv[1]!), "service-run"];
  const searchPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const contents = mac ? `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(searchPath)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
` : `[Unit]
Description=Opportunity Nav node

[Service]
Type=simple
Environment=${unitArg("PATH=" + searchPath)}
ExecStart=${args.map(unitArg).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { flag: "wx", mode: 0o644 });
  try {
    if (mac && await isLoaded()) await run(["bootout", target]);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  if (mac) {
    await run(["bootstrap", domain, path]);
  } else {
    await run(["daemon-reload"]);
    await run(["enable", unit]);
    await run(["restart", unit]);
  }
  return "opnav-node service installed.";
}
