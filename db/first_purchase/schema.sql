-- Apply once to an empty experimental database, as its owner.
begin;
create schema purchase;
set local search_path = purchase, public;
create table merchant(id bigint primary key, name text not null);
create table branch(id bigint primary key, merchant_id bigint not null references merchant);
create table sku(id bigint primary key, name text not null);
create table stock(
 id bigint primary key, branch_id bigint not null references branch, sku_id bigint not null references sku,
 on_hand integer not null, held integer not null default 0, allocated integer not null default 0,
 unique(branch_id,sku_id), check(held>=0 and allocated>=0 and on_hand>=held+allocated)
);
-- Quotes below are server-generated snapshots for one prepaid handset in Sanaa.
create table offer(id bigint primary key, stock_id bigint not null references stock,
 supply_yer numeric not null check(supply_yer>0), rate numeric not null check(rate between 0 and 1));
create table quote(id bigint primary key, customer_id bigint not null, offer_id bigint not null references offer,
 price numeric not null check(price>0), supply numeric not null check(supply>0), fee numeric not null check(fee between 0 and supply),
 expires timestamptz not null);
create table hold(quote_id bigint primary key references quote, expires timestamptz not null,
 state text not null check(state in ('held','expired','allocated')));
create table payment(quote_id bigint not null references quote, provider_ref text primary key,
 amount numeric not null check(amount>0), paid_at timestamptz not null, fulfilled boolean not null);
create unique index one_fulfilled_receipt on payment(quote_id) where fulfilled;
create table provider_event(event_id text primary key, provider_ref text not null references payment(provider_ref));
create table purchase_order(id bigint primary key references quote, customer_id bigint not null);
create table merchant_share(order_id bigint primary key references purchase_order, merchant_id bigint not null references merchant);
create table order_item(order_id bigint primary key references merchant_share, stock_id bigint not null references stock,
 price numeric not null, supply numeric not null, fee numeric not null);
create table handoff(order_id bigint references merchant_share, kind text check(kind in ('pickup','delivered')),
 proof text not null, recorded_at timestamptz not null default clock_timestamp(), primary key(order_id,kind));
create table payable(order_id bigint primary key references merchant_share, amount numeric not null);
create table journal(id bigint generated always as identity primary key, quote_id bigint not null references quote,
 kind text not null, receipt_ref text references payment(provider_ref),
 created_xid xid8 not null default pg_current_xact_id(),
 unique nulls not distinct(quote_id,kind,receipt_ref));
create table posting(journal_id bigint references journal, account text not null, signed_amount numeric not null,
 primary key(journal_id,account));

-- All lifecycle operations lock quote first, then stock. Never wait on an external provider in a transaction.
create function reserve(q bigint) returns boolean language plpgsql set search_path=purchase,pg_catalog as $$
declare x quote; h hold; sid bigint;
begin
 select * into strict x from quote where id=q for update;
 if exists(select from payment where quote_id=q) then return false; end if;
 perform release_expired(q);
 if x.expires<=clock_timestamp() then return false; end if;
 select * into h from hold where quote_id=q;
 if found and h.state<>'expired' then
  return h.state='held' and h.expires>clock_timestamp();
 end if;
 select stock_id into strict sid from offer where id=x.offer_id;
 update stock set held=held+1 where id=sid and on_hand>held+allocated;
 if not found then return false; end if;
 insert into hold values(q,clock_timestamp()+interval '15 minutes','held')
 on conflict(quote_id) do update set expires=excluded.expires,state=excluded.state;
 return true;
end $$;

create function release_expired(q bigint) returns void language plpgsql set search_path=purchase,pg_catalog as $$
declare sid bigint;
begin
 perform 1 from quote where id=q for update;
 update hold set state='expired' where quote_id=q and state='held' and expires<=clock_timestamp();
 if found then
  select o.stock_id into strict sid from quote x join offer o on o.id=x.offer_id where x.id=q;
  update stock set held=held-1 where id=sid;
 end if;
end $$;

-- Trusted callback adapter passes verified provider data; one external provider in this experiment.
create function capture(q bigint, ref text, evt text, amt numeric, paid timestamptz) returns boolean
language plpgsql set search_path=purchase,pg_catalog as $$
declare x quote; p payment; h hold; sid bigint; mid bigint; ok boolean:=false; j bigint; another_receipt boolean;
begin
 select * into strict x from quote where id=q for update;
 select * into p from payment where provider_ref=ref;
 if found then
  if (p.quote_id,p.amount,p.paid_at) is distinct from (q,amt,paid) then raise exception 'payment conflict'; end if;
  if exists(select from provider_event where event_id=evt and provider_ref<>ref) then raise exception 'event conflict'; end if;
  insert into provider_event values(evt,ref) on conflict do nothing;
  return p.fulfilled;
 end if;
 if amt is null or amt<=0 or paid is null then raise exception 'invalid payment'; end if;
 another_receipt:=exists(select from payment where quote_id=q);
 perform release_expired(q);
 select * into h from hold where quote_id=q;
 select s.id,b.merchant_id into strict sid,mid from offer o join stock s on s.id=o.stock_id
 join branch b on b.id=s.branch_id where o.id=x.offer_id;
 if not another_receipt and amt=x.price and paid<x.expires then
  if h.state='held' then
   update stock set held=held-1,allocated=allocated+1 where id=sid;
   ok:=true;
  elsif h.state='expired' then
   update stock set allocated=allocated+1 where id=sid and on_hand>held+allocated;
   ok:=found;
  end if;
 end if;
 insert into payment values(q,ref,amt,paid,ok);
 insert into provider_event values(evt,ref);
 if ok then
  update hold set state='allocated' where quote_id=q;
  insert into purchase_order values(q,x.customer_id);
  insert into merchant_share values(q,mid);
  insert into order_item values(q,sid,x.price,x.supply,x.fee);
 elsif not another_receipt and h.state='held' then
  update hold set state='expired' where quote_id=q;
  update stock set held=held-1 where id=sid;
 end if;
 insert into journal(quote_id,kind,receipt_ref) values(q,'capture',ref) returning id into j;
 insert into posting values(j,'clearing',amt),(j,case when ok then 'pending_sales' else '2113' end,-amt);
 return ok;
end $$;

create function record_handoff(q bigint, event_kind text, evidence text) returns void
language plpgsql set search_path=purchase,pg_catalog as $$
declare item order_item; j bigint;
begin
 perform 1 from merchant_share where order_id=q for update;
 select * into strict item from order_item where order_id=q;
 if exists(select from handoff where order_id=q and kind=event_kind) then return; end if;
 if event_kind='delivered' and not exists(select from handoff where order_id=q and kind='pickup') then
  raise exception 'pickup required';
 end if;
 insert into handoff(order_id,kind,proof) values(q,event_kind,evidence);
 if event_kind='pickup' then
  update stock set allocated=allocated-1,on_hand=on_hand-1 where id=item.stock_id;
 else
  insert into payable values(q,item.supply-item.fee);
  insert into journal(quote_id,kind) values(q,'release') returning id into j;
  insert into posting values(j,'pending_sales',item.price),(j,'merchant_payable',-(item.supply-item.fee)),
   (j,'platform_revenue',-(item.price-item.supply+item.fee));
 end if;
end $$;
commit;
-- Trusted, already-eligible candidates; prices normalized to YER upstream.
-- For the first flow there are two qualifying offers with distinct supply prices.
begin;
set local search_path=purchase,public;
create table candidate(quote_id bigint references quote, offer_id bigint references offer,
 supply numeric not null, fee numeric not null, primary key(quote_id,offer_id));
create function quote_handset(q bigint, customer bigint, product bigint, eligible_offers bigint[])
returns void language plpgsql set search_path=purchase,pg_catalog as $$
declare selected offer; options offer[];
begin
 select array_agg(o order by o.supply_yer, o.supply_yer*o.rate desc,o.id) into options
 from offer o join stock s on s.id=o.stock_id where s.sku_id=product and s.on_hand>s.held+s.allocated
 and o.id=any(eligible_offers);
 if options is null then raise exception 'no available offer'; end if;
 selected:=options[1];
 if cardinality(options)>1 and selected.supply_yer=(options[2]).supply_yer
 and selected.supply_yer*selected.rate=(options[2]).supply_yer*(options[2]).rate then
  raise exception 'distance tie-break required outside this experiment';
 end if;
 insert into quote values(q,customer,selected.id,selected.supply_yer,selected.supply_yer,
  selected.supply_yer*selected.rate,clock_timestamp()+interval '1 hour');
 insert into candidate select q,o.id,o.supply_yer,o.supply_yer*o.rate from unnest(options) o;
end $$;
commit;

-- Full refund of an unallocated external payment. The payment reference is the
-- durable instruction key; the provider adapter must reuse it on every retry.
begin;
set local search_path=purchase,public;
create table unallocated_refund (
 quote_id bigint not null references quote,
 provider_ref text primary key references payment,
 confirmation_ref text unique
);

-- An accepted replacement spends the original receipt without creating another payment.
create table replacement (
 original_quote bigint primary key references quote,
 provider_ref text not null unique references payment,
 replacement_quote bigint not null unique references quote,
 accepted_at timestamptz not null default clock_timestamp(),
 check(original_quote<>replacement_quote)
);

-- customer is supplied by a trusted adapter from the authenticated session.
create function request_unallocated_refund(q bigint, customer bigint, receipt_ref text default null) returns text
language plpgsql set search_path=purchase,pg_catalog as $$
declare original payment;
begin
 perform 1 from quote where id=q and customer_id=customer for update;
 if not found then raise exception 'access denied' using errcode='42501'; end if;
 if receipt_ref is null and (select count(*) from unallocated_refund where quote_id=q)=1 then
  select provider_ref into receipt_ref from unallocated_refund where quote_id=q;
 end if;
 if receipt_ref is null and (select count(*) from payment where quote_id=q)>1 then
  raise exception 'receipt reference required';
 end if;
 select p.* into strict original from payment p join quote x on x.id=p.quote_id
 where p.quote_id=q and x.customer_id=customer and (receipt_ref is null or p.provider_ref=receipt_ref) for update of p;
 if original.fulfilled or exists(select from replacement where provider_ref=original.provider_ref) then raise exception 'payment already allocated'; end if;
 insert into unallocated_refund(quote_id,provider_ref) values(q,original.provider_ref) on conflict do nothing;
 return 'refund:' || original.provider_ref;
end $$;

-- Called only after a verified successful refund to the original payment.
create function confirm_unallocated_refund(original_ref text, receipt text, refunded numeric)
returns void language plpgsql set search_path=purchase,pg_catalog as $$
declare original payment; previous_receipt text; entry_id bigint;
begin
 select * into strict original from payment where provider_ref=original_ref;
 select confirmation_ref into strict previous_receipt from unallocated_refund
 where provider_ref=original.provider_ref for update;
 if refunded is distinct from original.amount or receipt is null or btrim(receipt)='' then
  raise exception 'invalid refund confirmation';
 end if;
 if previous_receipt is not null then
  if previous_receipt<>receipt then raise exception 'conflicting refund confirmation'; end if;
  return;
 end if;
 update unallocated_refund set confirmation_ref=receipt where provider_ref=original.provider_ref;
 insert into journal(quote_id,kind,receipt_ref) values(original.quote_id,'refund',original.provider_ref) returning id into entry_id;
 insert into posting values(entry_id,'2113',original.amount),(entry_id,'clearing',-original.amount);
end $$;
commit;

-- A trusted adapter supplies customer from the session and the exact quote they accepted.
-- The original payment row serializes replacement requests with competing refund requests.
begin;
set local search_path=purchase,public;
create function accept_replacement(q bigint, selected bigint, customer bigint) returns bigint
language plpgsql set search_path=purchase,pg_catalog as $$
declare original payment; alternative quote; prior bigint; sid bigint; merchant bigint; entry_id bigint;
begin
 perform 1 from quote where id=q and customer_id=customer for update;
 if not found then raise exception 'access denied' using errcode='42501'; end if;
 select replacement_quote into prior from replacement where original_quote=q;
 if found then
  if prior<>selected then raise exception 'different replacement already accepted'; end if;
  return q;
 end if;
 -- Multiple receipts require explicit refund reconciliation before replacement.
 if (select count(*) from payment where quote_id=q)>1 then raise exception 'multiple receipts require reconciliation'; end if;
 select p.* into strict original from payment p join quote x on x.id=p.quote_id
 where p.quote_id=q and x.customer_id=customer for update of p;
 if original.fulfilled or exists(select from unallocated_refund where quote_id=q) then
  raise exception 'payment unavailable for replacement';
 end if;
 select * into strict alternative from quote where id=selected and customer_id=customer for update;
 if q=selected or alternative.price<>original.amount or alternative.expires<=clock_timestamp()
    or exists(select from hold where quote_id=selected) then
  raise exception 'a fresh equal-price replacement quote is required';
 end if;
 select s.id,b.merchant_id into strict sid,merchant from offer o join stock s on s.id=o.stock_id
 join branch b on b.id=s.branch_id where o.id=alternative.offer_id;
 update stock set allocated=allocated+1 where id=sid and on_hand>held+allocated;
 if not found then raise exception 'replacement out of stock'; end if;

 insert into replacement(original_quote,provider_ref,replacement_quote) values(q,original.provider_ref,selected);
 insert into hold values(selected,alternative.expires,'allocated');
 insert into purchase_order values(q,customer);
 insert into merchant_share values(q,merchant);
 insert into order_item values(q,sid,alternative.price,alternative.supply,alternative.fee);
 insert into journal(quote_id,kind,receipt_ref) values(q,'replacement',original.provider_ref) returning id into entry_id;
 insert into posting values(entry_id,'2113',original.amount),(entry_id,'pending_sales',-original.amount);
 return q;
end $$;
commit;

-- Ledger headers and lines are append-only. Lines can be inserted only in the
-- transaction that created their header; deferred checks run before COMMIT.
begin;
set local search_path=purchase,pg_catalog;
create function protect_journal() returns trigger language plpgsql
set search_path=purchase,pg_catalog as $$
begin
 raise exception 'posted journal is immutable' using errcode='23514';
end $$;
create trigger immutable_journal before update or delete on journal
for each row execute function protect_journal();

create function protect_posting() returns trigger language plpgsql
set search_path=purchase,pg_catalog as $$
begin
 if tg_op<>'INSERT' then
  raise exception 'posted entry is immutable' using errcode='23514';
 end if;
 if not exists(select from journal where id=new.journal_id and created_xid=pg_current_xact_id()) then
  raise exception 'journal belongs to another transaction' using errcode='23514';
 end if;
 return new;
end $$;
create trigger immutable_posting before insert or update or delete on posting
for each row execute function protect_posting();

create function enforce_balanced_journal() returns trigger language plpgsql security definer
set search_path=pg_catalog,purchase,pg_temp as $$
declare entry_id bigint; line_count bigint; total numeric;
begin
 if tg_table_name='journal' then entry_id:=new.id;
 else entry_id:=new.journal_id;
 end if;
 select count(*),coalesce(sum(signed_amount),0) into line_count,total
 from posting where journal_id=entry_id;
 if line_count<2 or total<>0 then
  raise exception 'journal must have at least two balanced lines' using errcode='23514';
 end if;
 return null;
end $$;
create constraint trigger journal_balanced after insert on journal
deferrable initially deferred for each row execute function enforce_balanced_journal();
create constraint trigger posting_balanced after insert on posting
deferrable initially deferred for each row execute function enforce_balanced_journal();
commit;
