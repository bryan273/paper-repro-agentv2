-- Feedback and Studio orders for Paper Explainer. Written only through the explainer-data edge function (service role).
create table if not exists explainer_feedback (
  id uuid primary key default gen_random_uuid(),
  rating int, use_case text default '', comment text default '', email text default '', arxiv text default '', kind text default 'general',
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists explainer_orders (
  id uuid primary key default gen_random_uuid(),
  email text not null, arxiv text not null, language text default 'en', notes text default '', status text default 'new',
  created_at timestamptz default now()
);
alter table explainer_feedback enable row level security;
alter table explainer_orders enable row level security;

-- Payment claims: a customer taps "I have paid" after scanning the QR; the owner confirms in the admin dashboard.
alter table explainer_orders add column if not exists pay_method text default '';
alter table explainer_orders add column if not exists paid_at timestamptz;
