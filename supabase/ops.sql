-- Operations stats for the admin panel: sizes against the free-plan limits, LLM calls, and when the last backup ran.
-- Only the service role (the explainer-admin function) may call ops_stats().

create table if not exists public.ops_backup_log (
  id bigserial primary key,
  taken_at timestamptz not null default now(),
  tables int not null,
  rows int not null,
  source text not null default 'github-actions'
);
alter table public.ops_backup_log enable row level security;

create or replace function public.ops_stats() returns jsonb
language sql security definer set search_path = public, storage as $$
  select jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'storage', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket_id, 'objects', n, 'bytes', b)) from (
        select bucket_id, count(*) n, coalesce(sum((metadata->>'size')::bigint), 0) b from storage.objects group by 1) s), '[]'::jsonb),
    'llm', coalesce((select jsonb_agg(x) from (
        select app,
               count(*) filter (where created_at >= now() - interval '1 day') as calls_24h,
               count(*) filter (where created_at >= now() - interval '7 days') as calls_7d,
               coalesce(sum(prompt_tokens + completion_tokens) filter (where created_at >= now() - interval '1 day'), 0) as tokens_24h,
               coalesce(sum(prompt_tokens + completion_tokens) filter (where created_at >= now() - interval '7 days'), 0) as tokens_7d
        from agent_usage group by app order by 3 desc) x), '[]'::jsonb),
    'llm_daily', coalesce((select jsonb_agg(jsonb_build_object('d', to_char(g, 'MM-DD'), 'calls', coalesce(c.n, 0), 'tokens', coalesce(c.t, 0)) order by g)
        from generate_series(current_date - 13, current_date, interval '1 day') g
        left join (select created_at::date d, count(*) n, sum(prompt_tokens + completion_tokens) t from agent_usage group by 1) c on c.d = g::date), '[]'::jsonb),
    'jobs_daily', coalesce((select jsonb_agg(jsonb_build_object('d', to_char(g, 'MM-DD'), 'n', coalesce(c.n, 0)) order by g)
        from generate_series(current_date - 13, current_date, interval '1 day') g
        left join (select created_at::date d, count(*) n from explainer_jobs group by 1) c on c.d = g::date), '[]'::jsonb),
    -- an upper-bound estimate of storage egress: plays and downloads of storage-hosted videos (gallery examples ship with the site and cost none)
    -- times the average size of that kind of file. A partly watched or browser-cached play costs less than this.
    'egress', (with sz as (
          select coalesce(avg((metadata->>'size')::bigint) filter (where name like '%\_vertical.mp4'), 0) v,
                 coalesce(avg((metadata->>'size')::bigint) filter (where name ~ '_s[0-9]+\.mp4$'), 0) s,
                 coalesce(avg((metadata->>'size')::bigint) filter (where name like '%.mp4' and name not like '%\_vertical.mp4' and name !~ '_s[0-9]+\.mp4$'), 0) m
          from storage.objects),
        ev as (select coalesce(meta->>'k', 'main') k, type, count(*) n from explainer_events
          where type in ('video_play', 'video_download') and created_at >= now() - interval '30 days' group by 1, 2)
      select jsonb_build_object(
          'plays_30d', coalesce((select sum(n) from ev where type = 'video_play'), 0),
          'downloads_30d', coalesce((select sum(n) from ev where type = 'video_download'), 0),
          'est_bytes', coalesce((select sum(ev.n * case ev.k when 'vertical' then sz.v when 'section' then sz.s else sz.m end) from ev, sz), 0))),
    'jobs', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from explainer_jobs group by 1) j), '{}'::jsonb),
    'last_backup', (select to_jsonb(b) from (select taken_at, tables, rows, source from ops_backup_log order by id desc limit 1) b)
  );
$$;

revoke all on function public.ops_stats() from public, anon, authenticated;
grant execute on function public.ops_stats() to service_role;
