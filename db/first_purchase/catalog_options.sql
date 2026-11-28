-- Additive read-only API after admin_review_list.sql; no branch-name schema assumed.
begin;
create function purchase_api.catalog_options(operation text,data jsonb,token_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal; required_role text; query_text text; page_size integer; after_id bigint:=0;
 mid bigint; row_id bigint; locked_ids bigint[]:='{}'; items jsonb; more boolean; key_name text;
begin
 if operation='options/merchant-branches' then required_role:='merchant';
 elsif operation in ('options/merchants','options/admin-branches') then required_role:='admin';
 else raise exception 'INVALID_INPUT' using errcode='22023';end if;
 p:=purchase_api.http_actor(token_hash,required_role);
 if jsonb_typeof(data) is distinct from 'object' or data-array['q','limit','cursor','merchantId']<>'{}'::jsonb
 or jsonb_typeof(data->'q') is distinct from 'string' or length(data->>'q')>100
 or jsonb_typeof(data->'limit') is distinct from 'number' or (data->>'limit')!~'^[1-9][0-9]{0,2}$'
 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 query_text:=data->>'q';page_size:=(data->>'limit')::integer;
 if page_size>100 or (operation='options/admin-branches' and not data ? 'merchantId')
 or (operation<>'options/admin-branches' and data ? 'merchantId') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 foreach key_name in array array['cursor','merchantId'] loop
  if data ? key_name and (jsonb_typeof(data->key_name) is distinct from 'string' or (data->>key_name)!~'^[1-9][0-9]{0,18}$')
  then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 after_id:=coalesce((data->>'cursor')::bigint,0);mid:=(data->>'merchantId')::bigint;
 if operation='options/merchant-branches' then
  -- Lock real branch rows first, so a revocation can commit while that lock is awaited.
  -- Enumerate all matching grants before limiting: revoked candidates must not truncate the page.
  for row_id in select b.id from purchase.branch b where b.merchant_id=p.merchant_id and b.id>after_id
   and (query_text='' or strpos(lower('الفرع '||b.id::text),lower(query_text))>0)
   and exists(select from purchase_api.principal_branch g where g.login=p.login and g.branch_id=b.id and g.active)
   order by b.id for share of b loop
   perform 1 from purchase_api.principal_branch g where g.login=p.login and g.branch_id=row_id and g.active for share;
   if found then locked_ids:=array_append(locked_ids,row_id);end if;
  end loop;
 elsif operation='options/merchants' then
  for row_id in select m.id from purchase.merchant m where m.id>after_id
   and (query_text='' or strpos(lower(m.name),lower(query_text))>0)
   order by m.id limit page_size+1 for share loop
   locked_ids:=array_append(locked_ids,row_id);
  end loop;
 else
  perform 1 from purchase.merchant where id=mid for share;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
  for row_id in select b.id from purchase.branch b where b.merchant_id=mid and b.id>after_id
   and (query_text='' or strpos(lower('الفرع '||b.id::text),lower(query_text))>0)
   order by b.id limit page_size+1 for share loop
   locked_ids:=array_append(locked_ids,row_id);
  end loop;
 end if;
 -- Do not retain pre-wait authority. Also verify the current merchant ownership in the final query.
 p:=purchase_api.http_actor(token_hash,required_role,true);
 if operation='options/merchants' then
  select coalesce(jsonb_agg(jsonb_build_object('merchantId',x.id::text,'merchantName',x.name) order by x.id),'[]'::jsonb) into items
  from (select m.id,m.name from purchase.merchant m where m.id=any(locked_ids) order by m.id limit page_size+1) x;
 else
  select coalesce(jsonb_agg(jsonb_build_object('branchId',x.id::text,'displayName','الفرع '||x.id::text)
   ||case when required_role='admin' then jsonb_build_object('merchantId',x.merchant_id::text) else '{}'::jsonb end order by x.id),'[]'::jsonb) into items
  from (select b.id,b.merchant_id from purchase.branch b where b.id=any(locked_ids)
   and b.merchant_id=case when required_role='merchant' then p.merchant_id else mid end
   order by b.id limit page_size+1) x;
 end if;
 more:=jsonb_array_length(items)>page_size;if more then items:=items-page_size;end if;
 return jsonb_build_object('items',items,'hasMore',more,'nextCursor',case when more then
  items->(page_size-1)->>(case when operation='options/merchants' then 'merchantId' else 'branchId' end) else null end,'publicationEnabled',false);
end $$;
revoke all on function purchase_api.catalog_options(text,jsonb,text) from public;
commit;
