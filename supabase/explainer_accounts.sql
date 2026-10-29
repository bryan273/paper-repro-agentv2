-- Accounts, credits and the event log for Paper Explainer. Written only by the edge functions (service role).
create table if not exists explainer_users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  salt text not null, pass_hash text not null,
  credits int not null default 0,
  banned boolean not null default false,
  created_at timestamptz default now(), last_login timestamptz
);
create table if not exists explainer_sessions (
  token_hash text primary key,
  user_id uuid not null references explainer_users(id) on delete cascade,
  created_at timestamptz default now(), expires_at timestamptz not null
);
create table if not exists explainer_events (
  id bigserial primary key,
  created_at timestamptz default now(),
  actor text not null default '', user_id uuid, type text not null, meta jsonb not null default '{}'
);
create index if not exists explainer_events_type_time on explainer_events (type, created_at desc);
create table if not exists explainer_credit_log (
  id bigserial primary key, created_at timestamptz default now(),
  user_id uuid not null references explainer_users(id) on delete cascade, delta int not null, reason text not null default ''
);
alter table explainer_jobs add column if not exists user_id uuid;
alter table explainer_jobs add column if not exists credit_used int not null default 0;
alter table explainer_jobs add column if not exists refunded boolean not null default false;
alter table explainer_users enable row level security;
alter table explainer_sessions enable row level security;
alter table explainer_events enable row level security;
alter table explainer_credit_log enable row level security;
