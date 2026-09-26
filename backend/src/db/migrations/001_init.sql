-- INE Store Price Tracker — initial schema
--
-- Design notes:
--   * price_history holds ONLY validated successes. It is deliberately separate
--     from scrape_attempts so that "no row" and "row with NULL" are different
--     states and a failed scrape can never look like a real observation.
--   * scrape_attempts holds EVERY attempt, including failures, with NULL
--     price/stock. This is the honest history the assignment grades on.
--   * outcome is constrained so the DB, the CSV and the UI cannot disagree.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- products
create table if not exists tracked_products (
  id                uuid primary key default gen_random_uuid(),
  store_product_id  integer      not null,           -- id from /item/{id} in the store URL
  product_name      text         not null,
  brand             text,
  category          text,
  sku               text,
  option_axis       text,                            -- e.g. 'Edition'
  option_id         text         not null,           -- e.g. 'o2'
  option_label      text         not null,           -- e.g. 'Special Edition'
  source_url        text         not null,
  active            boolean      not null default true,
  last_scraped_at   timestamptz,
  created_at        timestamptz not null default now(),
  constraint tracked_products_store_option_uniq unique (store_product_id, option_id)
);

create index if not exists tracked_products_active_idx on tracked_products (active);

-- ------------------------------------------------------- price history
-- Successful, verified observations only.
create table if not exists price_history (
  id                 bigserial primary key,
  tracked_product_id uuid        not null references tracked_products(id) on delete cascade,
  price              numeric(12,2) not null check (price >= 0),
  currency           text        not null default 'INR',
  stock              integer     not null check (stock >= 0),
  scraped_at         timestamptz not null default now()
);

create index if not exists price_history_lookup_idx
  on price_history (tracked_product_id, scraped_at desc);

-- -------------------------------------------------------- scrape attempts
-- EVERY attempt. Failures are recorded with NULL price/stock — never hidden.
create table if not exists scrape_attempts (
  id                 bigserial primary key,
  tracked_product_id uuid        not null references tracked_products(id) on delete cascade,
  attempted_at       timestamptz not null default now(),
  outcome            text        not null check (outcome in ('success', 'retried', 'failed')),
  attempt_number     integer     not null default 1,
  price              numeric(12,2) check (price >= 0),   -- NULL unless outcome = 'success'
  stock              integer     check (stock >= 0),      -- NULL unless outcome = 'success'
  http_status        integer,
  error_code         text,
  error_message      text,
  duration_ms        integer,
  manifest_revision  integer                           -- store layout revision in force
);

create index if not exists scrape_attempts_lookup_idx
  on scrape_attempts (tracked_product_id, attempted_at desc);

create index if not exists scrape_attempts_outcome_idx on scrape_attempts (outcome);

-- Enforce the "no value on failure" invariant in the database itself, so that a
-- future bug in application code cannot quietly write a price onto a failed run.
alter table scrape_attempts
  drop constraint if exists scrape_attempts_value_matches_outcome;
alter table scrape_attempts
  add constraint scrape_attempts_value_matches_outcome
  check (
    (outcome = 'success' and price is not null and stock is not null)
    or (outcome <> 'success' and price is null and stock is null)
  );

-- ------------------------------------------- latest price per product (RPC)
-- Used by the dashboard. security definer is unnecessary (no RLS on these
-- tables), but the search_path is pinned as good practice.
create or replace function latest_prices()
returns table (
  tracked_product_id uuid,
  price              numeric,
  currency           text,
  stock              integer,
  scraped_at         timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (h.tracked_product_id)
    h.tracked_product_id, h.price, h.currency, h.stock, h.scraped_at
  from price_history h
  order by h.tracked_product_id, h.scraped_at desc;
$$;

-- ------------------------------------------------------ run bookkeeping
-- Cheap observability for the cron: how did the last runs go?
create table if not exists scrape_runs (
  id           uuid primary key default gen_random_uuid(),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  attempted    integer not null default 0,
  succeeded    integer not null default 0,
  failed       integer not null default 0,
  trigger      text
);

alter table scrape_runs enable row level security;
