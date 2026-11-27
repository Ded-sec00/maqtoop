-- Additive Stage A migration. Apply once after accounts.sql in an isolated database.
begin;
create schema catalog;
revoke all on schema catalog from public;
alter table purchase.branch add constraint catalog_branch_owner unique(id,merchant_id);
create table purchase_api.principal_branch(
 login name not null references purchase_api.principal,
 branch_id bigint not null references purchase.branch,
 primary key(login,branch_id)
);
create table catalog.submission(
 id uuid primary key default gen_random_uuid(),
 merchant_id bigint not null references purchase.merchant,
 branch_id bigint not null,
 created_by name not null references purchase_api.principal,
 state text not null default 'draft' check(state in ('draft','pending_review','changes_requested','rejected','withdrawn')),
 version integer not null default 1 check(version>0),
 current_revision integer not null default 1 check(current_revision>0),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(branch_id,merchant_id) references purchase.branch(id,merchant_id)
);
create table catalog.submission_revision(
 submission_id uuid not null references catalog.submission,
 revision_number integer not null check(revision_number>0),
 content jsonb not null check(jsonb_typeof(content)='object'),
 created_at timestamptz not null default clock_timestamp(),
 primary key(submission_id,revision_number)
);
alter table catalog.submission add foreign key(id,current_revision)
 references catalog.submission_revision(submission_id,revision_number) deferrable initially deferred;
create table catalog.review_decision(
 submission_id uuid not null,
 revision_number integer not null,
 decision text not null check(decision in ('request_changes','reject')),
 reason text not null check(length(btrim(reason)) between 1 and 2000),
 reviewer name not null references purchase_api.principal,
 decided_at timestamptz not null default clock_timestamp(),
 primary key(submission_id,revision_number),
 foreign key(submission_id,revision_number) references catalog.submission_revision
);
create table catalog.media_asset(
 id uuid primary key default gen_random_uuid(),
 owner_login name not null references purchase_api.principal,
 merchant_id bigint not null references purchase.merchant,
 branch_id bigint not null,
 content_type text not null check(content_type in ('image/png','image/jpeg')),
 content bytea not null check(octet_length(content) between 1 and 5242880),
 checksum text not null check(checksum ~ '^[a-f0-9]{64}$'),
 state text not null default 'private' check(state='private'),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(branch_id,merchant_id) references purchase.branch(id,merchant_id)
);
create table catalog.request_result(
 login name not null references purchase_api.principal,
 operation text not null, resource text not null, request_key text not null,
 fingerprint text not null, status integer not null, body jsonb not null,
 primary key(login,operation,resource,request_key)
);
create table catalog.audit_event(
 id bigint generated always as identity primary key,
 actor name not null references purchase_api.principal,
 operation text not null, resource text not null,
 from_version integer, to_version integer,
 request_key text not null, recorded_at timestamptz not null default clock_timestamp()
);
create function catalog.immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'catalog history is immutable' using errcode='23514'; end $$;
create trigger immutable_revision before update or delete on catalog.submission_revision for each row execute function catalog.immutable();
create trigger immutable_decision before update or delete on catalog.review_decision for each row execute function catalog.immutable();
create trigger immutable_audit before update or delete on catalog.audit_event for each row execute function catalog.immutable();
create trigger immutable_media before update or delete on catalog.media_asset for each row execute function catalog.immutable();

create function catalog.branch_access(p purchase_api.principal,bid bigint,locked boolean default false)
returns void language plpgsql set search_path=pg_catalog,catalog,pg_temp as $$
begin
 if p.actor='admin' then return; end if;
 if p.actor<>'merchant' or not exists(select from purchase.branch b where b.id=bid and b.merchant_id=p.merchant_id) then
  raise exception 'ACCESS_DENIED' using errcode='42501';
 end if;
 if locked then
  perform 1 from purchase_api.principal_branch where login=p.login and branch_id=bid for share;
 else perform 1 from purchase_api.principal_branch where login=p.login and branch_id=bid; end if;
 if not found then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
end $$;

create function catalog.validate_content(data jsonb,p purchase_api.principal,bid bigint)
returns jsonb language plpgsql set search_path=pg_catalog,catalog,pg_temp as $$
declare k text; item jsonb; asset uuid;
begin
 if jsonb_typeof(data)<>'object' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if exists(select from jsonb_object_keys(data) as fields(field_name) where fields.field_name not in
  ('category','condition','brand','model','storageGb','ramGb','color','suggestedTitle','description','supplyAmount','currency','initialQuantity','proposedWarranty','mediaAssetIds')) then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 if data->>'category' is distinct from 'phone' or data->>'condition' is distinct from 'new' or data->>'currency' is distinct from 'YER' then
  raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 foreach k in array array['brand','model','color','suggestedTitle','description'] loop
  if jsonb_typeof(data->k) is distinct from 'string' or length(btrim(data->>k))<1 or length(data->>k)>(case when k='description' then 4000 else 200 end) then
   raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 end loop;
 foreach k in array array['storageGb','ramGb','initialQuantity'] loop
  if jsonb_typeof(data->k) is distinct from 'number' or (data->>k)!~'^[1-9][0-9]{0,8}$' then
   raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 end loop;
 if jsonb_typeof(data->'supplyAmount') is distinct from 'string' or (data->>'supplyAmount')!~'^(0|[1-9][0-9]{0,17})(\.[0-9]{1,8})?$'
  or (data->>'supplyAmount')::numeric<=0 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if data ? 'proposedWarranty' and (jsonb_typeof(data->'proposedWarranty')<>'string' or length(data->>'proposedWarranty')>2000) then
  raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if not data ? 'mediaAssetIds' then data:=data||'{"mediaAssetIds":[]}'::jsonb; end if;
 if jsonb_typeof(data->'mediaAssetIds')<>'array' or jsonb_array_length(data->'mediaAssetIds')>10 then
  raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if (select count(*) from jsonb_array_elements(data->'mediaAssetIds'))<>(select count(distinct x) from jsonb_array_elements(data->'mediaAssetIds') x) then
  raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 for item in select * from jsonb_array_elements(data->'mediaAssetIds') loop
  if jsonb_typeof(item)<>'string' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  asset:=(item#>>'{}')::uuid;
  if not exists(select from catalog.media_asset m where m.id=asset and m.owner_login=p.login and m.branch_id=bid and m.merchant_id=p.merchant_id) then
   raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
 end loop;
 return data||jsonb_build_object('proposedWarranty',coalesce(data->>'proposedWarranty',''));
end $$;

create function catalog.submission_json(sid uuid) returns jsonb language sql set search_path=pg_catalog,catalog,pg_temp as $$
 select jsonb_build_object('id',s.id::text,'branchId',s.branch_id::text,'state',s.state,'version',s.version,'revision',s.current_revision,
  'content',r.content,'publicationEnabled',false,'missingDependencies',jsonb_build_array('sale_price_policy','warranty_policy'),
  'reviews',coalesce((select jsonb_agg(jsonb_build_object('revision',d.revision_number,'decision',d.decision,'reason',d.reason) order by d.revision_number)
   from catalog.review_decision d where d.submission_id=s.id),'[]'::jsonb))
 from catalog.submission s join catalog.submission_revision r on r.submission_id=s.id and r.revision_number=s.current_revision where s.id=sid;
$$;

create function purchase_api.catalog_write(operation text,data jsonb,token_hash text,request_key text,fingerprint text,image_bytes bytea default null)
returns table(status integer,body jsonb) language plpgsql security definer set search_path=pg_catalog,catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal; required text; s catalog.submission; saved catalog.request_result; bid bigint; sid uuid;
 content jsonb; from_version integer; result jsonb; result_status integer:=200; resource_key text; decision text; mid uuid;
begin
 required:=case when operation='review/decision' then 'admin' else 'merchant' end;
 p:=purchase_api.http_actor(token_hash,required);
 if operation not in ('draft/create','draft/update','draft/submit','draft/withdraw','review/decision','media/create') then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
 if jsonb_typeof(data)<>'object' or request_key is null or request_key!~'^[A-Za-z0-9:._-]{1,200}$' or fingerprint is null or fingerprint!~'^[a-f0-9]{64}$' then
  raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 resource_key:=coalesce(data->>'id','new');
 perform pg_advisory_xact_lock(hashtextextended(session_user::text||'|catalog|'||operation||'|'||resource_key||'|'||request_key,0));
 if operation in ('draft/create','media/create') then
  if jsonb_typeof(data->'branchId') is distinct from 'string' or (data->>'branchId')!~'^[1-9][0-9]{0,18}$' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  bid:=(data->>'branchId')::bigint;
 else
  sid:=(data->>'id')::uuid;
  select * into s from catalog.submission where id=sid for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  bid:=s.branch_id;
 end if;
 -- Last check is after both idempotency and resource locks, including cached responses.
 p:=purchase_api.http_actor(token_hash,required,true);
 perform catalog.branch_access(p,bid,true);
 if s.id is not null and p.actor='merchant' and (s.created_by<>p.login or s.merchant_id<>p.merchant_id) then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
 select * into saved from catalog.request_result r where r.login=session_user and r.operation=catalog_write.operation and r.resource=resource_key and r.request_key=catalog_write.request_key;
 if found then
  if saved.fingerprint<>fingerprint then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
  return query select saved.status,saved.body;return;
 end if;
 if operation='media/create' then
  if data - array['branchId','contentType'] <> '{}'::jsonb or data->>'contentType' not in ('image/png','image/jpeg') or image_bytes is null or octet_length(image_bytes) not between 1 and 5242880 then
   raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  insert into catalog.media_asset(owner_login,merchant_id,branch_id,content_type,content,checksum)
   values(p.login,p.merchant_id,bid,data->>'contentType',image_bytes,encode(sha256(image_bytes),'hex')) returning id into mid;
  sid:=mid;result:=jsonb_build_object('assetId',mid::text,'state','private');result_status:=201;
 elsif operation='draft/create' then
  content:=catalog.validate_content(data-'branchId',p,bid);
  insert into catalog.submission(merchant_id,branch_id,created_by) values(p.merchant_id,bid,p.login) returning id into sid;
  insert into catalog.submission_revision values(sid,1,content,clock_timestamp());result_status:=201;
 else
  if jsonb_typeof(data->'expectedVersion') is distinct from 'number' or (data->>'expectedVersion')!~'^[1-9][0-9]{0,8}$' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  if s.version<>(data->>'expectedVersion')::integer then raise exception 'CATALOG_VERSION_CONFLICT'; end if;
  from_version:=s.version;
  if operation='draft/update' then
   if s.state not in ('draft','changes_requested','withdrawn') then raise exception 'CATALOG_STATE_CONFLICT'; end if;
   content:=catalog.validate_content(data-array['id','expectedVersion','branchId'],p,bid);
   if data ? 'branchId' and data->>'branchId'<>bid::text then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
   insert into catalog.submission_revision values(sid,s.current_revision+1,content,clock_timestamp());
   update catalog.submission set current_revision=current_revision+1,state='draft',version=version+1 where id=sid;
  elsif operation='draft/submit' then
   if data-array['id','expectedVersion']<>'{}'::jsonb then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
   if s.state<>'draft' then raise exception 'CATALOG_STATE_CONFLICT'; end if;
   -- Recheck private asset ownership at submission as well.
   perform catalog.validate_content(r.content,p,bid) from catalog.submission_revision r where r.submission_id=sid and r.revision_number=s.current_revision;
   update catalog.submission set state='pending_review',version=version+1 where id=sid;
  elsif operation='draft/withdraw' then
   if data-array['id','expectedVersion']<>'{}'::jsonb then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
   if s.state<>'pending_review' then raise exception 'CATALOG_STATE_CONFLICT'; end if;
   update catalog.submission set state='withdrawn',version=version+1 where id=sid;
  elsif operation='review/decision' then
   if data-array['id','expectedVersion','expectedRevision','decision','reason']<>'{}'::jsonb or jsonb_typeof(data->'expectedRevision') is distinct from 'number' or
    (data->>'expectedRevision')!~'^[1-9][0-9]{0,8}$' or jsonb_typeof(data->'decision') is distinct from 'string' or jsonb_typeof(data->'reason') is distinct from 'string' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
   if s.current_revision<>(data->>'expectedRevision')::integer or s.state<>'pending_review' then raise exception 'CATALOG_STATE_CONFLICT'; end if;
   decision:=data->>'decision';
   if decision='approve' then raise exception 'CATALOG_POLICY_NOT_CONFIGURED'; end if;
   if decision not in ('request_changes','reject') or length(btrim(data->>'reason')) not between 1 and 2000 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
   insert into catalog.review_decision values(sid,s.current_revision,decision,data->>'reason',p.login,clock_timestamp());
   update catalog.submission set state=case when decision='reject' then 'rejected' else 'changes_requested' end,version=version+1 where id=sid;
  end if;
 end if;
 if result is null then result:=catalog.submission_json(sid); end if;
 insert into catalog.audit_event(actor,operation,resource,from_version,to_version,request_key)
  values(p.login,operation,sid::text,from_version,(result->>'version')::integer,request_key);
 insert into catalog.request_result values(p.login,operation,resource_key,request_key,fingerprint,result_status,result);
 return query select result_status,result;
end $$;

create function purchase_api.catalog_read(operation text,data jsonb,token_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal; s catalog.submission; m catalog.media_asset; required text; result jsonb;
 cursor_id uuid; cursor_created timestamptz; more boolean;
begin
 required:=case when operation like 'review/%' then 'admin' when operation='public/list' then 'customer' else 'merchant' end;
 p:=purchase_api.http_actor(token_hash,required,true);
 if operation='public/list' then return jsonb_build_object('items','[]'::jsonb,'publicationEnabled',false); end if;
 if operation='media/preflight' then perform catalog.branch_access(p,(data->>'branchId')::bigint,true);return '{}'::jsonb;end if;
 if operation='review/list' then
  cursor_id:=(data->>'cursor')::uuid;
  if cursor_id is not null then
   select created_at into cursor_created from catalog.submission where id=cursor_id;
   if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
  end if;
  select coalesce(jsonb_agg(catalog.submission_json(x.id) order by x.created_at,x.id),'[]'::jsonb) into result
   from (select id,created_at from catalog.submission where state='pending_review'
    and (cursor_id is null or (created_at,id)>(cursor_created,cursor_id)) order by created_at,id limit 101) x;
  more:=jsonb_array_length(result)>100;
  if more then result:=result-100;end if;
  return jsonb_build_object('items',result,'hasMore',more,'nextCursor',case when more then result->99->>'id' else null end);
 elsif operation in ('draft/get','review/get') then
  select * into s from catalog.submission where id=(data->>'id')::uuid;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  perform catalog.branch_access(p,s.branch_id,true);
  if p.actor='merchant' and (s.created_by<>p.login or s.merchant_id<>p.merchant_id) then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
  return catalog.submission_json(s.id);
 elsif operation in ('media/get','review/media') then
  select * into m from catalog.media_asset where id=(data->>'id')::uuid;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  perform catalog.branch_access(p,m.branch_id,true);
  if p.actor='merchant' and (m.owner_login<>p.login or m.merchant_id<>p.merchant_id) then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
  return jsonb_build_object('contentType',m.content_type,'bytes',encode(m.content,'base64'));
 else raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
end $$;
revoke all on all tables in schema catalog from public;
revoke all on all functions in schema catalog from public;
revoke all on purchase_api.principal_branch from public;
revoke all on function purchase_api.catalog_read(text,jsonb,text) from public;
revoke all on function purchase_api.catalog_write(text,jsonb,text,text,text,bytea) from public;
commit;
