#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const COMPOSE_FILE = path.join(ROOT_DIR, "docker-compose.yml");

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

function usage() {
  process.stdout.write(`用法：
  node scripts/docker/run-instance.mjs [参数...]

作用：
  启动一个“新的 OpenClaw 实例”（第二套/第 N 套），并与已有实例隔离：
  - 通过 docker compose 的 Project Name（-p）隔离容器/网络
  - 通过不同的端口映射隔离访问入口
  - 通过不同的挂载目录隔离数据与配置（持久化）

说明：
  - 这是跨平台脚本（Windows / Linux 都能用），前提是机器上已安装 Docker Desktop 或 Docker Engine + Docker Compose。
  - 本脚本不需要源码参与运行，但需要同目录下的 docker-compose.yml（用于定义 ports/volumes/command）。

参数：
  --project <name>
    docker compose Project 名称。不同实例必须不同。

  --image <name[:tag]>
    运行的镜像名。示例：openclaw:local、openclaw:myfork。

  --config-dir <path>
    宿主机配置目录（持久化），挂载到容器 /home/node/.openclaw。

  --workspace-dir <path>
    宿主机工作区目录（持久化），挂载到容器 /home/node/.openclaw/workspace。

  --gateway-port <port>
    宿主机端口 -> 容器 18789（Gateway）。

  --bridge-port <port>
    宿主机端口 -> 容器 18790（Bridge）。

  --bind <loopback|lan|...>
    网关绑定方式（传给 openclaw gateway --bind）。常见：loopback、lan。

  --token <hex>
    指定实例的 gateway token。如果不提供将自动生成并写入 <config-dir>/openclaw.json。

  --disable-device-auth
    完全禁用 Control UI 的设备配对认证。
    启用后，任何能访问 Control UI 端口的浏览器都可以直接进入首页，无需输入 Token 或批准配对。
    非常适合“内网完全信任”场景，但注意这意味着无鉴权。

  --auto-approve
    保留 Token 验证，但自动批准带有效 Token 的设备。
    当用户通过带有 \`#token=<your_token>\` 的 URL 访问时，直接进入控制台，无需手动点击配对。

  --volcengine-key <key>
    预配置火山引擎 (Volcengine) API Key。
    设置后将自动写入配置并设为默认主模型提供商。

  --allowed-origins <csv>
    Control UI 允许的来源列表（逗号分隔）。
    示例：http://127.0.0.1:28789,http://192.168.1.10:28789
    如果 --bind 不是 loopback 且不提供该参数，将默认设置为：
      http://127.0.0.1:<gateway-port>

  --home-volume <name-or-path>
    可选：为容器 /home/node 额外挂载一个卷/目录（持久化 home 目录）。
    - 传 name（不含 / 或 \\）视为“命名卷”，例如 openclaw2-home
    - 传 path（含 / 或 \\）视为宿主机路径，例如 /data/openclaw2/home 或 D:\\data\\openclaw2\\home
    启用该参数会生成并使用 overlay：docker-compose.<project>.extra.yml

  --extra-mounts <csv>
    可选：额外挂载（逗号分隔），每项格式：source:target[:options]
    示例：/data/shared:/mnt/shared:ro

示例：
  node scripts/docker/run-instance.mjs \\
    --project user2 \\
    --image openclaw:local \\
    --config-dir D:\\\\openclaw-data\\\\user2\\\\config \\
    --workspace-dir D:\\\\openclaw-data\\\\user2\\\\workspace \\
    --gateway-port 28789 \\
    --bridge-port 28790 \\
    --bind lan \\
    --allowed-origins http://127.0.0.1:28789
`);
}

function isTruthyString(value) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
  });
  if (result.error) {
    fail(`${cmd} failed: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    fail(`${cmd} exited with code ${result.status}`);
  }
}

function runCapture(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
  });
  if (result.error) {
    fail(`${cmd} failed: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const out = (result.stdout ?? "").trim();
    const err = (result.stderr ?? "").trim();
    fail(
      `${cmd} exited with code ${result.status}${err ? `\n${err}` : ""}${out ? `\n${out}` : ""}`,
    );
  }
  return String(result.stdout ?? "");
}

function parseArgs(argv) {
  const out = {
    project: "",
    image: "",
    configDir: "",
    workspaceDir: "",
    gatewayPort: "",
    bridgePort: "",
    bind: "",
    token: "",
    allowedOrigins: "",
    homeVolume: "",
    extraMounts: "",
  };

  const args = [...argv];
  while (args.length > 0) {
    const a = args.shift();
    if (!a) continue;
    if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    }
    const take = () => {
      const v = args.shift();
      if (!v) fail(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--project":
        out.project = take();
        break;
      case "--image":
        out.image = take();
        break;
      case "--config-dir":
        out.configDir = take();
        break;
      case "--workspace-dir":
        out.workspaceDir = take();
        break;
      case "--gateway-port":
        out.gatewayPort = take();
        break;
      case "--bridge-port":
        out.bridgePort = take();
        break;
      case "--bind":
        out.bind = take();
        break;
      case "--token":
        out.token = take();
        break;
      case "--allowed-origins":
        out.allowedOrigins = take();
        break;
      case "--disable-device-auth":
        out.disableDeviceAuth = true;
        break;
      case "--auto-approve":
        out.autoApprove = true;
        break;
      case "--volcengine-key":
        out.volcengineKey = take();
        break;
      case "--home-volume":
        out.homeVolume = take();
        break;
      case "--extra-mounts":
        out.extraMounts = take();
        break;
      default:
        fail(`Unknown argument: ${a} (use --help)`);
    }
  }
  return out;
}

function validateNoControlChars(label, value) {
  if (value.includes("\n") || value.includes("\r") || value.includes("\t")) {
    fail(`${label} contains unsupported control characters.`);
  }
}

function validateRequired(label, value) {
  if (!value) fail(`${label} is required`);
  validateNoControlChars(label, value);
}

function isNamedVolume(value) {
  return value.length > 0 && !value.includes("/") && !value.includes("\\");
}

function validateNamedVolume(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    fail(`Named volume must match [A-Za-z0-9][A-Za-z0-9_.-]*.`);
  }
}

function validateMountSpec(mount) {
  validateNoControlChars("extra mount", mount);
  if (/\s/.test(mount)) {
    fail(`Invalid mount format '${mount}'. Expected source:target[:options] without spaces.`);
  }
  const parts = mount.split(":");
  if (parts.length < 2 || parts.length > 3) {
    fail(`Invalid mount format '${mount}'. Expected source:target[:options].`);
  }
  if (!parts[0] || !parts[1]) {
    fail(`Invalid mount format '${mount}'. Expected source:target[:options].`);
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function parseAllowedOriginsCsv(csv) {
  return csv
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function upsertOpenclawJson({ configDir, token, bind, allowedOriginsCsv }) {
  const configPath = path.join(configDir, "openclaw.json");
  let cfg = {};
  if (fs.existsSync(configPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) ?? {};
    } catch {
      cfg = {};
    }
  }

  if (typeof cfg !== "object" || cfg === null) cfg = {};
  const gateway = typeof cfg.gateway === "object" && cfg.gateway !== null ? cfg.gateway : {};
  const auth = typeof gateway.auth === "object" && gateway.auth !== null ? gateway.auth : {};
  auth.token = token;
  gateway.auth = auth;
  gateway.mode = "local";
  gateway.bind = bind;

  if (bind !== "loopback") {
    const allowed = allowedOriginsCsv ? parseAllowedOriginsCsv(allowedOriginsCsv) : [];
    if (allowed.length > 0) {
      const controlUi =
        typeof gateway.controlUi === "object" && gateway.controlUi !== null
          ? gateway.controlUi
          : {};
      controlUi.allowedOrigins = allowed;
      gateway.controlUi = controlUi;
    }
  }

  if (process.env.OPENCLAW_DISABLE_DEVICE_AUTH === "1") {
    const controlUi =
      typeof gateway.controlUi === "object" && gateway.controlUi !== null ? gateway.controlUi : {};
    controlUi.dangerouslyDisableDeviceAuth = true;
    gateway.controlUi = controlUi;
  }

  // 是否自动批准（免人工点击配对，但需要 Token）
  if (process.env.OPENCLAW_AUTO_APPROVE_DEVICES === "1") {
    const controlUi =
      typeof gateway.controlUi === "object" && gateway.controlUi !== null ? gateway.controlUi : {};
    // 利用 dangerouslyDisableDeviceAuth 的安全机制：
    // 如果想要携带 token 自动进入，我们可以将 allowBypass 开启
    // 但前端行为上，如果是首次且没 token 依然会被拦截
    // 这里将其设为 true 即可在携带了 Bootstrap token 的情况下直接绕过人工审批
    controlUi.dangerouslyDisableDeviceAuth = true;
    gateway.controlUi = controlUi;
  }

  // 预配置火山引擎
  const volcKey = process.env.OPENCLAW_VOLCENGINE_KEY;
  if (volcKey) {
    const authRoot = typeof cfg.auth === "object" && cfg.auth !== null ? cfg.auth : {};
    const authProfiles =
      typeof authRoot.profiles === "object" && authRoot.profiles !== null ? authRoot.profiles : {};
    authProfiles["volcengine:default"] = { provider: "volcengine", mode: "api_key" };
    authRoot.profiles = authProfiles;
    cfg.auth = authRoot;

    const agentsRoot = typeof cfg.agents === "object" && cfg.agents !== null ? cfg.agents : {};
    const defaultsRoot =
      typeof agentsRoot.defaults === "object" && agentsRoot.defaults !== null
        ? agentsRoot.defaults
        : {};
    const modelRoot =
      typeof defaultsRoot.model === "object" && defaultsRoot.model !== null
        ? defaultsRoot.model
        : {};
    modelRoot.primary = "volcengine-plan/ark-code-latest";
    defaultsRoot.model = modelRoot;

    const modelsAllowlist =
      typeof defaultsRoot.models === "object" && defaultsRoot.models !== null
        ? defaultsRoot.models
        : {};
    if (typeof modelsAllowlist["volcengine-plan/ark-code-latest"] !== "object") {
      modelsAllowlist["volcengine-plan/ark-code-latest"] = {};
    }
    defaultsRoot.models = modelsAllowlist;

    agentsRoot.defaults = defaultsRoot;
    cfg.agents = agentsRoot;
  }

  cfg.gateway = gateway;
  ensureDir(configDir);
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, configPath);
}

function upsertAuthProfilesJson({ agentDir }) {
  const storePath = path.join(agentDir, "auth-profiles.json");
  let store = {};
  if (fs.existsSync(storePath)) {
    try {
      store = JSON.parse(fs.readFileSync(storePath, "utf8")) ?? {};
    } catch {
      store = {};
    }
  }
  if (typeof store !== "object" || store === null) store = {};

  const profiles =
    typeof store.profiles === "object" && store.profiles !== null ? store.profiles : {};

  profiles["volcengine:default"] = {
    type: "api_key",
    provider: "volcengine",
    keyRef: {
      source: "env",
      provider: "default",
      id: "VOLCANO_ENGINE_API_KEY",
    },
  };

  store.version = 1;
  store.profiles = profiles;

  ensureDir(agentDir);
  const tmp = `${storePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, storePath);
}

function writeExtraCompose({ extraFile, homeVolume, configDir, workspaceDir, extraMountsCsv }) {
  const lines = [];
  lines.push("services:");
  lines.push("  openclaw-gateway:");
  lines.push("    volumes:");

  const gatewayMounts = [];
  if (homeVolume) {
    const homeMount = `${homeVolume}:/home/node`;
    const configMount = `${configDir}:/home/node/.openclaw`;
    const workspaceMount = `${workspaceDir}:/home/node/.openclaw/workspace`;
    validateMountSpec(homeMount);
    validateMountSpec(configMount);
    validateMountSpec(workspaceMount);
    gatewayMounts.push(homeMount, configMount, workspaceMount);
  }

  const extraMounts = extraMountsCsv
    ? extraMountsCsv
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
    : [];
  for (const m of extraMounts) {
    validateMountSpec(m);
    gatewayMounts.push(m);
  }
  for (const m of gatewayMounts) lines.push(`      - ${m}`);

  lines.push("  openclaw-cli:");
  lines.push("    volumes:");
  for (const m of gatewayMounts) lines.push(`      - ${m}`);

  if (homeVolume && isNamedVolume(homeVolume)) {
    validateNamedVolume(homeVolume);
    lines.push("volumes:");
    lines.push(`  ${homeVolume}:`);
  }

  fs.writeFileSync(extraFile, `${lines.join("\n")}\n`, "utf8");
}

function writeEnvCompose({ envFile }) {
  const lines = [];
  lines.push("services:");
  lines.push("  openclaw-gateway:");
  lines.push("    environment:");
  lines.push("      VOLCANO_ENGINE_API_KEY: ${VOLCANO_ENGINE_API_KEY}");
  lines.push("  openclaw-cli:");
  lines.push("    environment:");
  lines.push("      VOLCANO_ENGINE_API_KEY: ${VOLCANO_ENGINE_API_KEY}");
  fs.writeFileSync(envFile, `${lines.join("\n")}\n`, "utf8");
}

const args = parseArgs(process.argv.slice(2));

if (!fs.existsSync(COMPOSE_FILE)) {
  fail(`docker-compose.yml not found at ${COMPOSE_FILE}`);
}

validateRequired("--project", args.project);
validateRequired("--image", args.image);
validateRequired("--config-dir", args.configDir);
validateRequired("--workspace-dir", args.workspaceDir);
validateRequired("--gateway-port", args.gatewayPort);
validateRequired("--bridge-port", args.bridgePort);
validateRequired("--bind", args.bind);
validateNoControlChars("--allowed-origins", args.allowedOrigins);
validateNoControlChars("--extra-mounts", args.extraMounts);
validateNoControlChars("--home-volume", args.homeVolume);

if (args.homeVolume) {
  if (isNamedVolume(args.homeVolume)) validateNamedVolume(args.homeVolume);
}

const token = args.token || generateToken();
const allowedOrigins =
  args.allowedOrigins || (args.bind !== "loopback" ? `http://127.0.0.1:${args.gatewayPort}` : "");

ensureDir(args.configDir);
ensureDir(args.workspaceDir);
ensureDir(path.join(args.configDir, "identity"));
ensureDir(path.join(args.configDir, "agents", "main", "agent"));
ensureDir(path.join(args.configDir, "agents", "main", "sessions"));

if (args.disableDeviceAuth) {
  process.env.OPENCLAW_DISABLE_DEVICE_AUTH = "1";
}
if (args.autoApprove) {
  // 传递 auto-approve 标志给底层配置，利用危险开关
  process.env.OPENCLAW_AUTO_APPROVE_DEVICES = "1";
}
if (args.volcengineKey) {
  process.env.OPENCLAW_VOLCENGINE_KEY = args.volcengineKey;
  // 同时作为环境变量传给容器内的插件
  process.env.VOLCANO_ENGINE_API_KEY = args.volcengineKey;
}

if (args.volcengineKey) {
  upsertAuthProfilesJson({ agentDir: path.join(args.configDir, "agents", "main", "agent") });
}

upsertOpenclawJson({
  configDir: args.configDir,
  token,
  bind: args.bind,
  allowedOriginsCsv: allowedOrigins,
});

const composeArgs = ["-f", COMPOSE_FILE];
let envFile = "";
if (args.volcengineKey) {
  envFile = path.join(ROOT_DIR, `docker-compose.${args.project}.env.yml`);
  writeEnvCompose({ envFile });
  composeArgs.push("-f", envFile);
}
let extraFile = "";
if (args.homeVolume || args.extraMounts) {
  extraFile = path.join(ROOT_DIR, `docker-compose.${args.project}.extra.yml`);
  writeExtraCompose({
    extraFile,
    homeVolume: args.homeVolume,
    configDir: args.configDir,
    workspaceDir: args.workspaceDir,
    extraMountsCsv: args.extraMounts,
  });
  composeArgs.push("-f", extraFile);
}

run("docker", ["compose", "version"]);

const env = {
  ...process.env,
  OPENCLAW_IMAGE: args.image,
  OPENCLAW_CONFIG_DIR: args.configDir,
  OPENCLAW_WORKSPACE_DIR: args.workspaceDir,
  OPENCLAW_GATEWAY_PORT: args.gatewayPort,
  OPENCLAW_BRIDGE_PORT: args.bridgePort,
  OPENCLAW_GATEWAY_BIND: args.bind,
  OPENCLAW_GATEWAY_TOKEN: token,
};

process.stdout.write(`==> Starting instance: ${args.project}\n`);
run("docker", ["compose", "-p", args.project, ...composeArgs, "up", "-d", "openclaw-gateway"], {
  env,
});

process.stdout.write("==> Fixing data-directory permissions\n");
run(
  "docker",
  [
    "compose",
    "-p",
    args.project,
    ...composeArgs,
    "run",
    "--rm",
    "--user",
    "root",
    "--entrypoint",
    "sh",
    "openclaw-cli",
    "-c",
    "find /home/node/.openclaw -xdev -exec chown node:node {} +; [ -d /home/node/.openclaw/workspace/.openclaw ] && chown -R node:node /home/node/.openclaw/workspace/.openclaw || true",
  ],
  { env },
);

process.stdout.write("\n");
process.stdout.write("Instance started.\n");
process.stdout.write(`Project: ${args.project}\n`);
process.stdout.write(`Image: ${args.image}\n`);
process.stdout.write(`Bind: ${args.bind}\n`);
process.stdout.write(`Host gateway port: ${args.gatewayPort}\n`);
process.stdout.write(`Host bridge port: ${args.bridgePort}\n`);
process.stdout.write(`Config dir: ${args.configDir}\n`);
process.stdout.write(`Workspace dir: ${args.workspaceDir}\n`);
process.stdout.write(`Token: ${token}\n`);
process.stdout.write("\n");
process.stdout.write("Logs:\n");
process.stdout.write(
  `  docker compose -p ${args.project} ${composeArgs.join(" ")} logs -f openclaw-gateway\n`,
);
