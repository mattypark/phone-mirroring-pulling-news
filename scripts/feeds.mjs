#!/usr/bin/env node
// feeds.mjs — the cheap half of this project.
//
//   node scripts/feeds.mjs --profile news
//
// Anything with a public feed is read as text: no phone, no screenshots, no vision
// tokens. Run this first and only reach for iPhone Mirroring for the apps that have
// no feed at all. Output is the same item shape the frame reader produces, so the
// digest step can merge the two without caring where an item came from.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { attributeOf, feedEntries, firstChild, textOf } from "./lib/xml.mjs";
import { listProfiles, loadProfile } from "./lib/profile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USER_AGENT = process.env.FEEDS_USER_AGENT
  || "phone-mirroring-pulling-news/0.1 (personal reader)";
const TIMEOUT_MS = 12_000;
const SUMMARY_LIMIT = 400;

const USAGE = `feeds.mjs — read text feeds, no phone involved

  --profile <name>   a profile with kind "feed" (${listProfiles().join(", ") || "none yet"})
  --limit <n>        cap items per source, overriding the profile
`;

// ---------------------------------------------------------------------------
// Fetching

async function getText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "*/*" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

const getJson = async (url) => JSON.parse(await getText(url));

// ---------------------------------------------------------------------------
// Parsers — exported so they can be tested against fixtures without network access

const clip = (text) =>
  text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…` : text;

/** RSS 2.0 and Atom look different enough to matter, and similar enough to share code. */
export function parseFeed(xml, { source, limit }) {
  return feedEntries(xml)
    .slice(0, limit)
    .map((entry) => {
      const link = textOf(firstChild(entry, "link") ?? "") || attributeOf(entry, "link", "href");
      const body = firstChild(entry, "description", "summary", "content") ?? "";

      return {
        source,
        title: textOf(firstChild(entry, "title") ?? ""),
        url: link,
        author: textOf(firstChild(entry, "dc:creator", "author", "name") ?? "") || null,
        publishedAt: textOf(firstChild(entry, "pubDate", "published", "updated") ?? "") || null,
        score: null,
        comments: null,
        summary: clip(textOf(body)),
      };
    })
    .filter((item) => item.title);
}

export function parseRedditListing(payload, { source, limit }) {
  return (payload?.data?.children ?? [])
    .slice(0, limit)
    .map(({ data }) => ({
      source,
      title: data.title,
      url: data.url_overridden_by_dest || `https://reddit.com${data.permalink}`,
      author: data.author ? `u/${data.author}` : null,
      publishedAt: data.created_utc ? new Date(data.created_utc * 1000).toISOString() : null,
      score: data.score ?? null,
      comments: data.num_comments ?? null,
      summary: clip(textOf(data.selftext ?? "")),
    }))
    .filter((item) => item.title);
}

export function normaliseHnStory(story, { source }) {
  return {
    source,
    title: story.title,
    url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
    author: story.by ? `@${story.by}` : null,
    publishedAt: story.time ? new Date(story.time * 1000).toISOString() : null,
    score: story.score ?? null,
    comments: story.descendants ?? null,
    summary: story.url ? `discussion: https://news.ycombinator.com/item?id=${story.id}` : "",
  };
}

// ---------------------------------------------------------------------------
// Sources

async function readSource(source, overrideLimit) {
  const limit = overrideLimit ?? source.limit ?? 15;

  switch (source.type) {
    case "rss":
    case "atom":
      return parseFeed(await getText(source.url), { source: source.id, limit });

    case "reddit-json":
      return parseRedditListing(await getJson(source.url), { source: source.id, limit });

    case "hn": {
      const ids = (await getJson(source.url)).slice(0, limit);
      const stories = await Promise.all(
        ids.map((id) => getJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)),
      );
      return stories.filter(Boolean).map((story) => normaliseHnStory(story, { source: source.id }));
    }

    case "json": {
      const payload = await getJson(source.url);
      const rows = Array.isArray(payload) ? payload : payload.items ?? [];
      return rows.slice(0, limit).map((row) => ({
        source: source.id,
        title: row.title ?? row.name ?? "",
        url: row.url ?? row.link ?? "",
        author: row.author ?? null,
        publishedAt: row.date_published ?? row.published ?? null,
        score: null,
        comments: null,
        summary: clip(textOf(String(row.summary ?? row.content_text ?? ""))),
      })).filter((item) => item.title);
    }

    default:
      throw new Error(`unsupported source type "${source.type}"`);
  }
}

/** The same story shows up on three sources; keep the one with the most signal. */
export function dedupe(items) {
  const seen = new Map();

  for (const item of items) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    const existing = seen.get(key);
    if (!existing || (item.score ?? 0) > (existing.score ?? 0)) {
      seen.set(key, existing ? { ...item, alsoOn: [...(existing.alsoOn ?? []), existing.source] } : item);
    } else {
      existing.alsoOn = [...(existing.alsoOn ?? []), item.source];
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { profile: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") options.profile = argv[++i];
    else if (argv[i] === "--limit") options.limit = Number(argv[++i]);
    else if (argv[i] === "-h" || argv[i] === "--help") options.help = true;
    else throw new Error(`unknown argument "${argv[i]}"`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`feeds: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (options.help || !options.profile) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 2);
  }

  const profile = loadProfile(options.profile);
  if (profile.kind !== "feed") {
    throw new Error(`"${profile.name}" is a mirror profile — run scripts/capture.mjs instead`);
  }

  const startedAt = new Date();
  const results = await Promise.all(
    profile.sources.map(async (source) => {
      try {
        return { id: source.id, items: await readSource(source, options.limit) };
      } catch (error) {
        // One dead feed shouldn't cost you the other four.
        return { id: source.id, items: [], error: error.message };
      }
    }),
  );

  const items = dedupe(results.flatMap((result) => result.items));
  const runDir = join(ROOT, "runs", `${startedAt.toISOString().replace(/[:.]/g, "-")}_${profile.name}`);
  mkdirSync(runDir, { recursive: true });

  const manifest = {
    profile: profile.name,
    kind: "feed",
    interests: profile.interests ?? [],
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    sources: results.map(({ id, items: sourceItems, error }) => ({
      id, count: sourceItems.length, error: error ?? null,
    })),
    itemCount: items.length,
    items,
  };

  writeFileSync(join(runDir, "items.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ runDir, ...manifest, items: undefined }, null, 2));

  const failed = manifest.sources.filter((source) => source.error);
  console.error(
    `\n${items.length} item(s) from ${results.length - failed.length}/${results.length} source(s)` +
      failed.map((source) => `\n  ! ${source.id}: ${source.error}`).join("") +
      `\n${runDir}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`feeds: ${error.message}`);
    process.exit(1);
  });
}
