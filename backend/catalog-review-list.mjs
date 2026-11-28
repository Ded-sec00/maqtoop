import { AuthError } from './auth.mjs';
const invalid=()=>new AuthError(400,'INVALID_INPUT','معاملات قائمة المراجعة غير صحيحة');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const states=new Set(['all','draft','pending_review','changes_requested','rejected','withdrawn']);
export function readReviewListQuery(params){
  const allowed=new Set(['q','merchantId','branchId','state','limit','cursor']);
  for(const key of params.keys())if(!allowed.has(key)||params.getAll(key).length!==1)throw invalid();
  const q=(params.get('q')||'').trim();const state=params.get('state')??'pending_review';const size=params.get('limit')??'100';
  if([...q].length>100||q.includes('\0')||!states.has(state)||!/^[1-9][0-9]{0,2}$/.test(size)||Number(size)>100)throw invalid();
  const data={q,state,limit:Number(size)};
  for(const key of ['merchantId','branchId'])if(params.has(key)){
    const value=params.get(key);if(!/^[1-9][0-9]{0,18}$/.test(value))throw invalid();data[key]=value;
  }
  if(params.has('cursor')){const cursor=params.get('cursor');if(!uuid.test(cursor))throw invalid();data.cursor=cursor;}
  return data;
}
