---
name: doomscroll
description: "Read Matthew's feeds for him — drives macOS iPhone Mirroring to scroll X/Instagram/TikTok, or fetches text feeds (HN/RSS/Reddit), then writes a digest to the Obsidian vault. Use when he asks what happened today, what he missed, to catch up on a feed, or to check the news without scrolling."
---

# doomscroll

Project: `~/Downloads/current-projects/phone-mirroring-pulling-news`
(`mattypark/phone-mirroring-pulling-news`).

Turns a feed into a digest: **what happened**, **what changes what you do**, **what was
skipped as noise**. Filed to `~/Documents/ObsidianVault/Digests/`.

## Pick the cheap path first

| Ask | Run |
|---|---|
| "what's the news", "anything happen today" | `feeds.mjs --profile news` — text only, ~no token cost |
| "what did I miss on X / Instagram / TikTok" | `capture.mjs --profile <name>` — needs the phone |
| "catch me up on everything" | feeds first, then one mirror profile |

Never reach for mirroring when a public feed would answer the question.

## Mirror runs

```sh
cd ~/Downloads/current-projects/phone-mirroring-pulling-news
./scripts/build.sh                       # once, or after editing mirrorctl.swift
bin/mirrorctl winid                      # preflight — exits 1 with the reason if not ready
node scripts/capture.mjs --profile x --minutes 5
```

**Preflight, in order.** If `winid` fails, do not retry in a loop — report which
condition is unmet and stop:

1. iPhone Mirroring open on the Mac.
2. iPhone locked, idle, nearby. It pauses the instant he picks it up.
3. Screen Recording + Accessibility granted to the terminal (a restart is needed after
   granting; `shot` failing with "wrote nothing" means this).

Tell him the cursor will move during the run and the run is roughly `maxMinutes` long,
so he isn't surprised by his own machine.

## Reading and writing

1. Follow `prompts/read-frames.md` — read `runs/<id>/frame-*.jpg` in batches of ~8,
   write `items.jsonl`.
2. Follow `prompts/build-digest.md` — emit the digest JSON.
3. Pipe it: `node scripts/digest-write.mjs --run runs/<id> --notify`.
4. Send a `PushNotification` with the headline count.

The stop rules in `read-frames.md` are not optional. Login, 2FA, password, payment, or
a private message thread: stop, delete the remaining frames, say which frame did it,
don't transcribe it.

## Profiles

`x` · `instagram` · `tiktok` are mirror profiles; `news` is text. Cadence, limits and
abort rules live in `profiles/*.json`, validated against `profiles/schema.json`. The
`actions` enum is `scroll | home | tap:navOnly` — there is deliberately no way to
express liking, following, commenting, or messaging. Don't add one.

TikTok and Reels are read from stills: no audio, no motion. Everything from them is low
confidence and must say so in the digest.

## When it goes wrong

| Symptom | Cause |
|---|---|
| `no iPhone Mirroring window found` | app closed, or phone in use |
| run stops with "feed stopped moving" | phone picked up, or genuinely the end of the feed |
| run stops with "blank frames" | DRM surface, or the session dropped |
| `screencapture wrote nothing` | Screen Recording permission, terminal needs a restart |
| frames show the wrong app | Spotlight launch missed — rerun with the app already open and `--no-launch` |

Two failed attempts is the limit. Report what happened and ask rather than grinding.

## Not in scope

Group chats, Discord, Slack. Those frames contain other people's messages and need
their own retention rules — a separate profile, and its own conversation first.
