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
