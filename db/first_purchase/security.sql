-- Install after schema.sql as the isolated prototype database owner.
-- Provisioners grant USAGE/EXECUTE explicitly; installation grants nothing to PUBLIC.
begin;
create schema purchase_api;
revoke create on schema public from public;
revoke all on schema purchase,purchase_api from public;
create table purchase_api.principal (
 login name primary key,
 actor text not null check(actor in ('customer','merchant','courier','service')),
 active boolean not null default true,
 customer_id bigint,
 merchant_id bigint references purchase.merchant,
 check ((actor='customer' and customer_id is not null and merchant_id is null)
     or (actor='merchant' and merchant_id is not null and customer_id is null)
     or (actor in ('courier','service') and customer_id is null and merchant_id is null))
);
create table purchase_api.courier_assignment (
 order_id bigint primary key references purchase.merchant_share,
 courier_login name not null references purchase_api.principal(login)
);

-- session_user remains the authenticated LOGIN inside SECURITY DEFINER calls.
-- Neither SET ROLE nor caller-controlled custom GUCs choose the actor.
create function purchase_api.actor(required text) returns purchase_api.principal
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal;
begin
 select * into p from purchase_api.principal where login=session_user and active;
 if not found or p.actor<>required then raise exception 'access denied' using errcode='42501'; end if;
 return p;
end $$;
-- Final authorization is locked after business locks; a revocation committed
-- while the operation waited aborts and rolls back all its effects.
create function purchase_api.lock_actor(required text) returns void
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal;
begin
 select * into p from purchase_api.principal where login=session_user for share;
 if not found or not p.active or p.actor<>required then
  raise exception 'access denied' using errcode='42501';
 end if;
end $$;
create function purchase_api.own_quote(q bigint) returns bigint
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal;
begin
 perform 1 from purchase.quote where id=q for update;
 p:=purchase_api.actor('customer');
 if not exists(select from purchase.quote where id=q and customer_id=p.customer_id) then
  raise exception 'access denied' using errcode='42501';
 end if;
 return p.customer_id;
end $$;
create function purchase_api.reserve(q bigint) returns boolean
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare result boolean;
begin
 perform purchase_api.own_quote(q);
 result:=purchase.reserve(q);
 perform purchase_api.lock_actor('customer');
 perform purchase_api.own_quote(q);
 return result;
end $$;
create function purchase_api.request_unallocated_refund(q bigint, receipt_ref text default null) returns text
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare result text;
begin
 result:=purchase.request_unallocated_refund(q,purchase_api.own_quote(q),receipt_ref);
 perform purchase_api.lock_actor('customer');
 perform purchase_api.own_quote(q);
 return result;
end $$;
create function purchase_api.accept_replacement(q bigint, selected bigint) returns bigint
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare customer bigint; result bigint;
begin
 customer:=purchase_api.own_quote(q);
 perform purchase_api.own_quote(selected);
 result:=purchase.accept_replacement(q,selected,customer);
 perform purchase_api.lock_actor('customer');
 perform purchase_api.own_quote(q);
 perform purchase_api.own_quote(selected);
 return result;
end $$;
create function purchase_api.customer_order(q bigint)
returns table(order_id bigint,price numeric,picked_up boolean,delivered boolean)
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
begin
 perform purchase_api.own_quote(q);
 perform purchase_api.lock_actor('customer');
 perform purchase_api.own_quote(q);
 return query select o.id,i.price,
 exists(select from purchase.handoff h where h.order_id=o.id and h.kind='pickup'),
 exists(select from purchase.handoff h where h.order_id=o.id and h.kind='delivered')
 from purchase.purchase_order o join purchase.order_item i on i.order_id=o.id where o.id=q;
end $$;
create function purchase_api.merchant_order(q bigint)
returns table(order_id bigint,price numeric,supply numeric,fee numeric,payable numeric)
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal;
begin
 perform 1 from purchase.merchant_share s where s.order_id=q for share;
 perform purchase_api.lock_actor('merchant');
 p:=purchase_api.actor('merchant');
 if not exists(select from purchase.merchant_share s where s.order_id=q and s.merchant_id=p.merchant_id) then
  raise exception 'access denied' using errcode='42501';
 end if;
 return query select i.order_id,i.price,i.supply,i.fee,a.amount
 from purchase.order_item i left join purchase.payable a on a.order_id=i.order_id where i.order_id=q;
end $$;
create function purchase_api.record_handoff(q bigint, kind text, evidence text) returns void
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
begin
 perform 1 from purchase.merchant_share where order_id=q for update;
 perform purchase_api.actor('courier');
 if not exists(select from purchase_api.courier_assignment a where a.order_id=q and a.courier_login=session_user) then
  raise exception 'access denied' using errcode='42501';
 end if;
 perform purchase.record_handoff(q,kind,evidence);
 perform purchase_api.lock_actor('courier');
 perform 1 from purchase_api.courier_assignment a
 where a.order_id=q and a.courier_login=session_user for share;
 if not found then raise exception 'access denied' using errcode='42501'; end if;
end $$;
create function purchase_api.capture(q bigint, ref text, evt text, amt numeric, paid timestamptz) returns boolean
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare result boolean;
begin
 perform purchase_api.actor('service');
 result:=purchase.capture(q,ref,evt,amt,paid);
 perform purchase_api.lock_actor('service');
 return result;
end $$;
create function purchase_api.confirm_unallocated_refund(ref text, receipt text, amount numeric) returns void
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
begin
 perform purchase_api.actor('service');
 perform purchase.confirm_unallocated_refund(ref,receipt,amount);
 perform purchase_api.lock_actor('service');
end $$;
create function purchase_api.release_expired(q bigint) returns void
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
begin
 perform purchase_api.actor('service');
 perform purchase.release_expired(q);
 perform purchase_api.lock_actor('service');
end $$;
-- Put pg_temp explicitly last in every internal function too: otherwise a
-- caller-created temporary relation could shadow an internal table.
do $$
declare f record;
begin
 for f in select p.oid::regprocedure as signature
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='purchase'
 loop
  execute format('alter function %s set search_path=pg_catalog,purchase,pg_temp',f.signature);
 end loop;
end $$;
-- Internal lifecycle functions are invoker functions. Only the definer owner can
-- reach their tables; authenticated application logins receive no internal rights.
revoke all on all tables in schema purchase,purchase_api from public;
revoke all on all sequences in schema purchase,purchase_api from public;
revoke all on all functions in schema purchase,purchase_api from public;
alter default privileges in schema purchase,purchase_api revoke all on tables from public;
alter default privileges in schema purchase,purchase_api revoke all on sequences from public;
alter default privileges in schema purchase,purchase_api revoke execute on functions from public;
commit;
