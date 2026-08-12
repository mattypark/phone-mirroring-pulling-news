#!/usr/bin/env node
// digest-write.mjs — render a digest to markdown, file it in the vault, clean up.
//
//   node scripts/digest-write.mjs --run runs/2026-08-12T09-00-00Z_x < digest.json
//   cat digest.json | node scripts/digest-write.mjs --notify
//
// Claude produces the JSON (having read the frames or the feed items); this script
// owns the boring, deterministic half: markdown, file naming, the vault path, and
// deleting the frames afterwards. Keeping that out of the model's hands means the
// output is the same shape every day, which is the whole point of a digest.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_VAULT = join(homedir(), "Documents", "ObsidianVault", "Digests");

const USAGE = `digest-write.mjs — write a digest to the vault

  --run <dir>     the run this digest came from; its frames are deleted afterwards
  --keep-frames   keep them anyway (also honoured via KEEP_FRAMES=1)
  --notify        post a macOS notification when the file is written
  --stdout        print the markdown instead of writing anything

Reads the digest as JSON on stdin:
  { profile, date?, headline?, happened[], actionable[], noise?, sources? }
`;

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { run: null, keepFrames: process.env.KEEP_FRAMES === "1", notify: false, stdout: false };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run") options.run = argv[++i];
    else if (argv[i] === "--keep-frames") options.keepFrames = true;
    else if (argv[i] === "--notify") options.notify = true;
    else if (argv[i] === "--stdout") options.stdout = true;
    else if (argv[i] === "-h" || argv[i] === "--help") options.help = true;
    else throw new Error(`unknown argument "${argv[i]}"`);
  }
  return options;
}

async function readStdin() {
  if (process.stdin.isTTY) throw new Error(`nothing on stdin\n\n${USAGE}`);

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();

  if (!raw) throw new Error("stdin was empty — expected the digest as JSON");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`stdin is not valid JSON: ${error.message}`);
  }
}

function validate(digest) {
  const problems = [];
  if (!digest.profile) problems.push('missing "profile"');
  if (!Array.isArray(digest.happened) || digest.happened.length === 0) {
    problems.push('"happened" must be a non-empty array');
  }
  if (digest.actionable && !Array.isArray(digest.actionable)) {
    problems.push('"actionable" must be an array');
  }
  for (const [index, entry] of (digest.happened ?? []).entries()) {
    if (!entry?.headline) problems.push(`happened[${index}] has no headline`);
  }
  if (problems.length > 0) throw new Error(`digest is malformed:\n  - ${problems.join("\n  - ")}`);
}

// ---------------------------------------------------------------------------
// Rendering

const escapePipes = (text) => String(text).replace(/\|/g, "\\|");

function link(entry) {
  const label = entry.source ? escapePipes(entry.source) : "source";
  return entry.url ? ` — [${label}](${entry.url})` : entry.source ? ` — ${label}` : "";
}

function bullets(entries, detailKey) {
  return entries
    .map((entry) => {
      const detail = entry[detailKey] ? `\n  ${entry[detailKey]}` : "";
      const confidence = entry.confidence === "low" ? " *(low confidence)*" : "";
      return `- **${entry.headline}**${confidence}${link(entry)}${detail}`;
    })
    .join("\n");
}

function render(digest, { runStats }) {
  const date = digest.date ?? new Date().toISOString().slice(0, 10);
  const time = new Date().toTimeString().slice(0, 5);
  const actionable = digest.actionable ?? [];

  const frontmatter = [
    "---",
    `date: ${date}`,
    `profile: ${digest.profile}`,
    `generated: ${new Date().toISOString()}`,
    runStats?.frameCount != null ? `frames: ${runStats.frameCount}` : null,
    runStats?.itemCount != null ? `items: ${runStats.itemCount}` : null,
    runStats?.estimatedReadTokens != null ? `read_tokens: ${runStats.estimatedReadTokens}` : null,
    "tags: [digest, feed]",
    "---",
  ].filter(Boolean);

  const body = [
    `# ${date} — ${digest.profile}${digest.headline ? `: ${digest.headline}` : ""}`,
    "",
    `## What happened`,
    "",
    bullets(digest.happened, "detail"),
    "",
    `## What changes what you do`,
    "",
    actionable.length > 0
      ? bullets(actionable, "why")
      : "- Nothing here needs a decision from you today.",
    "",
    `## Skipped as noise`,
    "",
    digest.noise ?? "Nothing worth flagging — the rest was the usual churn.",
    "",
    "---",
    "",
    `<sub>Read at ${time} from ${digest.sources?.join(", ") || digest.profile}` +
      `${runStats?.stopReason ? ` · run ended: ${runStats.stopReason}` : ""}</sub>`,
    "",
  ];

  return [...frontmatter, "", ...body].join("\n");
}

// ---------------------------------------------------------------------------

function runStatsFor(runDir) {
  if (!runDir) return null;

  for (const file of ["manifest.json", "items.json"]) {
    const path = join(runDir, file);
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return {
        frameCount: parsed.frameCount,
        itemCount: parsed.itemCount,
        estimatedReadTokens: parsed.estimatedReadTokens,
        stopReason: parsed.stopReason,
      };
    }
  }
  return null;
}

function notify(title, message) {
  // Best effort: a failed notification must never lose you the digest.
  execFile("/usr/bin/osascript", [
    "-e",
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
  ], () => {});
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`digest: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const digest = await readStdin();
  validate(digest);

  const runDir = options.run ? resolve(options.run) : null;
  const markdown = render(digest, { runStats: runStatsFor(runDir) });

  if (options.stdout) {
    process.stdout.write(markdown);
    return;
  }

  const date = digest.date ?? new Date().toISOString().slice(0, 10);
  const filename = `${date}-${digest.profile}.md`;
  const vaultDir = process.env.VAULT_DIGEST_DIR || DEFAULT_VAULT;

  const written = [];
  for (const directory of [vaultDir, join(ROOT, "digests")]) {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, filename);

    // A second run on the same day appends rather than overwriting the first.
    if (existsSync(path)) {
      const previous = readFileSync(path, "utf8");
      writeFileSync(path, `${previous.trimEnd()}\n\n---\n\n${stripFrontmatter(markdown)}`);
    } else {
      writeFileSync(path, markdown);
    }
    written.push(path);
  }

  if (runDir && !options.keepFrames) {
    rmSync(runDir, { recursive: true, force: true });
  }

  if (options.notify) {
    const count = digest.happened.length + (digest.actionable?.length ?? 0);
    notify(`${digest.profile} digest`, `${count} thing(s) worth knowing · ${date}`);
  }

  console.log(JSON.stringify({
    written,
    framesDeleted: Boolean(runDir) && !options.keepFrames,
    items: digest.happened.length,
    actionable: digest.actionable?.length ?? 0,
  }, null, 2));
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\n[\s\S]*?\n---\n+/, "");
}

main().catch((error) => {
  console.error(`digest: ${error.message}`);
  process.exit(1);
});
