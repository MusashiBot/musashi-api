# Labeling Rubric

Human labels are only useful if they are consistent. Use this rubric for every
tweet in `tweets.jsonl`. Labels are always relative to the **paired market**,
not the tweet in isolation.

Run the labeling tool with:

```bash
pnpm run label
```

## Relevance (`is_relevant`)

- **yes**: The tweet directly addresses the market outcome, the underlying
  subject, or an event that would plausibly affect the outcome. A directional
  view is not required — a neutral factual statement about the subject still
  counts as relevant.
- **no**: The tweet mentions a keyword that caused retrieval but is not
  actually about the market or its subject. Example: a tweet that mentions
  "Bitcoin" in an unrelated context when the market is about Bitcoin's price.

Relevance is independent of sentiment. A tweet can be relevant and neutral, or
irrelevant and apparently bullish. Assign sentiment to all tweets; only
relevant tweets are used when computing matcher recall.

## Sentiment (`sentiment_label`)

- **bullish**: Belief, prediction, or observation that the market resolves
  `yes` (or favorably). Includes confident assertions, optimism, and strong
  endorsements.
- **bearish**: Belief, prediction, or observation that the market resolves
  `no` (or unfavorably). Includes skepticism, predicted failure, and negative
  sentiment about the subject.
- **neutral**: Factual with no directional signal, uncertain, off-topic, or
  ambiguous. When in doubt, label neutral.

## Labeler confidence (`label_confidence`)

- **high**: Unambiguous. Another labeler would almost certainly agree.
- **medium**: Discernible signal but needs interpretation (hedges, mild
  language, mixed signals, market context required).
- **low**: Best guess (irony, slang, highly ambiguous, only tangential).
  Another labeler might disagree. Low-confidence tweets may be excluded from
  primary evaluation or analyzed separately.

## Rules

1. Label the tweet content, not whether it turned out correct. "Bitcoin will
   hit $100k" is bullish regardless of the eventual market outcome.
2. Sarcasm → **neutral**.
3. If a tweet could apply to multiple markets, label only with respect to the
   paired `market_id`.
4. Do not change collection fields (`collection_query`, `matcher_result`,
   etc.). Only fill label fields.
