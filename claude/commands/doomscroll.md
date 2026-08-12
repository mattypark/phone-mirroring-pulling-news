---
description: Read my feeds for me — scroll X/Instagram/TikTok over iPhone Mirroring, or pull text feeds (HN/RSS/Reddit), then write a digest to the vault.
argument-hint: "[news|x|instagram|tiktok|all] [5m]"
---

# /doomscroll

Load the **doomscroll** skill (`~/.claude/skills/doomscroll/SKILL.md`) and follow it.

Arguments passed: `$ARGUMENTS`

- no argument, or `news` → text feeds only. No phone, no screenshots, no vision tokens.
- `x` | `instagram` | `tiktok` → mirror run. Preflight first; if the phone isn't ready,
  say which condition failed and stop rather than retrying.
- `all` → `news` first, then `x`.
- A trailing duration (`5m`) overrides the profile's `maxMinutes`.

Project lives at `~/Downloads/current-projects/phone-mirroring-pulling-news`.

Finish by writing the digest through `scripts/digest-write.mjs` and sending a push
notification with the headline count. Report the actual token cost of the run — the
point of this tool is that it is cheaper than scrolling, so the number should be
visible, not assumed.
