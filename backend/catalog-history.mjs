import { AuthError } from './auth.mjs';
const invalid=()=>new AuthError(400,'INVALID_INPUT','رقم النسخة أو معاملات السجل غير صحيحة');
const positive=value=>{
  if(typeof value!=='string'||!/^[1-9][0-9]{0,8}$/.test(value))throw invalid();
  return Number(value);
};
export function readCatalogHistoryQuery(params,operation,revision){
  const mode=operation.split('/').at(-1);
  const allowed=mode==='list'?['limit','cursor']:mode==='compare'?['from','to']:[];
  for(const key of params.keys())if(!allowed.includes(key)||params.getAll(key).length!==1)throw invalid();
  if(mode==='get')return {revision:positive(revision)};
  if(mode==='compare')return {from:positive(params.get('from')),to:positive(params.get('to'))};
  const limit=positive(params.get('limit')??'50');if(limit>100)throw invalid();
  return {limit,...(params.has('cursor')?{cursor:positive(params.get('cursor'))}:{})};
}
