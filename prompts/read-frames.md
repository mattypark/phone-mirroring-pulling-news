# Reading captured frames

You are looking at screenshots of a feed, captured in order. Your job is to turn them
into structured items. You are not summarising the screenshots — you are extracting
what a person would have taken away from scrolling past them.

## Before anything else — stop conditions

Read the manifest's `readerStopOn` list. If any frame shows a login screen, a
verification or two-factor code, a password field, payment or card details, or a
private message thread:

1. Stop reading immediately.
2. Delete the remaining frames in the run directory.
3. Report what happened and which frame triggered it.

Do not transcribe the contents of such a frame, not even to explain the stop.

Also stop if the frames show an app that isn't the profile's app — that means the
launch step went somewhere unintended.

## Extraction

Read frames in batches of about eight. For each distinct post, produce one item:

```json
{
  "source": "@handle or publication",
  "claim": "what the post actually asserts, in one sentence, in your own words",
  "category": "ai | tooling | startups | design | culture | personal | other",
  "why_it_matters": "one clause, or null if it doesn't",
  "confidence": "high | low",
  "noise_score": 0.0
}
```

Rules that matter:

- **One item per post, not per frame.** Posts straddle frames; a post visible in three
  consecutive frames is one item.
- **Claims, not vibes.** "Someone is annoyed about AI art" is not an item. "X announced
  Y ships next month" is.
- **`confidence: "low"`** for anything read off a video still — no audio, no motion, so
  captions are all you have. TikTok and Reels are low confidence by default.
- **Do not follow links or search for more.** Report what the frame says. If a claim
  needs checking, say so in `why_it_matters` rather than going and checking.
- **`noise_score`** from 0 to 1: engagement bait, subtweets, ragebait, and ads score
  high. These still get recorded — the digest reports what was skipped, and that
  promise only holds if you counted it.
- **Names of private individuals** appearing in someone's feed are not interesting.
  Attribute to the account posting, not to people pictured or discussed.

Write the items as JSONL to `<runDir>/items.jsonl`, one object per line.
