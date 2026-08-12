#!/usr/bin/env node
// capture.mjs — scroll a feed inside iPhone Mirroring and keep the frames worth reading.
//
//   node scripts/capture.mjs --profile x --minutes 5
//   node scripts/capture.mjs --profile x --dry-run     # no phone, synthetic frames
//
// Writes runs/<timestamp>/frame-###.jpg plus manifest.json, and prints a JSON summary
// on stdout for whoever called it (usually Claude, which then reads the frames).
//
// The loop stops early rather than grinding on: identical frames mean the phone got
// picked up or the feed ended, blank frames mean a DRM surface or a dropped session.

import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { fingerprint, hamming, thumbnail } from "./lib/image.mjs";
import { encodePng } from "./lib/png.mjs";
import { listProfiles, loadProfile } from "./lib/profile.mjs";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIRRORCTL = join(ROOT, "bin", "mirrorctl");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (n) => String(n).padStart(3, "0");

// A frame this flat has no content — a black DRM surface, or a disconnected session.
const BLANK_SPREAD = 8;

// ---------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const options = { profile: null, minutes: null, frames: null, dryRun: false, launch: true };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") options.profile = argv[++i];
    else if (arg === "--minutes") options.minutes = Number(argv[++i]);
    else if (arg === "--frames") options.frames = Number(argv[++i]);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-launch") options.launch = false;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  return options;
}

const USAGE = `capture.mjs — scroll a feed in iPhone Mirroring and save readable frames

  --profile <name>   which profile to run (${listProfiles().join(", ") || "none yet"})
  --minutes <n>      override the profile's wall-clock limit
  --frames <n>       override the profile's frame limit
  --no-launch        assume the app is already open, skip the Spotlight launch
  --dry-run          synthesise frames instead of touching the phone
`;

// ---------------------------------------------------------------------------
// Backends: the real mirror, and a stub that needs no phone

async function mirrorctl(...args) {
  const { stdout } = await execFileAsync(MIRRORCTL, args, { maxBuffer: 1 << 20 });
  return stdout.trim();
}

const mirrorBackend = {
  async preflight() {
    const id = await mirrorctl("winid");
    await mirrorctl("focus");
    return { windowId: Number(id) };
  },

  /** Home screen → pull down for Search → type the app name → open it. */
  async launch(profile) {
    await mirrorctl("home");
    await sleep(600);
    await mirrorctl("swipe", "0.5", "0.14", "0.5", "0.62", "--ms", "320");
    await sleep(700);
    await mirrorctl("type", profile.app);
    await sleep(500);
    await mirrorctl("key", "return");
  },

  shot(path, profile) {
    return mirrorctl("shot", path, "--strip", String(profile.capture.bannerStripPx));
  },

  scroll(profile) {
    return mirrorctl("scroll", String(profile.capture.scrollTicks));
  },
};

/**
 * Synthetic feed. Frames drift, repeat every fifth step (so dedupe has something to
 * drop), and freeze near the end (so the stuck-frame abort gets exercised).
 */
function stubBackend() {
  let step = 0;

  return {
    async preflight() {
      return { windowId: 0, stub: true };
    },
    async launch() {},
    async shot(path) {
      const frozen = step > 14 ? 14 : step;
      const phase = frozen % 5 === 4 ? frozen - 1 : frozen; // every 5th frame repeats
      writeFileSync(
        path,
        encodePng(360, 780, (x, y) => {
          const band = Math.floor((y + phase * 90) / 130) % 3;
          const noise = (x * 7 + y * 13 + phase * 31) % 40;
          return band === 0 ? [230 - noise, 232 - noise, 238 - noise]
               : band === 1 ? [30 + noise, 32 + noise, 40 + noise]
               : [90 + noise, 120 + noise, 200 - noise];
        }),
      );
      return path;
    },
    async scroll() {
      step++;
    },
  };
}

// ---------------------------------------------------------------------------
// The loop

async function capture(profile, options) {
  const backend = options.dryRun ? stubBackend() : mirrorBackend;
  const settings = profile.capture;

  const maxFrames = options.frames ?? settings.maxFrames;
  const maxMinutes = options.minutes ?? settings.maxMinutes;
  const dedupe = settings.dedupe ?? { hammingThreshold: 6, lookback: 3 };

  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const runDir = join(ROOT, "runs", `${runId}_${profile.name}`);
  mkdirSync(runDir, { recursive: true });

  const context = await backend.preflight();
  if (options.launch) {
    await backend.launch(profile);
    await sleep(settings.settleMs ?? 1200);
  }

  const frames = [];
  const recentHashes = [];
  let stuckStreak = 0;
  let blankStreak = 0;
  let duplicates = 0;
  let stopReason = "reached frame limit";
  const deadline = startedAt.getTime() + maxMinutes * 60_000;

  for (let index = 0; frames.length < maxFrames; index++) {
    if (Date.now() > deadline) {
      stopReason = "reached time limit";
      break;
    }

    const rawPath = join(runDir, `raw-${pad(index)}.png`);
    try {
      await backend.shot(rawPath, profile);
    } catch (error) {
      stopReason = `capture failed: ${firstLine(error)}`;
      break;
    }

    const print = await fingerprint(rawPath);

    if (print.spread < BLANK_SPREAD) {
      rmSync(rawPath, { force: true });
      if (++blankStreak >= (profile.abort.blankFrames ?? 3)) {
        stopReason = "blank frames — DRM surface, or the mirror session dropped";
        break;
      }
      await advance(backend, profile);
      continue;
    }
    blankStreak = 0;

    const closest = recentHashes.reduce(
      (best, hash) => Math.min(best, hamming(hash, print.hash)),
      Number.POSITIVE_INFINITY,
    );

    if (closest <= dedupe.hammingThreshold) {
      rmSync(rawPath, { force: true });
      duplicates++;
      if (++stuckStreak >= profile.abort.stuckFrames) {
        stopReason = "feed stopped moving — phone picked up, or you reached the end";
        break;
      }
      await advance(backend, profile);
      continue;
    }

    stuckStreak = 0;
    recentHashes.push(print.hash);
    if (recentHashes.length > dedupe.lookback) recentHashes.shift();

    const framePath = join(runDir, `frame-${pad(frames.length)}.jpg`);
    await thumbnail(rawPath, framePath, {
      width: settings.downscaleWidth ?? 640,
      quality: settings.jpegQuality ?? 60,
    });
    rmSync(rawPath, { force: true });

    frames.push({
      file: `frame-${pad(frames.length)}.jpg`,
      capturedAt: new Date().toISOString(),
      hash: print.hash,
      meanLuma: print.mean,
    });

    await advance(backend, profile);
  }

  const manifest = {
    profile: profile.name,
    app: profile.app,
    interests: profile.interests ?? [],
    readerStopOn: profile.abort.readerStopOn ?? [],
    dryRun: Boolean(options.dryRun),
    windowId: context.windowId,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    stopReason,
    frameCount: frames.length,
    duplicatesDropped: duplicates,
    estimatedReadTokens: estimateTokens(frames.length, settings.downscaleWidth ?? 640),
    frames,
  };

  writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { runDir, manifest };
}

async function advance(backend, profile) {
  await backend.scroll(profile);
  await sleep(profile.capture.dwellMs);
}

/** Rough vision cost: a w x 2.2w JPEG is about (w * 2.2w) / 750 tokens. */
function estimateTokens(frameCount, width) {
  return Math.round((frameCount * width * width * 2.2) / 750);
}

function firstLine(error) {
  return String(error.stderr || error.message).trim().split("\n")[0];
}

// ---------------------------------------------------------------------------

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`capture: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (options.help || !options.profile) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 2);
  }

  const profile = loadProfile(options.profile);
  if (profile.kind === "feed") {
    throw new Error(`"${profile.name}" is a text feed — run scripts/feeds.mjs instead`);
  }

  const { runDir, manifest } = await capture(profile, options);
  console.log(JSON.stringify({ runDir, ...manifest, frames: undefined }, null, 2));
  console.error(
    `\ncaptured ${manifest.frameCount} frame(s), dropped ${manifest.duplicatesDropped} repeat(s)` +
      `\nstopped because: ${manifest.stopReason}` +
      `\n~${manifest.estimatedReadTokens.toLocaleString()} tokens to read` +
      `\n${runDir}\n`,
  );
}

main().catch((error) => {
  console.error(`capture: ${error.message}`);
  process.exit(1);
});
