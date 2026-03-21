import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, "..");
const HASH_FILE = path.join(ROOT_DIR, "src", "canvas-host", "a2ui", ".bundle.hash");
const OUTPUT_FILE = path.join(ROOT_DIR, "src", "canvas-host", "a2ui", "a2ui.bundle.js");
const A2UI_RENDERER_DIR = path.join(ROOT_DIR, "vendor", "a2ui", "renderers", "lit");
const A2UI_APP_DIR = path.join(ROOT_DIR, "apps", "shared", "OpenClawKit", "Tools", "CanvasA2UI");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

function normalizePath(p) {
  return p.split(path.sep).join("/");
}

async function walkFiles(entryPath, files) {
  const st = await fs.stat(entryPath);
  if (st.isDirectory()) {
    const entries = await fs.readdir(entryPath);
    for (const entry of entries) {
      await walkFiles(path.join(entryPath, entry), files);
    }
    return;
  }
  files.push(entryPath);
}

async function computeHash(inputPaths) {
  const files = [];
  for (const input of inputPaths) {
    await walkFiles(input, files);
  }

  files.sort((a, b) => normalizePath(a).localeCompare(normalizePath(b)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    const rel = normalizePath(path.relative(ROOT_DIR, filePath));
    hash.update(rel);
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function run(cmd, cmdArgs, options) {
  const shell = process.platform === "win32";
  if (dryRun) {
    process.stdout.write(`[dry-run] ${cmd} ${cmdArgs.join(" ")}\n`);
    return;
  }
  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit", shell, ...options });
  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
  if (result.error) {
    process.stderr.write(String(result.error));
    process.stderr.write("\n");
    process.exit(1);
  }
}

function hasRolldown() {
  const shell = process.platform === "win32";
  const result = spawnSync("rolldown", ["--version"], { stdio: "ignore", shell });
  return typeof result.status === "number" && result.status === 0;
}

async function main() {
  if (!existsSync(A2UI_RENDERER_DIR) || !existsSync(A2UI_APP_DIR)) {
    if (existsSync(OUTPUT_FILE)) {
      process.stdout.write("A2UI sources missing; keeping prebuilt bundle.\n");
      return;
    }
    process.stderr.write(
      `A2UI sources missing and no prebuilt bundle found at: ${OUTPUT_FILE}\n`,
    );
    process.exit(1);
    return;
  }

  const inputPaths = [
    path.join(ROOT_DIR, "package.json"),
    path.join(ROOT_DIR, "pnpm-lock.yaml"),
    A2UI_RENDERER_DIR,
    A2UI_APP_DIR,
  ];

  const currentHash = await computeHash(inputPaths);
  if (existsSync(HASH_FILE) && existsSync(OUTPUT_FILE)) {
    const previousHash = (await fs.readFile(HASH_FILE, "utf8")).trim();
    if (previousHash === currentHash) {
      process.stdout.write("A2UI bundle up to date; skipping.\n");
      return;
    }
  }

  run("pnpm", ["-s", "exec", "tsc", "-p", path.join(A2UI_RENDERER_DIR, "tsconfig.json")]);
  if (hasRolldown()) {
    run("rolldown", ["-c", path.join(A2UI_APP_DIR, "rolldown.config.mjs")]);
  } else {
    run("pnpm", ["-s", "dlx", "rolldown", "-c", path.join(A2UI_APP_DIR, "rolldown.config.mjs")]);
  }

  if (!dryRun) {
    await fs.mkdir(path.dirname(HASH_FILE), { recursive: true });
    await fs.writeFile(HASH_FILE, `${currentHash}\n`, "utf8");
  }
}

main().catch((err) => {
  process.stderr.write("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle\n");
  process.stderr.write("If this persists, verify pnpm deps and try again.\n");
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});

