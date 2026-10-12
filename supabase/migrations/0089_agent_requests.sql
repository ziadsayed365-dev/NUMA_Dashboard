-- AI NUMA's questions to the owner on Telegram (src/lib/agent/requests.ts),
-- one row per thing it asked, matched back to the reply or poll vote that
-- answers it, so every answer lands on the right item whenever it comes.
create table if not exists public.agent_requests (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  -- What was asked, or 'report' marking a day whose report has gone out.
  kind text not null check (kind in ('tiktok', 'cost', 'allocation', 'report')),
  -- The date, model, product or ad asked about; the day, for 'report'.
  item_key text not null,
  -- The day being reported when this was asked.
  day text not null,
  status text not null default 'open' check (status in ('open', 'done')),
  -- The question's Telegram message (text questions).
  message_id bigint,
  -- Poll questions: [{ pollId, messageId, options, ..., answer }].
  polls jsonb not null default '[]'::jsonb,
  -- A test question (POST /api/agent/nightly?test=1): answered like a real one
  -- but records nothing. label names the item in the bot's replies.
  test boolean not null default false,
  label text,
  resolved_at timestamptz
);

-- Never ask the same thing twice while it is still open, and send each day's
-- report once.
create unique index if not exists agent_requests_open_uniq on public.agent_requests (kind, item_key) where status = 'open';
create unique index if not exists agent_requests_report_uniq on public.agent_requests (item_key) where kind = 'report';
create index if not exists agent_requests_message_idx on public.agent_requests (message_id);

-- Server only: the dashboard reads it with the secret key, which bypasses RLS.
alter table public.agent_requests enable row level security;
revoke all on public.agent_requests from anon, authenticated;
grant all on public.agent_requests to service_role;
grant usage, select on sequence public.agent_requests_id_seq to service_role;
