# Building the digest

Input: the items extracted from frames (`items.jsonl`) and/or the text feed output
(`items.json`), plus the profile's `interests`.

Output: one JSON object on stdout, piped into `scripts/digest-write.mjs`, which owns
the markdown and the filing. Emit JSON and nothing else.

```json
{
  "profile": "x",
  "date": "2026-08-12",
  "headline": "optional five-word framing of the day",
  "happened": [
    { "headline": "…", "detail": "…", "source": "@who", "url": "https://…", "confidence": "low" }
  ],
  "actionable": [
    { "headline": "…", "why": "why this changes what he does this week", "source": "…", "url": "https://…" }
  ],
  "noise": "one sentence on what was skipped and why",
  "sources": ["x", "hn", "r/technology"]
}
```

## What earns a slot

**`happened` — 5 to 7 entries.** The things that would have been worth seeing. Merge
duplicates across sources: one entry, best link, the rest folded into the detail. Rank
by consequence, not by engagement — a quiet API change can outrank a viral thread.

**`actionable` — 0 to 3 entries.** Only what changes a decision, a plan, or a piece of
work this week. A model release he already uses is actionable; a model release from a
lab he doesn't touch is just `happened`. If nothing qualifies, return an empty array
and let the digest say so. Padding this section is the fastest way to make the whole
thing untrustworthy.

**`noise` — one sentence.** Count what you dropped, characterise it, don't itemise it.
"Roughly 30 posts of engagement bait, three ads, and a running argument about a TV
show." The point is to prove the sweep was complete, so he doesn't feel the need to go
scroll it himself.

## Rules

- **Never invent a link.** No URL is better than a guessed one. Frames rarely show full
  URLs — leave `url` off and name the account in `source`.
- **Carry confidence through.** Anything marked low confidence at extraction stays low
  confidence here, and says why in the detail ("read off a video still").
- **Own the gaps.** If the run aborted early, or a feed source failed, say so in
  `noise` — a digest that hides its own holes is worse than no digest.
- **His voice, not the feed's.** Strip the hype register. If a post says "INSANE new
  model DESTROYS the competition", the headline is what shipped and what changed.
- **Nothing about private individuals.** Public accounts and publications only.
