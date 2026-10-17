-- Paper Repro Agent: shared store for "run it on your own agent".
-- A viewer creates a job (RPC), publishes a kit (plain text file in Storage), and the user's own agent
-- posts progress and the final result back through RPCs with the job's one-time token.
-- Nothing here holds a model key. The anon role can read jobs/events and call the three functions only.

create table if not exists public.repro_jobs (
  id uuid primary key default gen_random_uuid(),
  arxiv_id text not null,
  title text,
  lang text not null default 'en',
  status text not null default 'waiting' check (status in ('waiting', 'running', 'done', 'failed')),
  verdict text,
  agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- tokens live apart from the jobs so that reading jobs can never expose them
create table if not exists public.repro_job_tokens (
  job_id uuid primary key references public.repro_jobs (id) on delete cascade,
  token text not null
);

create table if not exists public.repro_events (
  id bigserial primary key,
  job_id uuid not null references public.repro_jobs (id) on delete cascade,
  kind text not null check (kind in ('contract', 'route', 'plan', 'progress', 'file', 'result', 'note')),
  agent text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists repro_events_job on public.repro_events (job_id, id);
create index if not exists repro_jobs_created on public.repro_jobs (created_at desc);

alter table public.repro_jobs enable row level security;
alter table public.repro_job_tokens enable row level security;
alter table public.repro_events enable row level security;

drop policy if exists jobs_read on public.repro_jobs;
create policy jobs_read on public.repro_jobs for select to anon, authenticated using (true);
drop policy if exists events_read on public.repro_events;
create policy events_read on public.repro_events for select to anon, authenticated using (true);
-- no policy on repro_job_tokens: nobody but the functions below can touch it

revoke all on public.repro_jobs, public.repro_job_tokens, public.repro_events from anon, authenticated;
grant select on public.repro_jobs, public.repro_events to anon, authenticated;

create or replace function public.create_job(p_arxiv text, p_title text default null, p_lang text default 'en')
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  j uuid;
  t text := encode(gen_random_bytes(18), 'hex');
begin
  if p_arxiv is null or length(p_arxiv) > 200 then raise exception 'bad paper id'; end if;
  if (select count(*) from repro_jobs where created_at > now() - interval '1 hour') > 300 then
    raise exception 'too many jobs, try again later';
  end if;
  insert into repro_jobs (arxiv_id, title, lang) values (left(p_arxiv, 200), left(p_title, 400), case when p_lang = 'zh' then 'zh' else 'en' end)
    returning id into j;
  insert into repro_job_tokens (job_id, token) values (j, t);
  return json_build_object('id', j, 'token', t);
end $$;

create or replace function public.post_event(p_job uuid, p_token text, p_kind text, p_payload jsonb, p_agent text default null)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  ok boolean;
  v text;
begin
  select true into ok from repro_job_tokens where job_id = p_job and token = p_token;
  if not coalesce(ok, false) then raise exception 'bad job or token'; end if;
  if p_kind not in ('contract', 'route', 'plan', 'progress', 'file', 'result', 'note') then raise exception 'bad kind'; end if;
  if length(p_payload::text) > 400000 then raise exception 'payload too large'; end if;
  insert into repro_events (job_id, kind, agent, payload) values (p_job, p_kind, left(p_agent, 80), p_payload);
  if p_kind = 'result' then
    v := p_payload ->> 'verdict';
    update repro_jobs set status = 'done', verdict = v, agent = left(p_agent, 80), updated_at = now() where id = p_job;
  else
    update repro_jobs set status = case when status = 'waiting' then 'running' else status end,
      agent = coalesce(left(p_agent, 80), agent), updated_at = now() where id = p_job;
  end if;
  return json_build_object('ok', true);
end $$;

revoke all on function public.create_job(text, text, text) from public;
revoke all on function public.post_event(uuid, text, text, jsonb, text) from public;
grant execute on function public.create_job(text, text, text) to anon, authenticated;
grant execute on function public.post_event(uuid, text, text, jsonb, text) to anon, authenticated;

-- public bucket of plain-text kits; anyone may add a file, nobody may replace or delete one
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kits', 'kits', true, 300000, array['text/markdown', 'text/plain'])
on conflict (id) do update set public = true, file_size_limit = 300000, allowed_mime_types = array['text/markdown', 'text/plain'];

drop policy if exists kits_insert on storage.objects;
create policy kits_insert on storage.objects for insert to anon, authenticated with check (bucket_id = 'kits');
drop policy if exists kits_read on storage.objects;
create policy kits_read on storage.objects for select to anon, authenticated using (bucket_id = 'kits');

-- one place for the data the viewer used to hard-code: research groups and their papers
create table if not exists public.repro_directory (
  key text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.repro_directory enable row level security;
drop policy if exists directory_read on public.repro_directory;
create policy directory_read on public.repro_directory for select to anon, authenticated using (true);
revoke all on public.repro_directory from anon, authenticated;
grant select on public.repro_directory to anon, authenticated;

-- copy the contract, route and plan of the newest earlier job on the same paper into a new job
create or replace function public.reuse_steps(p_job uuid, p_token text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  ok boolean;
  a text;
  l text;
  src uuid;
  src_at timestamptz;
begin
  select true into ok from repro_job_tokens where job_id = p_job and token = p_token;
  if not coalesce(ok, false) then raise exception 'bad job or token'; end if;
  if exists (select 1 from repro_events where job_id = p_job) then return json_build_object('reused', false); end if;
  select arxiv_id, lang into a, l from repro_jobs where id = p_job;
  select j.id, j.created_at into src, src_at from repro_jobs j
   where j.arxiv_id = a and j.id <> p_job
     and exists (select 1 from repro_events e where e.job_id = j.id and e.kind = 'contract')
     and exists (select 1 from repro_events e where e.job_id = j.id and e.kind = 'route')
     and exists (select 1 from repro_events e where e.job_id = j.id and e.kind = 'plan')
   order by (j.lang = l) desc, j.created_at desc limit 1;
  if src is null then return json_build_object('reused', false); end if;
  insert into repro_events (job_id, kind, agent, payload)
    select p_job, kind, 'reused-from-' || left(src::text, 8), payload
    from (select distinct on (kind) kind, payload from repro_events
           where job_id = src and kind in ('contract', 'route', 'plan') order by kind, id desc) t;
  return json_build_object('reused', true, 'from', src, 'at', src_at);
end $$;
revoke all on function public.reuse_steps(uuid, text) from public;
grant execute on function public.reuse_steps(uuid, text) to anon, authenticated;
