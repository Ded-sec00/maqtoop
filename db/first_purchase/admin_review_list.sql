-- Apply once after catalog_history.sql. Additive, private administration reads.
begin;
create index review_list_order on catalog.submission(created_at,id);
create function catalog.review_submission_json(sid uuid) returns jsonb
language sql stable set search_path=pg_catalog,catalog,pg_temp as $$
 select catalog.merchant_submission_json(s.id)||jsonb_build_object('merchantId',m.id::text,'merchantName',m.name,
  'createdAt',to_char(s.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 from catalog.submission s join purchase.merchant m on m.id=s.merchant_id where s.id=sid;
$$;
create function purchase_api.catalog_review_list(data jsonb,token_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,catalog,purchase_api,pg_temp as $$
declare mid bigint;bid bigint;branch_merchant bigint;cursor_id uuid;cursor_created timestamptz;
 page_size integer;query_text text;requested_state text;items jsonb;more boolean;key_name text;
begin
 perform purchase_api.http_actor(token_hash,'admin');
 if jsonb_typeof(data) is distinct from 'object' or data-array['q','state','merchantId','branchId','limit','cursor']<>'{}'::jsonb
 or jsonb_typeof(data->'q') is distinct from 'string' or length(data->>'q')>100
 or jsonb_typeof(data->'state') is distinct from 'string' or data->>'state' not in ('all','draft','pending_review','changes_requested','rejected','withdrawn')
 or jsonb_typeof(data->'limit') is distinct from 'number' or (data->>'limit')!~'^[1-9][0-9]{0,2}$'
 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 page_size:=(data->>'limit')::integer;query_text:=data->>'q';requested_state:=data->>'state';
 if page_size>100 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 foreach key_name in array array['merchantId','branchId'] loop
  if data ? key_name and (jsonb_typeof(data->key_name) is distinct from 'string' or (data->>key_name)!~'^[1-9][0-9]{0,18}$') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 mid:=(data->>'merchantId')::bigint;bid:=(data->>'branchId')::bigint;
 -- Real filter/anchor records are locked before retaining any session authority.
 if mid is not null then
  perform 1 from purchase.merchant where id=mid for share;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 end if;
 if bid is not null then
  select merchant_id into branch_merchant from purchase.branch where id=bid for share;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
  if mid is not null and branch_merchant<>mid then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end if;
 if data ? 'cursor' then
  if jsonb_typeof(data->'cursor') is distinct from 'string' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  cursor_id:=(data->>'cursor')::uuid;
  select created_at into cursor_created from catalog.submission where id=cursor_id for share;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 end if;
 perform purchase_api.http_actor(token_hash,'admin',true);
 select coalesce(jsonb_agg(catalog.review_submission_json(x.id) order by x.created_at,x.id),'[]'::jsonb) into items
 from (select s.id,s.created_at from catalog.submission s join catalog.submission_revision r on r.submission_id=s.id and r.revision_number=s.current_revision
  where (requested_state='all' or s.state=requested_state) and (mid is null or s.merchant_id=mid) and (bid is null or s.branch_id=bid)
   and (query_text='' or strpos(lower(r.content->>'brand'),lower(query_text))>0 or strpos(lower(r.content->>'model'),lower(query_text))>0)
   and (cursor_id is null or (s.created_at,s.id)>(cursor_created,cursor_id))
  order by s.created_at,s.id limit page_size+1) x;
 more:=jsonb_array_length(items)>page_size;if more then items:=items-page_size;end if;
 return jsonb_build_object('items',items,'hasMore',more,'nextCursor',case when more then items->(page_size-1)->>'id' else null end,'publicationEnabled',false);
end $$;
revoke all on function catalog.review_submission_json(uuid) from public;
revoke all on function purchase_api.catalog_review_list(jsonb,text) from public;
commit;
