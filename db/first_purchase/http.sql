-- Versioned HTTP support migration. Apply once after schema.sql and security.sql.
-- All data-access functions remain private until an operator grants the specific
-- entry points to gateway and actor LOGINs.
begin;
create sequence purchase_api.http_quote_id start with 1000000;
select setval('purchase_api.http_quote_id',greatest(1000000,coalesce(max(id),0)+1),false) from purchase.quote;
create table purchase_api.http_session (
 token_hash text primary key,
 login name not null references purchase_api.principal,
 expires_at timestamptz not null,
 revoked boolean not null default false
);
create table purchase_api.delivery_address (
 id bigint primary key, customer_id bigint not null,
 city text not null check(city='Sanaa'), label text not null
);
create table purchase_api.eligible_offer (
 offer_id bigint primary key references purchase.offer
);
create table purchase_api.quote_address (
 quote_id bigint primary key references purchase.quote,
 address_id bigint not null references purchase_api.delivery_address
);
create table purchase_api.payment_intent (
 id uuid primary key default gen_random_uuid(), quote_id bigint not null references purchase.quote,
 amount numeric not null check(amount>0), currency text not null check(currency='YER'),
 status text not null default 'initiated' check(status in ('initiated','pending','unknown','collected','failed')),
 provider_ref text unique references purchase.payment,
 created_at timestamptz not null default clock_timestamp()
);
create unique index one_active_http_payment on purchase_api.payment_intent(quote_id)
 where status in ('initiated','pending','unknown');
create table purchase_api.receipt (
 id uuid primary key default gen_random_uuid(), provider_ref text not null unique references purchase.payment
);
create table purchase_api.refund (
 id uuid primary key default gen_random_uuid(), provider_ref text not null unique references purchase.unallocated_refund
);
create table purchase_api.http_outbox (
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in ('payment','refund')), resource_id uuid not null,
 provider_key text not null unique,
 state text not null default 'pending' check(state in ('pending','dispatched','completed')),
 lease_until timestamptz,
 attempts integer not null default 0,
 last_provider_status text, last_checked_at timestamptz
);
create table purchase_api.handoff_proof (
 token_hash text primary key, order_id bigint not null references purchase.merchant_share,
 kind text not null check(kind in ('pickup','delivered')), expires_at timestamptz not null
);
create table purchase_api.http_idempotency (
 login name not null references purchase_api.principal,
 operation text not null, resource text not null, request_key text not null,
 fingerprint text not null, status integer not null, body jsonb not null,
 primary key(login,operation,resource,request_key)
);

create function purchase_api.authenticate(token_hash text) returns text
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare result text;
begin
 select s.login::text into result from purchase_api.http_session s
 join purchase_api.principal p on p.login=s.login
 where s.token_hash=authenticate.token_hash and not s.revoked and s.expires_at>clock_timestamp() and p.active;
 if not found then raise exception 'INVALID_SESSION' using errcode='28000'; end if;
 return result;
end $$;

create function purchase_api.http_actor(token_hash text, required text default null, locked boolean default false)
returns purchase_api.principal language plpgsql security definer
set search_path=pg_catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal; s purchase_api.http_session;
begin
 if locked then
  select * into s from purchase_api.http_session x where x.token_hash=http_actor.token_hash for share;
 else
  select * into s from purchase_api.http_session x where x.token_hash=http_actor.token_hash;
 end if;
 if s.login is null or s.login<>session_user or s.revoked or s.expires_at<=clock_timestamp() then
  raise exception 'INVALID_SESSION' using errcode='28000';
 end if;
 if locked then
  select * into p from purchase_api.principal x where x.login=s.login for share;
 else
  select * into p from purchase_api.principal x where x.login=s.login;
 end if;
 if not found or not p.active or (required is not null and p.actor<>required) then
  raise exception 'ACCESS_DENIED' using errcode='42501';
 end if;
 return p;
end $$;

create function purchase_api.checkout_json(q bigint) returns jsonb
language sql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
 select jsonb_build_object(
  'checkoutId',x.id::text,'quoteId',x.id::text,'amount',x.price::text,'currency','YER',
  'sku',jsonb_build_object('id',s.id::text,'name',s.name),
  'expiresAt',x.expires,'holdExpiresAt',h.expires,'holdStatus',h.state,
  'serverTime',clock_timestamp(),'orderId',o.id::text,
  'receipts',coalesce((select jsonb_agg(jsonb_build_object('receiptId',r.id::text,'amount',p.amount::text,
    'currency','YER','fulfilled',p.fulfilled)) from purchase.payment p join purchase_api.receipt r using(provider_ref)
    where p.quote_id=x.id),'[]'::jsonb))
 from purchase.quote x join purchase.offer f on f.id=x.offer_id join purchase.stock k on k.id=f.stock_id
 join purchase.sku s on s.id=k.sku_id left join purchase.hold h on h.quote_id=x.id
 left join purchase.purchase_order o on o.id=x.id where x.id=q
$$;

create function purchase_api.http_read(operation text,data jsonb,token_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal; final_p purchase_api.principal; q bigint; intent purchase_api.payment_intent;
 receipt_ref text; answer jsonb; replacement purchase.replacement; refund purchase_api.refund;
begin
 p:=purchase_api.http_actor(token_hash);
 if operation='payment/get' then
  if p.actor<>'customer' then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
  select * into intent from purchase_api.payment_intent where id=(data->>'attemptId')::uuid;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  perform purchase_api.own_quote(intent.quote_id);
  select jsonb_build_object('attemptId',intent.id::text,'checkoutId',intent.quote_id::text,
    'amount',intent.amount::text,'currency',intent.currency,'status',intent.status,'receiptId',r.id::text)
   into answer from (select 1) v left join purchase_api.receipt r on r.provider_ref=intent.provider_ref;
 else
  q:=(data->>'id')::bigint;
  if operation in ('checkout/get','resolution/get','order/get') then
   if p.actor<>'customer' then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
   perform purchase_api.own_quote(q);
   if operation='checkout/get' then answer:=purchase_api.checkout_json(q);
   elsif operation='order/get' then
    if not exists(select from purchase.purchase_order where id=q) then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
    select jsonb_build_object('orderId',q::text,'amount',i.price::text,'currency','YER',
      'sku',jsonb_build_object('id',s.id::text,'name',s.name),
      'pickedUp',exists(select from purchase.handoff where order_id=q and kind='pickup'),
      'delivered',exists(select from purchase.handoff where order_id=q and kind='delivered'))
     into answer from purchase.order_item i join purchase.stock k on k.id=i.stock_id
     join purchase.sku s on s.id=k.sku_id where i.order_id=q;
   else
    select r.provider_ref into receipt_ref from purchase_api.receipt r join purchase.payment t using(provider_ref)
     where r.id=(data->>'receiptId')::uuid and t.quote_id=q;
    if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
    select * into replacement from purchase.replacement where provider_ref=receipt_ref;
    select * into refund from purchase_api.refund where provider_ref=receipt_ref;
    answer:=jsonb_build_object('receiptId',data->>'receiptId','decision',
      case when replacement.original_quote is not null then 'replacement_accepted'
       when refund.id is not null and exists(select from purchase.unallocated_refund where provider_ref=receipt_ref and confirmation_ref is not null) then 'refunded'
       when refund.id is not null then 'refund_pending' else 'unresolved' end,
      'refundId',refund.id::text,'orderId',replacement.original_quote::text,
      'replacementQuoteId',replacement.replacement_quote::text);
   end if;
  elsif operation='merchant/get' then
   select jsonb_build_object('orderId',m.order_id::text,'amount',m.price::text,'supply',m.supply::text,
      'fee',m.fee::text,'payable',m.payable::text,'currency','YER') into answer from purchase_api.merchant_order(q) m;
  elsif operation='courier/get' then
   if p.actor<>'courier' then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
   perform 1 from purchase.merchant_share where order_id=q for share;
   perform 1 from purchase_api.courier_assignment where order_id=q and courier_login=session_user for share;
   if not found then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
   select jsonb_build_object('orderId',q::text,'destination',a.label,'city',a.city,
    'pickedUp',exists(select from purchase.handoff where order_id=q and kind='pickup'),
    'delivered',exists(select from purchase.handoff where order_id=q and kind='delivered'))
   into answer from purchase_api.quote_address qa join purchase_api.delivery_address a on a.id=qa.address_id where qa.quote_id=q;
  else raise exception 'UNKNOWN_OPERATION' using errcode='22023';
  end if;
 end if;
 final_p:=purchase_api.http_actor(token_hash,p.actor,true);
 if (final_p.customer_id,final_p.merchant_id) is distinct from (p.customer_id,p.merchant_id) then
  raise exception 'ACCESS_DENIED' using errcode='42501';
 end if;
 if answer is null then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
 return answer;
end $$;

create function purchase_api.http_execute(operation text,data jsonb,request_key text,fingerprint text,token_hash text)
returns table(status integer,body jsonb) language plpgsql security definer
set search_path=pg_catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal; final_p purchase_api.principal; q bigint; selected bigint;
 old purchase_api.http_idempotency; scope text; subject text; answer jsonb; result_status integer:=200;
 address purchase_api.delivery_address; offers bigint[]; intent purchase_api.payment_intent;
 receipt_ref text; refund purchase_api.refund; prior purchase.replacement; event_kind text; actual numeric;
begin
 p:=purchase_api.http_actor(token_hash);
 if nullif(request_key,'') is null or nullif(fingerprint,'') is null then
  raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode='22023';
 end if;
 scope:=coalesce(data->>'id','')||':'||coalesce(data->>'receiptId','')||':'||coalesce(data->>'attemptId','');
 subject:=p.actor||':'||coalesce(p.customer_id::text,'')||':'||coalesce(p.merchant_id::text,'');
 perform pg_advisory_xact_lock(hashtextextended(session_user||':'||operation||':'||scope||':'||request_key,0));
 select * into old from purchase_api.http_idempotency i where i.login=session_user
  and i.operation=http_execute.operation and i.resource=scope and i.request_key=http_execute.request_key;
 if found then
  if old.fingerprint<>fingerprint then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
  if old.subject<>subject then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
  -- A stored response still requires today's record ownership/assignment.
  if operation in ('checkout/reserve','payment/create','refund/create','replacement/create') then
   perform purchase_api.own_quote((data->>'id')::bigint);
  elsif operation='quote/create' then
   perform purchase_api.own_quote((old.body->>'quoteId')::bigint);
  elsif operation='handoff/create' then
   perform 1 from purchase.merchant_share where order_id=(data->>'id')::bigint for share;
   perform 1 from purchase_api.courier_assignment a where a.order_id=(data->>'id')::bigint and a.courier_login=session_user for share;
   if not found then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
  end if;
  final_p:=purchase_api.http_actor(token_hash,p.actor,true);
  if (final_p.customer_id,final_p.merchant_id) is distinct from (p.customer_id,p.merchant_id) then
   raise exception 'ACCESS_DENIED' using errcode='42501';
  end if;
  return query select old.status,old.body;
  return;
 end if;

 if operation='quote/create' then
  if p.actor<>'customer' then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
  if (data->>'quantity')::integer<>1 then raise exception 'INVALID_QUANTITY' using errcode='22023'; end if;
  select * into address from purchase_api.delivery_address a
   where a.id=(data->>'deliveryAddressId')::bigint and a.customer_id=p.customer_id;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  select array_agg(offer_id) into offers from purchase_api.eligible_offer;
  q:=nextval('purchase_api.http_quote_id');
  perform purchase.quote_handset(q,p.customer_id,(data->>'skuId')::bigint,coalesce(offers,'{}'::bigint[]));
  insert into purchase_api.quote_address values(q,address.id);
  answer:=purchase_api.checkout_json(q)-'checkoutId'-'holdExpiresAt'-'holdStatus'-'orderId'-'receipts';
  result_status:=201;
 elsif operation in ('checkout/reserve','payment/create','refund/create','replacement/create') then
  if p.actor<>'customer' then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
  q:=(data->>'id')::bigint;
  perform purchase_api.own_quote(q);
  if operation='checkout/reserve' then
   if not purchase_api.reserve(q) then
    if exists(select from purchase.quote where id=q and expires<=clock_timestamp()) then raise exception 'QUOTE_EXPIRED'; end if;
    raise exception 'OUT_OF_STOCK';
   end if;
   answer:=purchase_api.checkout_json(q);
  elsif operation='payment/create' then
   if exists(select from purchase.payment where quote_id=q) then raise exception 'PAYMENT_ALREADY_COLLECTED'; end if;
   select * into intent from purchase_api.payment_intent i
    where i.quote_id=q and i.status in ('initiated','pending','unknown') for update;
   if not found then
    if exists(select from purchase.quote where id=q and expires<=clock_timestamp()) then raise exception 'QUOTE_EXPIRED'; end if;
    if not exists(select from purchase.hold where quote_id=q and state='held' and expires>clock_timestamp()) then
     raise exception 'HOLD_EXPIRED';
    end if;
    insert into purchase_api.payment_intent(quote_id,amount,currency)
     select id,price,'YER' from purchase.quote where id=q returning * into intent;
    insert into purchase_api.http_outbox(kind,resource_id,provider_key)
     values('payment',intent.id,'payment:'||intent.id::text);
   end if;
   answer:=jsonb_build_object('attemptId',intent.id::text,'status',intent.status,
    'statusUrl','/v1/payment-attempts/'||intent.id::text,'amount',intent.amount::text,'currency',intent.currency);
   result_status:=202;
  else
   select r.provider_ref into receipt_ref from purchase_api.receipt r join purchase.payment t using(provider_ref)
    where r.id=(data->>'receiptId')::uuid and t.quote_id=q;
   if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
   if operation='refund/create' then
    if exists(select from purchase.replacement where provider_ref=receipt_ref) then raise exception 'DECISION_ALREADY_COMMITTED'; end if;
    perform purchase_api.request_unallocated_refund(q,receipt_ref);
    insert into purchase_api.refund(provider_ref) values(receipt_ref)
     on conflict(provider_ref) do nothing;
    select * into refund from purchase_api.refund where provider_ref=receipt_ref;
    insert into purchase_api.http_outbox(kind,resource_id,provider_key)
     values('refund',refund.id,'refund:'||receipt_ref) on conflict(provider_key) do nothing;
    answer:=jsonb_build_object('refundId',refund.id::text,'receiptId',data->>'receiptId','status',
     case when exists(select from purchase.unallocated_refund where provider_ref=receipt_ref and confirmation_ref is not null)
      then 'confirmed' else 'pending' end);
    result_status:=202;
   else
    selected:=(data->>'replacementQuoteId')::bigint;
    select * into prior from purchase.replacement where original_quote=q;
    if prior.original_quote is not null and (prior.provider_ref<>receipt_ref or prior.replacement_quote<>selected) then
     raise exception 'DECISION_ALREADY_COMMITTED';
    end if;
    if exists(select from purchase.unallocated_refund where provider_ref=receipt_ref) then raise exception 'DECISION_ALREADY_COMMITTED'; end if;
    perform purchase_api.accept_replacement(q,selected);
    answer:=jsonb_build_object('decisionId','replacement:'||q::text,'receiptId',data->>'receiptId',
     'orderId',q::text,'replacementQuoteId',selected::text);
   end if;
  end if;
 elsif operation='handoff/create' then
  if p.actor<>'courier' then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
  q:=(data->>'id')::bigint;
  event_kind:=data->>'kind';
  if not exists(select from purchase_api.handoff_proof hp where hp.order_id=q and hp.kind=event_kind
    and hp.token_hash=encode(sha256(convert_to(data->>'proofToken','UTF8')),'hex') and expires_at>clock_timestamp()) then
   raise exception 'INVALID_PROOF' using errcode='42501';
  end if;
  perform purchase_api.record_handoff(q,event_kind,'proof:'||encode(sha256(convert_to(data->>'proofToken','UTF8')),'hex'));
  answer:=jsonb_build_object('orderId',q::text,'kind',event_kind,'recorded',true);
 elsif operation='provider/event' then
  if p.actor<>'service' then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
  if data->>'currency'<>'YER' then raise exception 'CURRENCY_MISMATCH' using errcode='22023'; end if;
  event_kind:=data->>'type';
  if event_kind='payment' then
   select * into intent from purchase_api.payment_intent where id=(data->>'attemptId')::uuid;
   if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
   perform 1 from purchase.quote where id=intent.quote_id for update;
   select * into intent from purchase_api.payment_intent where id=intent.id for update;
   actual:=(data->>'amount')::numeric;
   if actual is distinct from intent.amount or data->>'currency' is distinct from intent.currency then
    raise exception 'AMOUNT_MISMATCH' using errcode='22023';
   end if;
   perform purchase_api.capture(intent.quote_id,data->>'providerRef',data->>'eventId',actual,(data->>'paidAt')::timestamptz);
   insert into purchase_api.receipt(provider_ref) values(data->>'providerRef') on conflict(provider_ref) do nothing;
   update purchase_api.payment_intent set status='collected',provider_ref=coalesce(provider_ref,data->>'providerRef') where id=intent.id;
   update purchase_api.http_outbox set state='completed',lease_until=null,last_provider_status='succeeded',last_checked_at=clock_timestamp()
    where kind='payment' and resource_id=intent.id;
  elsif event_kind='refund' then
   select * into refund from purchase_api.refund where id=(data->>'refundId')::uuid;
   if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
   select t.quote_id,t.amount into q,actual from purchase.payment t where t.provider_ref=refund.provider_ref;
   perform 1 from purchase.quote where id=q for update;
   select r.* into refund from purchase_api.refund r where r.id=refund.id for update;
   if actual is distinct from (data->>'amount')::numeric then raise exception 'AMOUNT_MISMATCH' using errcode='22023'; end if;
   perform purchase_api.confirm_unallocated_refund(refund.provider_ref,data->>'receiptRef',actual);
   update purchase_api.http_outbox set state='completed',lease_until=null,last_provider_status='succeeded',last_checked_at=clock_timestamp()
    where kind='refund' and resource_id=refund.id;
  else raise exception 'INVALID_EVENT' using errcode='22023';
  end if;
  answer:=jsonb_build_object('accepted',true);
 else raise exception 'UNKNOWN_OPERATION' using errcode='22023';
 end if;
 final_p:=purchase_api.http_actor(token_hash,p.actor,true);
 if (final_p.customer_id,final_p.merchant_id) is distinct from (p.customer_id,p.merchant_id) then
  raise exception 'ACCESS_DENIED' using errcode='42501';
 end if;
 insert into purchase_api.http_idempotency values(session_user,operation,scope,request_key,fingerprint,result_status,answer,subject);
 return query select result_status,answer;
end $$;

alter table purchase_api.http_idempotency add column subject text not null;

create function purchase_api.next_http_job(token_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare job purchase_api.http_outbox; intent purchase_api.payment_intent; refund purchase_api.refund;
 answer jsonb; amount numeric; expired record;
begin
 perform purchase_api.http_actor(token_hash,'service');
 for expired in select q.id from purchase.quote q join purchase.hold h on h.quote_id=q.id
   where h.state='held' and h.expires<=clock_timestamp() order by q.id for update of q skip locked limit 100
 loop
  perform purchase.release_expired(expired.id);
 end loop;
 select * into job from purchase_api.http_outbox
  where state in ('pending','dispatched') and (lease_until is null or lease_until<clock_timestamp())
  order by id for update skip locked limit 1;
 if not found then
  perform purchase_api.http_actor(token_hash,'service',true);
  return null;
 end if;
 update purchase_api.http_outbox set lease_until=clock_timestamp()+interval '30 seconds',attempts=attempts+1 where id=job.id;
 if job.kind='payment' then
  select * into strict intent from purchase_api.payment_intent where id=job.resource_id;
  answer:=jsonb_build_object('jobId',job.id::text,'kind',job.kind,'action',case when job.state='pending' then 'send' else 'reconcile' end,'attemptId',intent.id::text,
   'providerKey',job.provider_key,'amount',intent.amount::text,'currency',intent.currency);
 else
  select * into strict refund from purchase_api.refund where id=job.resource_id;
  select p.amount into strict amount from purchase.payment p where p.provider_ref=refund.provider_ref;
  answer:=jsonb_build_object('jobId',job.id::text,'kind',job.kind,'action',case when job.state='pending' then 'send' else 'reconcile' end,'refundId',refund.id::text,
   'providerRef',refund.provider_ref,'providerKey',job.provider_key,'amount',amount::text,'currency','YER');
 end if;
 perform purchase_api.http_actor(token_hash,'service',true);
 return answer;
end $$;

-- Match callback lock ordering: quote, intent/refund, then outbox. The worker
-- never holds these locks across a provider request.
create function purchase_api.finish_http_job(job_id uuid,token_hash text) returns void
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare job purchase_api.http_outbox; q bigint;
begin
 perform purchase_api.http_actor(token_hash,'service');
 select * into strict job from purchase_api.http_outbox where id=job_id;
 if job.kind='payment' then
  select quote_id into strict q from purchase_api.payment_intent where id=job.resource_id;
 else
  select p.quote_id into strict q from purchase_api.refund r join purchase.payment p using(provider_ref)
   where r.id=job.resource_id;
 end if;
 perform 1 from purchase.quote where id=q for update;
 if job.kind='payment' then
  perform 1 from purchase_api.payment_intent where id=job.resource_id for update;
 else
  perform 1 from purchase_api.refund where id=job.resource_id for update;
 end if;
 select * into strict job from purchase_api.http_outbox where id=job_id for update;
 if job.state<>'completed' then
  update purchase_api.http_outbox set state='dispatched',lease_until=clock_timestamp()+interval '30 seconds' where id=job_id;
  if job.kind='payment' then
   update purchase_api.payment_intent set status='pending' where id=job.resource_id and status='initiated';
  end if;
 end if;
 perform purchase_api.http_actor(token_hash,'service',true);
end $$;

create function purchase_api.record_http_status(job_id uuid,provider_status text,token_hash text) returns void
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare job purchase_api.http_outbox; q bigint;
begin
 perform purchase_api.http_actor(token_hash,'service');
 if provider_status not in ('pending','unknown','failed') or provider_status is null then
  raise exception 'INVALID_PROVIDER_STATUS' using errcode='22023';
 end if;
 select * into strict job from purchase_api.http_outbox where id=job_id;
 if job.kind='payment' then
  select quote_id into strict q from purchase_api.payment_intent where id=job.resource_id;
 else
  select p.quote_id into strict q from purchase_api.refund r join purchase.payment p using(provider_ref)
   where r.id=job.resource_id;
 end if;
 perform 1 from purchase.quote where id=q for update;
 if job.kind='payment' then
  perform 1 from purchase_api.payment_intent where id=job.resource_id for update;
 else
  perform 1 from purchase_api.refund where id=job.resource_id for update;
 end if;
 select * into strict job from purchase_api.http_outbox where id=job_id for update;
 if job.state<>'completed' then
  update purchase_api.http_outbox set last_provider_status=provider_status,last_checked_at=clock_timestamp() where id=job_id;
  if job.kind='payment' then
   update purchase_api.payment_intent set status=provider_status
    where id=job.resource_id and status<>'collected';
   update purchase_api.http_outbox set state=case when provider_status='failed' then 'completed' else 'dispatched' end,
    lease_until=case when provider_status='failed' then null else clock_timestamp()+interval '30 seconds' end where id=job_id;
  else
   -- An externally failed refund keeps the customer's chosen refund decision.
   -- It remains discoverable for reconciliation under its original key.
   update purchase_api.http_outbox set state='dispatched',lease_until=clock_timestamp()+interval '30 seconds' where id=job_id;
  end if;
 end if;
 perform purchase_api.http_actor(token_hash,'service',true);
end $$;

revoke all on all tables in schema purchase_api from public;
revoke all on all sequences in schema purchase_api from public;
revoke all on all functions in schema purchase_api from public;
commit;
