-- Apply once after merchant_draft_list.sql. Historical content remains immutable.
begin;
create function catalog.revision_json(sid uuid,revision integer,with_content boolean) returns jsonb
language sql stable set search_path=pg_catalog,catalog,pg_temp as $$
 select jsonb_build_object('revision',r.revision_number,'createdAt',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'review',(select jsonb_build_object('decision',d.decision,'reason',d.reason,'decidedAt',to_char(d.decided_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
   from catalog.review_decision d where d.submission_id=r.submission_id and d.revision_number=r.revision_number))
  ||case when with_content then jsonb_build_object('content',r.content) else '{}'::jsonb end
 from catalog.submission_revision r where r.submission_id=sid and r.revision_number=revision;
$$;
create function purchase_api.catalog_history(operation text,data jsonb,token_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,catalog,purchase_api,pg_temp as $$
declare p purchase_api.principal; s catalog.submission; required text; mode text; allowed_fields text[];
 page_size integer; cursor_revision integer; from_revision integer; to_revision integer;
 base jsonb; items jsonb; more boolean; left_dto jsonb; right_dto jsonb; left_content jsonb; right_content jsonb;
 changes jsonb; added jsonb; removed jsonb; key_name text;
begin
 required:=case when operation like 'review/history/%' then 'admin' else 'merchant' end;
 p:=purchase_api.http_actor(token_hash,required);
 if operation is null or operation not in ('history/list','history/get','history/compare','review/history/list','review/history/get','review/history/compare') then
  raise exception 'ACCESS_DENIED' using errcode='42501';end if;
 mode:=regexp_replace(operation,'^.*/','');
 allowed_fields:=case mode when 'list' then array['id','limit','cursor'] when 'get' then array['id','revision'] else array['id','from','to'] end;
 if jsonb_typeof(data) is distinct from 'object' or data-allowed_fields<>'{}'::jsonb or jsonb_typeof(data->'id') is distinct from 'string' then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if mode='list' then
  if jsonb_typeof(data->'limit') is distinct from 'number' or (data->>'limit')!~'^[1-9][0-9]{0,8}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  page_size:=(data->>'limit')::integer;
  if page_size>100 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if data ? 'cursor' and (jsonb_typeof(data->'cursor') is distinct from 'number' or (data->>'cursor')!~'^[1-9][0-9]{0,8}$') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  cursor_revision:=coalesce((data->>'cursor')::integer,0);
 else
  foreach key_name in array (case when mode='get' then array['revision'] else array['from','to'] end) loop
   if jsonb_typeof(data->key_name) is distinct from 'number' or (data->>key_name)!~'^[1-9][0-9]{0,8}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  end loop;
 end if;
 -- Resource and grant locks precede the final session check. No initial authority survives a wait.
 select * into s from catalog.submission where id=(data->>'id')::uuid for share;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if p.actor='merchant' and (s.created_by<>p.login or s.merchant_id<>p.merchant_id) then raise exception 'ACCESS_DENIED' using errcode='42501';end if;
 perform catalog.branch_access(p,s.branch_id,true);
 p:=purchase_api.http_actor(token_hash,required,true);
 if p.actor='merchant' and (s.created_by<>p.login or s.merchant_id<>p.merchant_id) then raise exception 'ACCESS_DENIED' using errcode='42501';end if;
 base:=jsonb_build_object('submissionId',s.id::text,'branchId',s.branch_id::text,'version',s.version,'currentRevision',s.current_revision,'state',s.state,'publicationEnabled',false);
 if mode='list' then
  select coalesce(jsonb_agg(catalog.revision_json(s.id,x.revision_number,false) order by x.revision_number),'[]'::jsonb) into items
  from (select revision_number from catalog.submission_revision where submission_id=s.id and revision_number>cursor_revision order by revision_number limit page_size+1) x;
  more:=jsonb_array_length(items)>page_size;if more then items:=items-page_size;end if;
  return base||jsonb_build_object('items',items,'hasMore',more,'nextCursor',case when more then items->(page_size-1)->>'revision' else null end);
 elsif mode='get' then
  select catalog.revision_json(s.id,(data->>'revision')::integer,true) into left_dto;
  if left_dto is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
  return base||jsonb_build_object('revision',left_dto);
 end if;
 from_revision:=(data->>'from')::integer;to_revision:=(data->>'to')::integer;
 select catalog.revision_json(s.id,from_revision,true),catalog.revision_json(s.id,to_revision,true) into left_dto,right_dto;
 if left_dto is null or right_dto is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 left_content:=left_dto->'content';right_content:=right_dto->'content';
 select coalesce(jsonb_agg(jsonb_build_object('field',k,'before',left_content->k,'after',right_content->k,'beforePresent',left_content ? k,'afterPresent',right_content ? k) order by k),'[]'::jsonb)
 into changes from (select jsonb_object_keys(left_content) as k union select jsonb_object_keys(right_content)) keys
 where (left_content->k) is distinct from (right_content->k);
 select coalesce(jsonb_agg(v order by n),'[]'::jsonb) into added from jsonb_array_elements(coalesce(right_content->'mediaAssetIds','[]'::jsonb)) with ordinality as e(v,n)
 where not coalesce(left_content->'mediaAssetIds','[]'::jsonb) @> jsonb_build_array(v);
 select coalesce(jsonb_agg(v order by n),'[]'::jsonb) into removed from jsonb_array_elements(coalesce(left_content->'mediaAssetIds','[]'::jsonb)) with ordinality as e(v,n)
 where not coalesce(right_content->'mediaAssetIds','[]'::jsonb) @> jsonb_build_array(v);
 return base||jsonb_build_object('from',left_dto,'to',right_dto,'changes',changes,'media',jsonb_build_object('added',added,'removed',removed));
end $$;
revoke all on function catalog.revision_json(uuid,integer,boolean) from public;
revoke all on function purchase_api.catalog_history(text,jsonb,text) from public;
commit;
