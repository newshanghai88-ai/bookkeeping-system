create extension if not exists pgcrypto;

create table if not exists stores (
  id uuid primary key default gen_random_uuid(),
  store_no text not null unique,
  store_name text not null,
  remark text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_deleted boolean not null default false
);

create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  company_no bigint,
  company_name text not null,
  company_type text not null default '其他' check (company_type in ('客户', '供应商', '其他')),
  store_label text,
  phone text,
  remark text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_deleted boolean not null default false
);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  serial_no text not null,
  store_id uuid not null references stores(id),
  company_id uuid references companies(id),
  transaction_date date not null,
  amount numeric(12,2) not null check (amount >= 0),
  transaction_type text not null check (transaction_type in ('欠款', '还款', '银行汇款')),
  remittance_company text,
  remittance_method text not null check (remittance_method in ('现金', '银行转账', '微信', '支付宝', '其他')),
  remittance_account text,
  remark text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  operator_user_id uuid not null default auth.uid() references auth.users(id),
  operator text,
  is_deleted boolean not null default false,
  constraint transactions_store_serial_no_unique unique (store_id, serial_no)
);

alter table transactions
add column if not exists company_id uuid references companies(id);

do $$
declare
  constraint_name text;
begin
  select con.conname
  into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where rel.relname = 'transactions'
    and nsp.nspname = 'public'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%transaction_type%';

  if constraint_name is not null then
    execute format('alter table transactions drop constraint %I', constraint_name);
  end if;
end $$;

alter table transactions
add constraint transactions_transaction_type_check
check (transaction_type in ('欠款', '还款', '银行汇款'));

create sequence if not exists companies_company_no_seq;

alter table companies
add column if not exists company_no bigint;

alter table companies
add column if not exists store_label text;

with max_existing as (
  select coalesce(max(company_no), 0) as base_no
  from companies
),
numbered_companies as (
  select id, max_existing.base_no + row_number() over (order by created_at, company_name, id) as row_no
  from companies
  cross join max_existing
  where company_no is null
)
update companies
set company_no = numbered_companies.row_no
from numbered_companies
where companies.id = numbered_companies.id;

select setval(
  'companies_company_no_seq',
  greatest(coalesce((select max(company_no) from companies), 0), 1),
  coalesce((select max(company_no) from companies), 0) > 0
);

alter table companies
alter column company_no set default nextval('companies_company_no_seq');

alter table companies
alter column company_no set not null;

create table if not exists backup_logs (
  id uuid primary key default gen_random_uuid(),
  backup_type text not null,
  status text not null check (status in ('running', 'success', 'failed')),
  file_name text,
  record_count integer not null default 0,
  sent_to text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_stores_store_no on stores(store_no);
create index if not exists idx_stores_is_deleted on stores(is_deleted);
create unique index if not exists idx_companies_name_unique
on companies (lower(company_name))
where is_deleted = false;
create unique index if not exists idx_companies_company_no_unique on companies(company_no);
create index if not exists idx_companies_company_name on companies(company_name);
create index if not exists idx_companies_store_label on companies(store_label);
create index if not exists idx_companies_company_type on companies(company_type);
create index if not exists idx_companies_is_deleted on companies(is_deleted);
create index if not exists idx_transactions_store_id on transactions(store_id);
create index if not exists idx_transactions_company_id on transactions(company_id);
create index if not exists idx_transactions_transaction_date on transactions(transaction_date);
create index if not exists idx_transactions_transaction_type on transactions(transaction_type);
create index if not exists idx_transactions_is_deleted on transactions(is_deleted);
create index if not exists idx_transactions_store_id_transaction_date on transactions(store_id, transaction_date);
create index if not exists idx_transactions_store_id_is_deleted on transactions(store_id, is_deleted);
create index if not exists idx_backup_logs_created_at on backup_logs(created_at desc);
create index if not exists idx_backup_logs_status on backup_logs(status);

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create or replace function prevent_company_no_change()
returns trigger as $$
begin
  if new.company_no <> old.company_no then
    raise exception 'company_no cannot be changed';
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function set_transactions_operator_user_id()
returns trigger as $$
begin
  if new.operator_user_id is null then
    new.operator_user_id = auth.uid();
  end if;

  return new;
end;
$$ language plpgsql;

drop function if exists create_transaction_with_serial_no(
  uuid,
  date,
  numeric,
  text,
  text,
  text,
  text,
  text,
  text
);

create or replace function create_transaction_with_serial_no(
  p_store_id uuid,
  p_company_id uuid,
  p_transaction_date date,
  p_amount numeric,
  p_transaction_type text,
  p_remittance_company text,
  p_remittance_method text,
  p_remittance_account text default null,
  p_remark text default null,
  p_operator text default null
)
returns transactions
language plpgsql
security invoker
as $$
declare
  v_store_no text;
  v_company_id uuid;
  v_next_no integer;
  v_serial_no text;
  v_transaction transactions;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select store_no
  into v_store_no
  from stores
  where id = p_store_id
    and is_deleted = false;

  if v_store_no is null then
    raise exception 'store not found';
  end if;

  if p_company_id is null then
    raise exception 'company is required';
  end if;

  select id
  into v_company_id
  from companies
  where id = p_company_id
    and is_deleted = false;

  if v_company_id is null then
    raise exception 'company not found';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_store_id::text || ':' || p_transaction_date::text));

  select coalesce(max(right(serial_no, 3)::integer), 0) + 1
  into v_next_no
  from transactions
  where store_id = p_store_id
    and transaction_date = p_transaction_date;

  v_serial_no := v_store_no || '-' || to_char(p_transaction_date, 'YYYYMMDD') || '-' || lpad(v_next_no::text, 3, '0');

  insert into transactions (
    serial_no,
    store_id,
    company_id,
    transaction_date,
    amount,
    transaction_type,
    remittance_company,
    remittance_method,
    remittance_account,
    remark,
    operator_user_id,
    operator
  )
  values (
    v_serial_no,
    p_store_id,
    p_company_id,
    p_transaction_date,
    p_amount,
    p_transaction_type,
    p_remittance_company,
    p_remittance_method,
    p_remittance_account,
    p_remark,
    auth.uid(),
    p_operator
  )
  returning * into v_transaction;

  return v_transaction;
end;
$$;

drop trigger if exists trigger_update_stores_updated_at on stores;
create trigger trigger_update_stores_updated_at
before update on stores
for each row
execute function update_updated_at();

drop trigger if exists trigger_update_companies_updated_at on companies;
create trigger trigger_update_companies_updated_at
before update on companies
for each row
execute function update_updated_at();

drop trigger if exists trigger_prevent_company_no_change on companies;
create trigger trigger_prevent_company_no_change
before update of company_no on companies
for each row
execute function prevent_company_no_change();

drop trigger if exists trigger_update_transactions_updated_at on transactions;
create trigger trigger_update_transactions_updated_at
before update on transactions
for each row
execute function update_updated_at();

drop trigger if exists trigger_set_transactions_operator_user_id on transactions;
create trigger trigger_set_transactions_operator_user_id
before insert on transactions
for each row
execute function set_transactions_operator_user_id();

alter table stores enable row level security;
alter table companies enable row level security;
alter table transactions enable row level security;
alter table backup_logs enable row level security;

revoke delete on stores from anon;
revoke delete on stores from authenticated;
revoke delete on companies from anon;
revoke delete on companies from authenticated;
revoke delete on transactions from anon;
revoke delete on transactions from authenticated;
revoke insert, update, delete on backup_logs from anon;
revoke insert, update, delete on backup_logs from authenticated;

drop policy if exists "logged_in_users_can_select_stores" on stores;
create policy "logged_in_users_can_select_stores"
on stores
for select
to authenticated
using (auth.uid() is not null);

drop policy if exists "logged_in_users_can_insert_stores" on stores;
create policy "logged_in_users_can_insert_stores"
on stores
for insert
to authenticated
with check (auth.uid() is not null);

drop policy if exists "logged_in_users_can_update_stores" on stores;
create policy "logged_in_users_can_update_stores"
on stores
for update
to authenticated
using (auth.uid() is not null)
with check (auth.uid() is not null);

drop policy if exists "logged_in_users_can_select_companies" on companies;
create policy "logged_in_users_can_select_companies"
on companies
for select
to authenticated
using (auth.uid() is not null);

drop policy if exists "logged_in_users_can_insert_companies" on companies;
create policy "logged_in_users_can_insert_companies"
on companies
for insert
to authenticated
with check (auth.uid() is not null);

drop policy if exists "logged_in_users_can_update_companies" on companies;
create policy "logged_in_users_can_update_companies"
on companies
for update
to authenticated
using (auth.uid() is not null)
with check (auth.uid() is not null);

drop policy if exists "logged_in_users_can_select_transactions" on transactions;
create policy "logged_in_users_can_select_transactions"
on transactions
for select
to authenticated
using (auth.uid() is not null);

drop policy if exists "logged_in_users_can_insert_transactions" on transactions;
create policy "logged_in_users_can_insert_transactions"
on transactions
for insert
to authenticated
with check (
  auth.uid() is not null
  and operator_user_id = auth.uid()
);

drop policy if exists "logged_in_users_can_update_transactions" on transactions;
create policy "logged_in_users_can_update_transactions"
on transactions
for update
to authenticated
using (auth.uid() is not null)
with check (auth.uid() is not null);

drop policy if exists "logged_in_users_can_select_backup_logs" on backup_logs;
create policy "logged_in_users_can_select_backup_logs"
on backup_logs
for select
to authenticated
using (auth.uid() is not null);

comment on table transactions is
'账目明细表。系统删除账目时不允许 delete from transactions，只能 update transactions set is_deleted = true。业务查询默认只查询 is_deleted = false。';

comment on table companies is
'公司/客户/供应商档案表。停用公司时不允许 delete，只能 update companies set is_deleted = true。';

comment on column companies.company_no is
'公司序号，数据库自动递增生成，不允许人工修改，停用后不重复使用。';

comment on column companies.store_label is
'店号/备注性编号，可编辑，用于页面搜索和导出。';

comment on column transactions.company_id is
'关联 companies.id。V2-1 起新账目必须选择 company_id；remittance_company 只保留给历史数据和备注显示。';

comment on column transactions.operator_user_id is
'对应 Supabase auth.users(id)，默认使用 auth.uid()，用于记录真实登录用户。';

comment on column transactions.operator is
'显示名称或手动备注，不作为权限判断依据。';

comment on table backup_logs is
'备份执行日志。Serverless Function 使用 service role 写入，前端登录用户只读取最近备份状态。';
