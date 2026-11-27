-- Additive migration after catalog_drafts.sql. Existing grants remain active.
begin;
alter table purchase_api.principal_branch add column active boolean not null default true;
alter table purchase_api.principal_branch add column version integer not null default 1 check(version>0);
create table catalog.branch_access_audit(
 id bigint generated always as identity primary key,
 actor name not null references purchase_api.principal,
 target_account uuid not null references purchase_api.account,
 target_login name not null references purchase_api.principal,
 branch_id bigint not null references purchase.branch,
 action text not null check(action in ('grant','revoke')),
 reason text not null check(length(btrim(reason)) between 1 and 2000),
 from_version integer not null, to_version integer not null,
 request_key text not null, recorded_at timestamptz not null default clock_timestamp()
);
create trigger immutable_branch_access_audit before update or delete on catalog.branch_access_audit
 for each row execute function catalog.immutable();

create or replace function catalog.branch_access(p purchase_api.principal,bid bigint,locked boolean default false)
returns void language plpgsql set search_path=pg_catalog,catalog,pg_temp as $$
begin
 if p.actor='admin' then return; end if;
 if p.actor<>'merchant' or not exists(select from purchase.branch b where b.id=bid and b.merchant_id=p.merchant_id) then
  raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
 if locked then
  perform 1 from purchase_api.principal_branch where login=p.login and branch_id=bid and active for share;
 else perform 1 from purchase_api.principal_branch where login=p.login and branch_id=bid and active; end if;
 if not found then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
end $$;

create function purchase_api.branch_access_read(operation text,data jsonb,token_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,catalog,purchase_api,pg_temp as $$
declare a purchase_api.account; p purchase_api.principal; items jsonb; more boolean; cursor_id bigint;
begin
 perform purchase_api.http_actor(token_hash,'admin',true);
 if operation<>'access/list' then raise exception 'ACCESS_DENIED' using errcode='42501';end if;
 if data-array['accountId','cursor']<>'{}'::jsonb then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into a from purchase_api.account where id=(data->>'accountId')::uuid for share;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select * into p from purchase_api.principal where login=a.principal_login for share;
 if p.actor<>'merchant' then raise exception 'BRANCH_TARGET_NOT_ELIGIBLE';end if;
 cursor_id:=coalesce((data->>'cursor')::bigint,0);
 select coalesce(jsonb_agg(jsonb_build_object('branchId',b.id::text,'active',coalesce(g.active,false),'version',coalesce(g.version,0)) order by b.id),'[]'::jsonb)
 into items from (select * from purchase.branch where merchant_id=p.merchant_id and id>cursor_id order by id limit 101) b
 left join purchase_api.principal_branch g on g.login=p.login and g.branch_id=b.id;
 more:=jsonb_array_length(items)>100;if more then items:=items-100;end if;
 return jsonb_build_object('accountId',a.id::text,'items',items,'hasMore',more,'nextCursor',case when more then items->99->>'branchId' else null end);
end $$;

create function purchase_api.branch_access_write(operation text,data jsonb,token_hash text,request_key text,fingerprint text)
returns table(status integer,body jsonb) language plpgsql security definer set search_path=pg_catalog,catalog,purchase_api,pg_temp as $$
declare actor purchase_api.principal; target purchase_api.principal; a purchase_api.account;
 saved catalog.request_result; bid bigint; resource_key text; previous integer; result jsonb; enabled boolean;
begin
 actor:=purchase_api.http_actor(token_hash,'admin');
 if operation not in ('access/grant','access/revoke') then raise exception 'ACCESS_DENIED' using errcode='42501';end if;
 if jsonb_typeof(data) is distinct from 'object' or data-array['accountId','branchId','expectedVersion','reason']<>'{}'::jsonb
 or jsonb_typeof(data->'expectedVersion') is distinct from 'number' or (data->>'expectedVersion')!~'^(0|[1-9][0-9]{0,8})$'
 or jsonb_typeof(data->'reason') is distinct from 'string' or length(btrim(data->>'reason')) not between 1 and 2000
 or request_key is null or request_key!~'^[A-Za-z0-9:._-]{1,200}$' or fingerprint is null or fingerprint!~'^[a-f0-9]{64}$'
 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 bid:=(data->>'branchId')::bigint;resource_key:=(data->>'accountId')||'/'||bid::text;
 perform pg_advisory_xact_lock(hashtextextended(session_user::text||'|branch-access|'||operation||'|'||resource_key||'|'||request_key,0));
 select * into a from purchase_api.account where id=(data->>'accountId')::uuid;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 perform pg_advisory_xact_lock(hashtextextended('branch-permission|'||a.principal_login::text||'|'||bid::text,0));
 -- No authority is retained across either wait, even for a cached response.
 actor:=purchase_api.http_actor(token_hash,'admin',true);
 select * into a from purchase_api.account where id=(data->>'accountId')::uuid for share;
 select * into target from purchase_api.principal where login=a.principal_login for share;
 if target.actor<>'merchant' then raise exception 'BRANCH_TARGET_NOT_ELIGIBLE';end if;
 perform 1 from purchase.branch where id=bid for share;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if not exists(select from purchase.branch where id=bid and merchant_id=target.merchant_id) then
  raise exception 'ACCESS_DENIED' using errcode='42501';end if;
 select * into saved from catalog.request_result r where r.login=session_user and r.operation=branch_access_write.operation and r.resource=resource_key and r.request_key=branch_access_write.request_key;
 if found then
  if saved.fingerprint<>fingerprint then raise exception 'IDEMPOTENCY_KEY_REUSED';end if;
  return query select saved.status,saved.body;return;
 end if;
 enabled:=operation='access/grant';
 if enabled and (not a.active or not target.active) then raise exception 'BRANCH_TARGET_NOT_ELIGIBLE';end if;
 select version into previous from purchase_api.principal_branch where login=target.login and branch_id=bid for update;
 previous:=coalesce(previous,0);
 if previous<>(data->>'expectedVersion')::integer then raise exception 'BRANCH_VERSION_CONFLICT';end if;
 insert into purchase_api.principal_branch(login,branch_id,active,version) values(target.login,bid,enabled,previous+1)
 on conflict(login,branch_id) do update set active=excluded.active,version=excluded.version;
 result:=jsonb_build_object('accountId',a.id::text,'branchId',bid::text,'active',enabled,'version',previous+1);
 insert into catalog.branch_access_audit(actor,target_account,target_login,branch_id,action,reason,from_version,to_version,request_key)
 values(actor.login,a.id,target.login,bid,case when enabled then 'grant' else 'revoke' end,data->>'reason',previous,previous+1,request_key);
 insert into catalog.request_result values(actor.login,operation,resource_key,request_key,fingerprint,200,result);
 return query select 200,result;
end $$;
revoke all on catalog.branch_access_audit from public;
revoke all on function purchase_api.branch_access_read(text,jsonb,text) from public;
revoke all on function purchase_api.branch_access_write(text,jsonb,text,text,text) from public;
commit;
