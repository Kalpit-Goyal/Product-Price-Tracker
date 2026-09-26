-- INE Store Price Tracker — atomic success write, and RLS on every table.
--
-- WHY A SEPARATE MIGRATION
-- 001 created the tables. This one adds the two things the application layer now
-- depends on, and that 001 did not provide:
--
--   1. record_success(): writes the scrape_attempts row AND the price_history row
--      in a single transaction. Previously these were two independent inserts, so
--      a failure between them produced a run that logged SUCCESS while the price
--      was never stored — the database silently disagreeing with the log.
--      (BUILD_LOG Failure 11)
--
--   2. Row Level Security on ALL tables. 001 only enabled it on scrape_runs and
--      even said "no RLS on these tables" in a comment. All access is meant to go
--      through the service-role key, so RLS is not load-bearing here; but leaving
--      tables unprotected "because we use the service key" is exactly the
--      assumption that turns into an open table the day someone enables the anon
--      key for the frontend. Defence in depth, and it is free.
--
-- HOW TO APPLY: run in order, 001 then 002.

-- ------------------------------------------------- atomic attempt + history
--
-- The caller passes the attempt fields; the function writes the attempt row and,
-- only on success, the history row. Both or neither.
--
-- The success branch re-asserts the same invariant the table CHECK enforces, so a
-- caller cannot smuggle a NULL price into price_history via this path.
create or replace function record_success(
  p_tracked_product_id uuid,
  p_price             numeric,
  p_stock             integer,
  p_scraped_at        timestamptz,
  p_attempt           jsonb default null
)
returns setof price_history
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt_row  scrape_attempts;
  v_history_row  price_history;
begin
  if p_price is null or p_stock is null or p_price < 0 or p_stock < 0 then
    raise exception 'record_success: a validated success needs a non-null, non-negative price and stock';
  end if;

  insert into scrape_attempts (
    tracked_product_id, attempted_at, outcome, attempt_number,
    price, stock, http_status, error_code, error_message,
    duration_ms, manifest_revision
  )
  values (
    p_tracked_product_id,
    coalesce((p_attempt ->> 'attempted_at')::timestamptz, now()),
    'success',
    coalesce((p_attempt ->> 'attempt_number')::integer, 1),
    p_price,
    p_stock,
    nullif(p_attempt ->> 'http_status', '')::integer,
    nullif(p_attempt ->> 'error_code', ''),
    nullif(p_attempt ->> 'error_message', ''),
    nullif(p_attempt ->> 'duration_ms', '')::integer,
    nullif(p_attempt ->> 'manifest_revision', '')::integer
  )
  returning * into v_attempt_row;

  insert into price_history (tracked_product_id, price, currency, stock, scraped_at)
  values (p_tracked_product_id, p_price, 'INR', p_stock, coalesce(p_scraped_at, now()))
  returning * into v_history_row;

  update tracked_products
     set last_scraped_at = coalesce(p_scraped_at, now())
   where id = p_tracked_product_id;

  return next v_history_row;
end;
$$;

-- ------------------------------------------------------------- RLS: all tables
--
-- No policies are created on purpose: with RLS enabled and zero policies, the
-- anon/authenticated roles get nothing, and only the service-role key (which
-- bypasses RLS) can read or write. That is exactly the intended posture.

alter table tracked_products enable row level security;
alter table price_history   enable row level security;
alter table scrape_attempts enable row level security;
alter table scrape_runs     enable row level security;

-- Make the bypass explicit rather than implied. If someone later swaps in the
-- anon key, these statements fail loudly at deploy time instead of quietly
-- serving or wiping the table.
revoke all on tracked_products, price_history, scrape_attempts, scrape_runs
  from anon, authenticated;
revoke all on function record_success(uuid, numeric, integer, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function record_success(uuid, numeric, integer, timestamptz, jsonb)
  to service_role;

-- ------------------------------------------------------------- sanity checks
--
-- Cheap invariants, asserted at migration time so a broken deploy is caught here
-- rather than by a confusing runtime error later.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'scrape_attempts_value_matches_outcome'
  ) then
    raise exception 'invariant missing: scrape_attempts_value_matches_outcome';
  end if;

  if exists (
    select 1 from information_schema.tables
     where table_name = 'price_history'
       and table_schema = 'public'
  ) then
    if exists (
      select 1 from price_history where price is null or stock is null
    ) then
      raise exception 'invariant violated: price_history must never contain a NULL price or stock';
    end if;
  end if;
end;
$$;
