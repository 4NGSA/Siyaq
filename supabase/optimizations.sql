-- Siyaq database optimizations for the current anonymous hackathon demo.
--
-- This script preserves the current hackathon product workflow.
-- Review the documented table assumptions before running it in Supabase.

begin;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customers'::regclass
      and conname = 'customers_name_nonblank'
  ) then
    alter table public.customers
      add constraint customers_name_nonblank
      check (name is not null and char_length(btrim(name)) between 1 and 200)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customers'::regclass
      and conname = 'customers_phone_nonblank'
  ) then
    alter table public.customers
      add constraint customers_phone_nonblank
      check (phone is not null and char_length(btrim(phone)) between 1 and 50)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interactions'::regclass
      and conname = 'interactions_channel_allowed'
  ) then
    alter table public.interactions
      add constraint interactions_channel_allowed
      check (channel in ('phone', 'whatsapp', 'branch', 'twitter', 'email'))
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interactions'::regclass
      and conname = 'interactions_status_allowed'
  ) then
    alter table public.interactions
      add constraint interactions_status_allowed
      check (status in ('resolved', 'unresolved'))
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interactions'::regclass
      and conname = 'interactions_summary_nonblank'
  ) then
    alter table public.interactions
      add constraint interactions_summary_nonblank
      check (
        summary is not null
        and char_length(btrim(summary)) between 1 and 5000
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interactions'::regclass
      and conname = 'interactions_email_valid_for_channel'
  ) then
    alter table public.interactions
      add constraint interactions_email_valid_for_channel
      check (
        channel <> 'email'
        or (
          email is not null
          and char_length(email) <= 320
          and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        )
      )
      not valid;
  end if;
end
$$;

-- Remove duplicate normalized phones before creating this index if the command
-- reports a unique-key conflict.
create unique index if not exists customers_phone_normalized_uq
  on public.customers ((btrim(phone)))
  where phone is not null and btrim(phone) <> '';

create index if not exists interactions_customer_date_idx
  on public.interactions (customer_id, date desc);

create index if not exists interactions_status_idx
  on public.interactions (status);

-- Atomically upsert the customer, insert the interaction, and invalidate the
-- cached report. This replaces three separate browser writes.
create or replace function public.add_customer_interaction(
  p_name text,
  p_phone text,
  p_channel text,
  p_date date,
  p_summary text,
  p_status text,
  p_email text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_customer_id public.customers.id%type;
  v_interaction_id public.interactions.id%type;
  v_name text := btrim(p_name);
  v_phone text := btrim(p_phone);
  v_summary text := btrim(p_summary);
  v_email text := nullif(btrim(p_email), '');
begin
  if v_name is null or char_length(v_name) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Invalid customer name';
  end if;
  if v_phone is null or char_length(v_phone) not between 1 and 50 then
    raise exception using errcode = '22023', message = 'Invalid phone number';
  end if;
  if p_channel not in ('phone', 'whatsapp', 'branch', 'twitter', 'email') then
    raise exception using errcode = '22023', message = 'Invalid channel';
  end if;
  if p_status not in ('resolved', 'unresolved') then
    raise exception using errcode = '22023', message = 'Invalid status';
  end if;
  if p_date is null then
    raise exception using errcode = '22023', message = 'Interaction date required';
  end if;
  if v_summary is null or char_length(v_summary) not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'Invalid summary';
  end if;
  if p_channel = 'email'
     and (
       v_email is null
       or char_length(v_email) > 320
       or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     ) then
    raise exception using errcode = '22023', message = 'Invalid email address';
  end if;

  insert into public.customers (name, phone, init, report, report_updated_at)
  values (v_name, v_phone, left(v_name, 2), null, null)
  on conflict ((btrim(phone)))
    where phone is not null and btrim(phone) <> ''
  do update set
    name = excluded.name,
    phone = excluded.phone,
    init = excluded.init,
    report = null,
    report_updated_at = null
  returning id into v_customer_id;

  insert into public.interactions (
    customer_id, channel, date, summary, status, email
  )
  values (
    v_customer_id,
    p_channel,
    p_date,
    v_summary,
    p_status,
    case when p_channel = 'email' then v_email else null end
  )
  returning id into v_interaction_id;

  return jsonb_build_object(
    'customer_id', v_customer_id,
    'interaction_id', v_interaction_id
  );
end
$$;

grant execute on function public.add_customer_interaction(
  text, text, text, date, text, text, text
) to anon;

commit;
