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
    'jobs', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from explainer_jobs group by 1) j), '{}'::jsonb),
    'last_backup', (select to_jsonb(b) from (select taken_at, tables, rows, source from ops_backup_log order by id desc limit 1) b)
  );
$$;

revoke all on function public.ops_stats() from public, anon, authenticated;
grant execute on function public.ops_stats() to service_role;
