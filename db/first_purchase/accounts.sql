-- Accounts migration for the first API. Apply once after http.sql.
begin;
alter table purchase_api.principal drop constraint principal_actor_check;
alter table purchase_api.principal drop constraint principal_check;
alter table purchase_api.principal add constraint principal_actor_check
 check(actor in ('customer','merchant','courier','service','admin'));
alter table purchase_api.principal add constraint principal_check
 check ((actor='customer' and customer_id is not null and merchant_id is null)
 or (actor='merchant' and merchant_id is not null and customer_id is null)
 or (actor in ('courier','service','admin') and customer_id is null and merchant_id is null));
alter table purchase_api.principal add column identity_id uuid not null default gen_random_uuid() unique;
create table purchase_api.account (
 id uuid primary key default gen_random_uuid(),
 login_name text not null unique check(login_name=lower(btrim(login_name)) and login_name ~ '^[a-z0-9][a-z0-9._+@-]{2,79}$'),
 principal_login name not null unique references purchase_api.principal,
 password_hash text not null check(length(password_hash)>0),
 password_version integer not null default 1 check(password_version>0),
 active boolean not null default true,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
create function purchase_api.account_identity_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
begin
 if not exists(select from purchase_api.principal where login=new.principal_login and actor<>'service') then
  raise exception 'INVALID_ACCOUNT_IDENTITY' using errcode='23514';
 end if;
 return new;
end $$;
create trigger human_account_identity before insert or update of principal_login on purchase_api.account
for each row execute function purchase_api.account_identity_guard();
alter table purchase_api.http_session add column account_id uuid references purchase_api.account;
alter table purchase_api.http_session add column password_version integer;
alter table purchase_api.http_session add constraint session_account_version
 check((account_id is null and password_version is null) or (account_id is not null and password_version is not null));
-- Previously provisioned human sessions cannot bypass account lifecycle checks.
update purchase_api.http_session s set revoked=true from purchase_api.principal p
 where p.login=s.login and p.actor<>'service' and s.account_id is null;
create table purchase_api.login_throttle (
 throttle_key text primary key check(throttle_key ~ '^[0-9a-f]{64}$'),
 attempts integer not null check(attempts>0),
 window_start timestamptz not null
);

create or replace function purchase_api.authenticate(token_hash text) returns text
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare result text;
begin
 select s.login::text into result from purchase_api.http_session s
 join purchase_api.principal p on p.login=s.login
 left join purchase_api.account a on a.id=s.account_id
 where s.token_hash=authenticate.token_hash and not s.revoked and s.expires_at>clock_timestamp() and p.active
 and ((s.account_id is null and p.actor='service') or (a.active and a.principal_login=s.login and a.password_version=s.password_version));
 if not found then raise exception 'INVALID_SESSION' using errcode='28000'; end if;
 return result;
end $$;

create or replace function purchase_api.http_actor(token_hash text,required text default null,locked boolean default false)
returns purchase_api.principal language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal; s purchase_api.http_session; a purchase_api.account;
begin
 if locked then
  select * into s from purchase_api.http_session x where x.token_hash=http_actor.token_hash for share;
 else select * into s from purchase_api.http_session x where x.token_hash=http_actor.token_hash;
 end if;
 if s.login is null or s.login<>session_user or s.revoked or s.expires_at<=clock_timestamp() then
  raise exception 'INVALID_SESSION' using errcode='28000';
 end if;
 if locked then
  select * into p from purchase_api.principal x where x.login=s.login for share;
 else select * into p from purchase_api.principal x where x.login=s.login;
 end if;
 if not found or not p.active or (required is not null and p.actor<>required) then
  raise exception 'ACCESS_DENIED' using errcode='42501';
 end if;
 if s.account_id is null and p.actor<>'service' then
  raise exception 'INVALID_SESSION' using errcode='28000';
 end if;
 if s.account_id is not null then
  if locked then
   select * into a from purchase_api.account x where x.id=s.account_id for share;
  else select * into a from purchase_api.account x where x.id=s.account_id;
  end if;
  if not found or not a.active or a.principal_login<>s.login or a.password_version<>s.password_version then
   raise exception 'INVALID_SESSION' using errcode='28000';
  end if;
 end if;
 return p;
end $$;

create function purchase_api.auth_lookup(login_name text,throttle_key text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare tries integer; answer jsonb;
begin
 insert into purchase_api.login_throttle as t values(auth_lookup.throttle_key,1,clock_timestamp())
 on conflict on constraint login_throttle_pkey do update
 set attempts=case when t.window_start<=clock_timestamp()-interval '15 minutes' then 1 else t.attempts+1 end,
 window_start=case when t.window_start<=clock_timestamp()-interval '15 minutes' then clock_timestamp() else t.window_start end
 returning attempts into tries;
 if tries>5 then raise exception 'LOGIN_RATE_LIMIT'; end if;
 select jsonb_build_object('accountId',a.id::text,'login',a.principal_login::text,
 'passwordHash',a.password_hash,'passwordVersion',a.password_version)
 into answer from purchase_api.account a join purchase_api.principal p on p.login=a.principal_login
 where a.login_name=auth_lookup.login_name and a.active and p.active and p.actor<>'service';
 return answer;
end $$;
create function purchase_api.auth_failure(throttle_key text) returns void
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
begin
 -- The reservation in auth_lookup already counts failed and concurrent attempts.
 return;
end $$;
create function purchase_api.auth_login(account_id uuid,expected_version integer,token_hash text,throttle_key text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare a purchase_api.account; p purchase_api.principal; expires timestamptz;
begin
 if token_hash is null or token_hash !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_SESSION' using errcode='28000'; end if;
 select * into a from purchase_api.account x where x.id=account_id for share;
 if not found or not a.active or a.password_version<>expected_version then raise exception 'INVALID_SESSION' using errcode='28000'; end if;
 select * into p from purchase_api.principal where login=a.principal_login for share;
 if not found or not p.active or p.actor='service' then raise exception 'INVALID_SESSION' using errcode='28000'; end if;
 expires:=clock_timestamp()+interval '8 hours';
 insert into purchase_api.http_session(token_hash,login,expires_at,account_id,password_version)
 values(auth_login.token_hash,a.principal_login,expires,a.id,a.password_version);
 delete from purchase_api.login_throttle t where t.throttle_key=auth_login.throttle_key;
 return jsonb_build_object('user',jsonb_build_object('accountId',a.id::text,'loginName',a.login_name,
 'role',p.actor,'identityId',p.identity_id::text),'expiresAt',expires);
end $$;

create function purchase_api.account_credentials(token_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare a purchase_api.account;
begin
 perform purchase_api.http_actor(token_hash);
 select x.* into a from purchase_api.http_session s join purchase_api.account x on x.id=s.account_id
 where s.token_hash=account_credentials.token_hash;
 if not found then raise exception 'INVALID_SESSION' using errcode='28000'; end if;
 return jsonb_build_object('accountId',a.id::text,'passwordHash',a.password_hash,'passwordVersion',a.password_version);
end $$;

create function purchase_api.account_read(operation text,data jsonb,token_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal; a purchase_api.account; answer jsonb;
begin
 p:=purchase_api.http_actor(token_hash,null,true);
 select x.* into a from purchase_api.http_session s join purchase_api.account x on x.id=s.account_id
 where s.token_hash=account_read.token_hash;
 if not found then raise exception 'INVALID_SESSION' using errcode='28000'; end if;
 if operation='me' then
  return jsonb_build_object('accountId',a.id::text,'loginName',a.login_name,'role',p.actor,'identityId',p.identity_id::text);
 end if;
 if p.actor<>'admin' then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
 if operation='accounts/list' then
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id::text,'loginName',x.login_name,
   'identityId',i.identity_id::text,'role',i.actor,'active',x.active) order by x.login_name),'[]'::jsonb)
  into answer from purchase_api.account x join purchase_api.principal i on i.login=x.principal_login;
 elsif operation='identities/list' then
  select coalesce(jsonb_agg(jsonb_build_object('identityId',i.identity_id::text,'role',i.actor,
   'hasAccount',exists(select from purchase_api.account x where x.principal_login=i.login)) order by i.identity_id),'[]'::jsonb)
  into answer from purchase_api.principal i where i.active and i.actor<>'service';
 else raise exception 'UNKNOWN_OPERATION' using errcode='22023'; end if;
 return answer;
end $$;

create function purchase_api.account_write(operation text,data jsonb,token_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal; s purchase_api.http_session; current_account purchase_api.account;
 target purchase_api.principal; a purchase_api.account; new_hash text;
begin
 -- Session first, then principal, then account. Version increments invalidate other
 -- sessions without locking or rewriting those rows, avoiding cross-session cycles.
 select * into s from purchase_api.http_session x where x.token_hash=account_write.token_hash for update;
 if not found then raise exception 'INVALID_SESSION' using errcode='28000'; end if;
 p:=purchase_api.http_actor(token_hash);
 perform 1 from purchase_api.principal where login=p.login for share;
 select * into current_account from purchase_api.account where id=s.account_id for update;
 p:=purchase_api.http_actor(token_hash);
 if current_account.id is null then raise exception 'INVALID_SESSION' using errcode='28000'; end if;
 if operation='logout' then
  update purchase_api.http_session x set revoked=true where x.token_hash=account_write.token_hash;
  return jsonb_build_object('loggedOut',true);
 elsif operation='logout-all' then
  update purchase_api.account set password_version=password_version+1,updated_at=clock_timestamp() where id=current_account.id;
  return jsonb_build_object('loggedOut',true);
 elsif operation='password/change' then
  if current_account.password_version is distinct from (data->>'expectedVersion')::integer then
   raise exception 'INVALID_SESSION' using errcode='28000';
  end if;
  new_hash:=data->>'passwordHash';
  if coalesce(length(new_hash),0)=0 then raise exception 'INVALID_PASSWORD' using errcode='22023'; end if;
  update purchase_api.account set password_hash=new_hash,password_version=password_version+1,updated_at=clock_timestamp()
   where id=current_account.id;
  return jsonb_build_object('changed',true);
 end if;
 if p.actor<>'admin' then raise exception 'ACCESS_DENIED' using errcode='42501'; end if;
 if operation='accounts/create' then
  select * into target from purchase_api.principal where identity_id=(data->>'identityId')::uuid for share;
  if not found or not target.active or target.actor='service' then raise exception 'INVALID_ACCOUNT_IDENTITY' using errcode='22023'; end if;
  begin
   insert into purchase_api.account(login_name,principal_login,password_hash)
    values(data->>'loginName',target.login,data->>'passwordHash') returning * into a;
  exception when unique_violation then raise exception 'ACCOUNT_EXISTS'; end;
  return jsonb_build_object('id',a.id::text,'loginName',a.login_name,'identityId',target.identity_id::text,'role',target.actor,'active',a.active);
 elsif operation in ('accounts/disable','accounts/enable') then
  select * into a from purchase_api.account where id=(data->>'id')::uuid for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if a.id=current_account.id then raise exception 'CANNOT_DISABLE_SELF'; end if;
  update purchase_api.account set active=(operation='accounts/enable'),password_version=password_version+1,
   updated_at=clock_timestamp() where id=a.id;
  return jsonb_build_object('id',a.id::text,'active',operation='accounts/enable');
 else raise exception 'UNKNOWN_OPERATION' using errcode='22023'; end if;
end $$;

revoke all on purchase_api.account,purchase_api.login_throttle from public;
revoke all on all functions in schema purchase_api from public;
commit;
