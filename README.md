# phone-mirroring-pulling-news

Claude Code reads your feeds so you don't have to.

Drives macOS **iPhone Mirroring**, scrolls a feed app, screenshots as it goes, and
hands back a digest: *what happened, what actually matters to you, what was noise.*

Anything with a public feed (Hacker News, RSS, Reddit) is fetched as **text** at
near-zero cost. Mirroring is reserved for closed apps that have no feed — the X app
timeline, Instagram, TikTok.

```
┌──────────────┐   scroll    ┌──────────────────┐  screencapture  ┌────────────┐
│  mirrorctl   │ ──────────► │ iPhone Mirroring │ ───────────────►│  frames/   │
│  (Swift/CGEvent)           │     window       │                 └─────┬──────┘
└──────────────┘             └──────────────────┘                       │
                                                                        ▼
       feeds.mjs (HN / RSS / Reddit, text)  ─────────────►  Claude reads  ─────► digest.md
                                                                        │
                                                          Obsidian vault + push notify
```

---

## What it is not

Honest limits, up front:

- **Not a live stream.** Claude sees sampled still frames, not video. TikTok/IG are
  understood at caption-and-thumbnail level — no audio, no motion.
- **Not unattended.** The iPhone must be **locked, idle, and nearby**; mirroring
  pauses the instant you pick the phone up. The Mac must be awake and unlocked.
- **Not free.** Every frame is a vision-token cost. Downscaling and dedupe keep it
  around **~600 tokens/frame**, so a 60-frame run is ~35k tokens. The feeds path
  costs effectively nothing — prefer it.
- **Not an engagement bot.** It scrolls and reads. There is no like, follow, comment,
  or DM verb anywhere in the profile schema, and `mirrorctl` refuses to post events
  unless iPhone Mirroring is the frontmost window.
- DRM video (Netflix and friends) captures as a black rectangle.

Automating social apps sits outside their terms of service. This is built for one
person reading their own feed at human pace. Keep it that way.

---

## Requirements

| Thing | Why |
|---|---|
| macOS 15+ with iPhone Mirroring | the whole premise (built and tested on macOS 26) |
| iPhone on the same Apple Account, Bluetooth + Wi-Fi on | mirroring handshake |
| `/usr/bin/swift` (Xcode Command Line Tools) | compiles `mirrorctl`, no other install |
| Node 20+ | the capture loop and feed fetchers, zero dependencies |
| Screen Recording permission for your terminal | `screencapture` of the mirror window |
| Accessibility permission for your terminal | posting scroll/tap events |

Grant both under **System Settings → Privacy & Security**. macOS will prompt on first
use; you must restart the terminal afterwards for it to take effect.

## Setup

```sh
git clone https://github.com/mattypark/phone-mirroring-pulling-news.git
cd phone-mirroring-pulling-news
./scripts/build.sh          # swiftc bin/mirrorctl.swift -o bin/mirrorctl
```

## Use

Open iPhone Mirroring, leave the phone face down and locked, then:

```sh
bin/mirrorctl winid                 # preflight: is the mirror window there?
node scripts/capture.mjs --profile x --minutes 5
node scripts/feeds.mjs --profile news
```

Or from Claude Code, which does the reading and the writing too:

```
/doomscroll x 5m
/doomscroll news
/doomscroll all
```

Digests land in `~/Documents/ObsidianVault/Digests/YYYY-MM-DD-<profile>.md`, with a
copy in `digests/`, and a push notification when the run finishes. Set
`VAULT_DIGEST_DIR` to file them somewhere else.

The slash command and skill live in `claude/` — symlink them in:

```sh
ln -s "$PWD/claude/skills/doomscroll" ~/.claude/skills/doomscroll
ln -s "$PWD/claude/commands/doomscroll.md" ~/.claude/commands/doomscroll.md
```

## Layout

```
bin/mirrorctl.swift      window lookup, screenshot, scroll, tap, swipe — the only native code
scripts/build.sh         one-line compile
scripts/capture.mjs      capture loop: shot → downscale → dedupe → scroll → repeat
scripts/feeds.mjs        text path: HN, RSS, Reddit JSON — no mirroring, no vision tokens
scripts/digest-write.mjs markdown out to the vault + notification
scripts/lib/             image fingerprinting, profile validation, XML, a tiny PNG encoder
prompts/                 what the model is told when it reads frames and builds the digest
profiles/*.json          per-app scroll cadence, stop rules, allowed actions
profiles/schema.json     what a profile is allowed to contain
claude/                  the /doomscroll command and skill, for Claude Code
runs/<timestamp>/        frames + manifest.json (gitignored — never leaves the machine)
```

## How the pieces divide

The deterministic half is code: which app, how fast to scroll, when to stop, which
frames are worth keeping, what the markdown looks like, where the file goes. The
judgement half is the model: what a post actually claims, whether it matters, what to
drop. Keeping the line there means the digest has the same shape every day even though
its contents are written fresh — and a bad run fails in an obvious, mechanical way
instead of a plausible-sounding one.

## Privacy

Frames are screenshots of a personal phone. They stay in `runs/`, which is gitignored
and never uploaded anywhere. The capture loop blanks the top strip of every frame so
notification banners don't get recorded, and aborts the run on sight of a login, 2FA,
or payment screen.

A group-chat profile (Discord, Slack, iMessage) is deliberately **not** included —
those frames contain other people's messages and need their own retention rules.
