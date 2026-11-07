-- Paper Explainer server renders: one row per requested video, filled in by the GitHub Actions renderer.
-- Visitors never touch the table directly: the explainer-render function inserts and reads it with the service role,
-- and the renderer updates it with the service role. Finished MP4s go to the public bucket explainer-videos.
create table if not exists public.explainer_jobs (
  id uuid primary key default gen_random_uuid(),
  arxiv text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  stage text,
  title text,
  visitor text,
  videos jsonb not null default '{}'::jsonb,      -- {"en": url, "zh": url, "en_vertical": url, "zh_vertical": url}
  checks jsonb,                                   -- {"checked": n, "removed": [..]}
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists explainer_jobs_arxiv on public.explainer_jobs (arxiv, status);
create index if not exists explainer_jobs_created on public.explainer_jobs (created_at desc);
alter table public.explainer_jobs enable row level security;   -- no policies: only the service role reads or writes

insert into storage.buckets (id, name, public) values ('explainer-videos', 'explainer-videos', true)
on conflict (id) do update set public = true;

-- style options chosen per video: look (style = theme name), narration tone, length in seconds and an optional note from the viewer
alter table explainer_jobs add column if not exists tone text not null default 'teacher';
alter table explainer_jobs add column if not exists seconds int not null default 36;
alter table explainer_jobs add column if not exists custom text not null default '';

-- a video is made of sections, each its own short video; the page shows them one by one as they finish
alter table explainer_jobs add column if not exists sections jsonb;

-- PDF uploads: a private bucket (20 MB, PDF only) and the bookkeeping that ties each file to a visitor and, once used, to a job.
-- The renderer deletes the file when the job ends; scripts/uploads_sweep.py removes the ones that never became a job.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('explainer-uploads', 'explainer-uploads', false, 20971520, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 20971520, allowed_mime_types = array['application/pdf'];
create table if not exists public.explainer_uploads (
  path text primary key,
  actor text not null,
  name text,
  size bigint,
  job_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists explainer_uploads_actor on public.explainer_uploads (actor, created_at desc);
alter table public.explainer_uploads enable row level security;   -- no policies: only the service role reads or writes

-- Ask tab: the paper text kept with a finished video (removed with the video when it expires), a per-visitor question counter,
-- and each visitor's saved chat per video.
alter table public.explainer_jobs add column if not exists paper_text text;
create table if not exists public.explainer_asks (
  id bigint generated always as identity primary key,
  job_id uuid,
  actor text not null,
  user_id uuid,
  intent text,
  tokens int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists explainer_asks_actor on public.explainer_asks (actor, created_at desc);
alter table public.explainer_asks enable row level security;
create table if not exists public.explainer_chats (
  job_id uuid not null,
  owner text not null,
  messages jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (job_id, owner)
);
alter table public.explainer_chats enable row level security;
alter table public.explainer_jobs add column if not exists langs text;
alter table public.explainer_jobs add column if not exists timeline jsonb;
alter table public.explainer_jobs add column if not exists paper_pages jsonb;
