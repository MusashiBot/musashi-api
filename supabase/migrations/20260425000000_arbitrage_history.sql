-- Arbitrage history schema
-- Tracks every cross-platform arbitrage opportunity the system detects.
--
-- Two-table design:
--
--   arbitrage_opportunities  — one row per unique (polymarket_id, kalshi_id) pair.
--                              Think of this as the "session" for a persistent opportunity.
--
--   arbitrage_snapshots      — one row per scan that detected the pair above the threshold.
--                              Think of this as the time-series events within that session.
--
-- Why separate tables?
--   • "How many unique pairs have ever shown arbitrage?" → count arbitrage_opportunities
--   • "How did the spread evolve while this pair was live?" → query arbitrage_snapshots
--   • "Which opportunities lasted the longest?" → last_seen_at - first_seen_at on opportunities

-- ---------------------------------------------------------------------------
-- 1. arbitrage_opportunities
--    One row per unique (polymarket_id, kalshi_id) pair.
--    Updated in-place every scan via ON CONFLICT DO UPDATE.
-- ---------------------------------------------------------------------------

create table if not exists public.arbitrage_opportunities (
  id                   uuid        primary key default gen_random_uuid(),

  -- Stable identifiers for the pair
  polymarket_id        text        not null,
  kalshi_id            text        not null,

  -- Human-readable market names (captured at first detection)
  polymarket_title     text        not null,
  kalshi_title         text        not null,
  category             text,

  -- Why the matcher thinks these are the same event
  match_reason         text,

  -- Running statistics
  max_spread           numeric(6,4) not null,          -- highest spread ever seen for this pair
  observation_count    integer      not null default 1, -- how many scans caught this pair

  -- Lifecycle
  first_seen_at        timestamptz  not null default now(),
  last_seen_at         timestamptz  not null default now(),
  closed_at            timestamptz,                     -- null while active
  status               text         not null default 'active'
    check (status in ('active', 'closed')),

  created_at           timestamptz  not null default now(),

  -- Enforce one row per market pair
  unique (polymarket_id, kalshi_id)
);

-- Index: fast lookup of active opportunities + ordering by time
create index if not exists idx_arb_opp_status_last_seen
  on public.arbitrage_opportunities (status, last_seen_at desc);

-- Index: category filter on the history endpoint
create index if not exists idx_arb_opp_category
  on public.arbitrage_opportunities (category)
  where category is not null;

-- Index: find wide-spread opportunities quickly
create index if not exists idx_arb_opp_max_spread
  on public.arbitrage_opportunities (max_spread desc);


-- ---------------------------------------------------------------------------
-- 2. arbitrage_snapshots
--    One row per scan observation.  Never updated — append-only.
-- ---------------------------------------------------------------------------

create table if not exists public.arbitrage_snapshots (
  id                   uuid        primary key default gen_random_uuid(),
  opportunity_id       uuid        not null
    references public.arbitrage_opportunities (id) on delete cascade,

  -- Exact prices at this moment
  polymarket_yes_price numeric(6,4) not null,
  kalshi_yes_price     numeric(6,4) not null,
  spread               numeric(6,4) not null,
  profit_potential     numeric(8,6) not null,

  -- Which platform was cheaper at this snapshot
  direction            text        not null
    check (direction in ('buy_poly_sell_kalshi', 'buy_kalshi_sell_poly')),

  -- Match confidence at this snapshot (may drift as title matching improves)
  confidence           numeric(4,3) not null,

  -- Liquidity context
  polymarket_volume_24h numeric(16,2),
  kalshi_volume_24h     numeric(16,2),

  observed_at          timestamptz not null default now()
);

-- Index: time-series queries per opportunity ("show me the spread history")
create index if not exists idx_arb_snap_opp_time
  on public.arbitrage_snapshots (opportunity_id, observed_at desc);

-- Index: global time-series ("all snapshots in the last hour")
create index if not exists idx_arb_snap_observed_at
  on public.arbitrage_snapshots (observed_at desc);

-- Partial index: quickly find large-spread snapshots
create index if not exists idx_arb_snap_large_spread
  on public.arbitrage_snapshots (spread desc)
  where spread >= 0.05;
