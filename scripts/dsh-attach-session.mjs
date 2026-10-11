#!/usr/bin/env node
// File headless dsh sessions under their project in the DeepSeek Harness app.
//
// `dsh headless` writes sessions with the right cwd, but only the desktop app's
// own `session.create` calls `attachSession`, so headless sessions show up as
// ungrouped. This script performs the same attach on the app's registry file:
// it validates each session header's cwd against the workspace path, then
// prepends the id to that workspace's `sessionIds` (the order attachSession uses).
//
// Usage: node scripts/dsh-attach-session.mjs <session-id>... [--workspace <dir>]
//   --workspace defaults to the git top-level of the current directory.
//   DSH_HOME overrides ~/.dsh (used for dry runs against a copy).
//
// The app keeps the registry in memory and rewrites the whole file, so this
// refuses to run while DeepSeek Harness is open.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const EXPECTED_UNIT = { name: "workspace", version: 2 };

function fail(message) {
  console.error(`dsh-attach-session: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const ids = [];
  let workspace;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace") workspace = argv[++i];
    else ids.push(argv[i]);
  }
  if (ids.length === 0) fail("usage: dsh-attach-session.mjs <session-id>... [--workspace <dir>]");
  workspace ??= execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  return { ids, workspace: realpathSync(workspace) };
}

function appIsRunning() {
  try {
    execFileSync("pgrep", ["-x", "DeepSeek Harness"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Read the first JSONL line (the session header) from the stored log. */
function readHeader(dshHome, sessionId) {
  const root = join(dshHome, "sessions");
  for (const group of readdirSync(root)) {
    const dir = join(root, group, sessionId);
    if (!existsSync(dir)) continue;
    const log = readdirSync(dir).find((name) => /^session\.v\d+\.jsonl\.zstd$/.test(name));
    if (log === undefined) fail(`${sessionId}: no session log in ${dir}`);
    const text = zstdDecompressSync(readFileSync(join(dir, log))).toString("utf8");
    const header = JSON.parse(text.slice(0, text.indexOf("\n")));
    if (header.type !== "session" || header.id !== sessionId) fail(`${sessionId}: unexpected header in ${log}`);
    return header;
  }
  fail(`${sessionId}: not found under ${root}`);
}

const { ids, workspace } = parseArgs(process.argv.slice(2));
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const registryPath = join(dshHome, "storages", "workspace.json");

if (process.env.DSH_HOME === undefined && appIsRunning()) {
  fail("DeepSeek Harness is running; quit it (Cmd+Q) and run this again, or it will overwrite the change");
}

const registry = JSON.parse(readFileSync(registryPath, "utf8"));
if (registry.unit?.name !== EXPECTED_UNIT.name || registry.unit?.version !== EXPECTED_UNIT.version) {
  fail(`unsupported registry format ${JSON.stringify(registry.unit)}; expected ${JSON.stringify(EXPECTED_UNIT)}. Check the app's attachSession before updating this script`);
}
if (registry.global?.pendingMutation !== undefined) fail("registry has a pending mutation; open and quit the app once, then retry");

const entry = Object.entries(registry.tables.workspaces).find(([, record]) => record.path === workspace);
if (entry === undefined) fail(`no app project for ${workspace}; add the folder in the app once, then retry`);
const [workspaceId, record] = entry;

const owner = new Map();
for (const [id, other] of Object.entries(registry.tables.workspaces)) for (const s of other.sessionIds) owner.set(s, id);

const added = [];
for (const id of ids) {
  if (owner.get(id) === workspaceId) {
    console.log(`${id}: already in "${record.title}"`);
    continue;
  }
  if (owner.has(id)) fail(`${id}: already filed under another project (${owner.get(id)})`);
  const header = readHeader(dshHome, id);
  if (realpathSync(header.cwd) !== workspace) fail(`${id}: cwd ${header.cwd} does not match ${workspace}`);
  added.push({ id, createdAt: header.createdAt });
}
if (added.length === 0) process.exit(0);

// Same order as the app's attachSession: newest first.
added.sort((a, b) => b.createdAt - a.createdAt);
record.sessionIds = [...added.map((a) => a.id), ...record.sessionIds];
record.updatedAt = new Date().toISOString();

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
copyFileSync(registryPath, `${registryPath}.bak-${stamp}`);
const tmp = `${registryPath}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(registry, null, 2));
renameSync(tmp, registryPath);
for (const { id } of added) console.log(`${id}: filed under "${record.title}"`);
console.log(`backup: workspace.json.bak-${stamp}`);
