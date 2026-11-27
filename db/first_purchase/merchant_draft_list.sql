-- Apply once after branch_permissions.sql. Read-only API; no business data migration.
begin;
create index merchant_draft_list_order on catalog.submission(created_by,merchant_id,created_at,id);
-- The list must render from the same statement snapshot as its filters.
-- Keep the legacy volatile renderer for writers that must see their own writes.
create function catalog.merchant_submission_json(sid uuid) returns jsonb
language sql stable set search_path=pg_catalog,catalog,pg_temp as $$
 select jsonb_build_object('id',s.id::text,'branchId',s.branch_id::text,'state',s.state,'version',s.version,'revision',s.current_revision,
  'content',r.content,'publicationEnabled',false,'missingDependencies',jsonb_build_array('sale_price_policy','warranty_policy'),
  'reviews',coalesce((select jsonb_agg(jsonb_build_object('revision',d.revision_number,'decision',d.decision,'reason',d.reason) order by d.revision_number)
   from catalog.review_decision d where d.submission_id=s.id),'[]'::jsonb))
 from catalog.submission s join catalog.submission_revision r on r.submission_id=s.id and r.revision_number=s.current_revision where s.id=sid;
$$;
create function purchase_api.merchant_catalog_list(data jsonb,token_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal; bid bigint; allowed_branches bigint[]:='{}'; grant_row record;
 page_size integer; query_text text; after_time timestamptz; after_id uuid; items jsonb; more boolean;
begin
 p:=purchase_api.http_actor(token_hash,'merchant');
 if jsonb_typeof(data) is distinct from 'object' or data-array['branchId','state','q','limit','after']<>'{}'::jsonb
 or jsonb_typeof(data->'q') is distinct from 'string' or length(data->>'q')>100
 or jsonb_typeof(data->'limit') is distinct from 'number' or (data->>'limit')!~'^[1-9][0-9]{0,2}$'
 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 page_size:=(data->>'limit')::integer;query_text:=data->>'q';
 if page_size>100 or (data ? 'state' and (jsonb_typeof(data->'state') is distinct from 'string' or data->>'state' not in ('draft','pending_review','changes_requested','rejected','withdrawn')))
 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if data ? 'after' then
  if jsonb_typeof(data->'after') is distinct from 'object' or (data->'after')-array['at','id']<>'{}'::jsonb
   or jsonb_typeof(data->'after'->'at') is distinct from 'string' or jsonb_typeof(data->'after'->'id') is distinct from 'string'
  then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  after_time:=(data->'after'->>'at')::timestamptz;after_id:=(data->'after'->>'id')::uuid;
 end if;
 if data ? 'branchId' then
  if jsonb_typeof(data->'branchId') is distinct from 'string' or (data->>'branchId')!~'^[1-9][0-9]{0,18}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  bid:=(data->>'branchId')::bigint;
  perform catalog.branch_access(p,bid,true);allowed_branches:=array[bid];
 else
  -- Remember only locked grants: a concurrent new grant is seen on the next request.
  for grant_row in select branch_id from purchase_api.principal_branch where login=p.login and active order by branch_id for share loop
   allowed_branches:=array_append(allowed_branches,grant_row.branch_id);
  end loop;
 end if;
 -- Both session and branch authority are current after the permission-lock wait.
 p:=purchase_api.http_actor(token_hash,'merchant',true);
 select coalesce(jsonb_agg(catalog.merchant_submission_json(x.id)||jsonb_build_object('createdAt',to_char(x.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by x.created_at,x.id),'[]'::jsonb)
 into items from (
  select s.id,s.created_at from catalog.submission s join catalog.submission_revision r on r.submission_id=s.id and r.revision_number=s.current_revision
  where s.created_by=p.login and s.merchant_id=p.merchant_id and s.branch_id=any(allowed_branches)
   and (not data ? 'state' or s.state=data->>'state')
   and (query_text='' or strpos(lower(r.content->>'brand'),lower(query_text))>0 or strpos(lower(r.content->>'model'),lower(query_text))>0)
   and (after_id is null or (s.created_at,s.id)>(after_time,after_id))
  order by s.created_at,s.id limit page_size+1
 ) x;
 more:=jsonb_array_length(items)>page_size;if more then items:=items-page_size;end if;
 return jsonb_build_object('items',items,'hasMore',more,'nextCursor',case when more then jsonb_build_object('at',items->(page_size-1)->>'createdAt','id',items->(page_size-1)->>'id') else null end,'publicationEnabled',false);
end $$;
revoke all on function purchase_api.merchant_catalog_list(jsonb,text) from public;
revoke all on function catalog.merchant_submission_json(uuid) from public;
commit;
