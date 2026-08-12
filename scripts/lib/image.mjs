// Image work, done entirely with `sips` — which ships with macOS — so the project
// stays dependency-free.
//
// Two jobs:
//   thumbnail() shrinks a frame before Claude reads it. A 640px JPEG costs roughly a
//   sixth of what the full retina screenshot would, and nothing in a feed post is
//   legible at 2560px but illegible at 640px.
//
//   fingerprint() reduces a frame to an 8x8 average hash, used to drop near-identical
//   frames (the feed didn't move) and to spot blank ones (DRM surface, dropped session).

import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function sips(args) {
  try {
    return await execFileAsync("/usr/bin/sips", args, { maxBuffer: 1 << 22 });
  } catch (error) {
    throw new Error(`sips failed: ${error.stderr?.trim() || error.message}`);
  }
}

/** Downscale to `width` and re-encode as JPEG. Returns the destination path. */
export async function thumbnail(source, destination, { width = 640, quality = 60 } = {}) {
  // Never upscale — that would spend tokens on invented pixels.
  const { width: sourceWidth } = await dimensions(source);
  const resample = sourceWidth > width ? ["--resampleWidth", String(width)] : [];

  await sips([
    ...resample,
    "-s", "format", "jpeg",
    "-s", "formatOptions", String(quality),
    source, "--out", destination,
  ]);
  return destination;
}

/** Pixel dimensions of an image, as reported by sips. */
export async function dimensions(path) {
  const { stdout } = await sips(["-g", "pixelWidth", "-g", "pixelHeight", path]);
  const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return { width, height };
}

const HASH_SIDE = 8;

/**
 * 8x8 average hash plus brightness statistics.
 * @returns {Promise<{hash: string, mean: number, spread: number}>}
 *   hash   16 hex chars, comparable with hamming()
 *   mean   average luminance 0-255
 *   spread max minus min luminance — near zero means a flat, contentless frame
 */
export async function fingerprint(path) {
  const scratch = join(tmpdir(), `pmpn-hash-${process.pid}-${Date.now()}.bmp`);

  try {
    await sips([
      "-s", "format", "bmp",
      "--resampleHeightWidth", String(HASH_SIDE), String(HASH_SIDE),
      path, "--out", scratch,
    ]);
    return hashBitmap(readFileSync(scratch));
  } finally {
    rmSync(scratch, { force: true });
  }
}

/** Parse an uncompressed 24-bit BMP and reduce it to an average hash. */
function hashBitmap(buffer) {
  if (buffer.length < 54 || buffer[0] !== 0x42 || buffer[1] !== 0x4d) {
    throw new Error("expected an uncompressed BMP from sips");
  }

  const pixelOffset = buffer.readUInt32LE(10);
  const width = buffer.readInt32LE(18);
  const rawHeight = buffer.readInt32LE(22);
  const bitsPerPixel = buffer.readUInt16LE(28);

  if (bitsPerPixel !== 24) throw new Error(`expected 24bpp BMP, got ${bitsPerPixel}`);

  // A negative height means the rows are stored top-down, which is what sips emits.
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const rowStride = Math.ceil((width * 3) / 4) * 4;

  const luminance = [];
  for (let row = 0; row < height; row++) {
    const sourceRow = topDown ? row : height - 1 - row;
    const rowStart = pixelOffset + sourceRow * rowStride;

    for (let column = 0; column < width; column++) {
      const i = rowStart + column * 3;
      const blue = buffer[i];
      const green = buffer[i + 1];
      const red = buffer[i + 2];
      luminance.push(0.299 * red + 0.587 * green + 0.114 * blue);
    }
  }

  const mean = luminance.reduce((sum, value) => sum + value, 0) / luminance.length;
  const spread = Math.max(...luminance) - Math.min(...luminance);

  let hash = "";
  for (let nibble = 0; nibble < luminance.length; nibble += 4) {
    let bits = 0;
    for (let bit = 0; bit < 4; bit++) {
      bits = (bits << 1) | (luminance[nibble + bit] > mean ? 1 : 0);
    }
    hash += bits.toString(16);
  }

  return { hash, mean: Math.round(mean), spread: Math.round(spread) };
}

/** Number of differing bits between two hashes from fingerprint(). */
export function hamming(a, b) {
  if (a.length !== b.length) throw new Error("hashes must be the same length");

  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let difference = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (difference) {
      distance += difference & 1;
      difference >>= 1;
    }
  }
  return distance;
}
