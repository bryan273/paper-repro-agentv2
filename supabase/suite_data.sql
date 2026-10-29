-- Data for the Repro Suite apps (Repro Lite checks, Reading Companion sessions, Repro Desk requests and events, IndexBoard boards).
-- Written and read only through the suite-data edge function (service role); RLS is on and there are no public policies.
create table if not exists suite_docs (
  id bigint generated always as identity primary key,
  collection text not null,
  key text,
  data jsonb not null,
  ip text default '',
  created_at timestamptz default now()
);
create index if not exists suite_docs_coll_created on suite_docs (collection, created_at desc);
create unique index if not exists suite_docs_coll_key on suite_docs (collection, key) where key is not null;
create table if not exists suite_boards (
  slug text primary key,
  title text not null,
  description text default '',
  payload jsonb not null,
  edit_hash text not null,
  ip text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table suite_docs enable row level security;
alter table suite_boards enable row level security;
