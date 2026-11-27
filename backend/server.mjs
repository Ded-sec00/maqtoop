import http from 'node:http';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const maximumBodyBytes = 32768;
const digits = /^[1-9][0-9]{0,18}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const amount = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,8})?$/;
const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const invalidInput = () => new HttpError(400,'INVALID_INPUT','بيانات الطلب غير صحيحة');

function routeFor(method, pathname) {
  const definitions = [
    ['POST', /^\/v1\/quotes$/, 'quote/create', []],
    ['POST', /^\/v1\/quotes\/([^/]+)\/checkout$/, 'checkout/reserve', ['id']],
    ['GET', /^\/v1\/checkouts\/([^/]+)$/, 'checkout/get', ['id']],
    ['POST', /^\/v1\/checkouts\/([^/]+)\/payment-attempts$/, 'payment/create', ['id']],
    ['GET', /^\/v1\/payment-attempts\/([^/]+)$/, 'payment/get', ['attemptId']],
    ['POST', /^\/v1\/checkouts\/([^/]+)\/receipts\/([^/]+)\/refunds$/, 'refund/create', ['id','receiptId']],
    ['POST', /^\/v1\/checkouts\/([^/]+)\/receipts\/([^/]+)\/replacement$/, 'replacement/create', ['id','receiptId']],
    ['GET', /^\/v1\/checkouts\/([^/]+)\/receipts\/([^/]+)\/resolution$/, 'resolution/get', ['id','receiptId']],
    ['GET', /^\/v1\/orders\/([^/]+)$/, 'order/get', ['id']],
    ['GET', /^\/v1\/merchant\/orders\/([^/]+)$/, 'merchant/get', ['id']],
    ['GET', /^\/v1\/courier\/orders\/([^/]+)$/, 'courier/get', ['id']],
    ['POST', /^\/v1\/courier\/orders\/([^/]+)\/handoffs$/, 'handoff/create', ['id']],
    ['POST', /^\/internal\/payment-providers\/sandbox\/events$/, 'provider/event', []],
  ];
  for (const [expectedMethod, expression, operation, names] of definitions) {
    const match = method === expectedMethod && pathname.match(expression);
    if (!match) continue;
    const params = Object.fromEntries(names.map((name,index)=>[name,match[index+1]]));
    for (const [name,value] of Object.entries(params)) {
      if (!(name === 'id' ? digits : uuid).test(value)) throw invalidInput();
      if (name === 'id' && BigInt(value)>9223372036854775807n) throw invalidInput();
    }
    return { operation, params };
  }
  throw new HttpError(404,'NOT_FOUND','المسار غير موجود');
}

function validateBody(operation, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidInput();
  let fields = [];
  if (operation === 'quote/create') fields = ['skuId','quantity','deliveryAddressId'];
  if (operation === 'replacement/create') fields = ['replacementQuoteId'];
  if (operation === 'handoff/create') fields = ['kind','proofToken'];
  if (operation === 'provider/event') {
    fields = body.type === 'payment'
      ? ['type','eventId','attemptId','providerRef','amount','currency','paidAt']
      : ['type','eventId','refundId','receiptRef','amount','currency'];
  }
  if (Object.keys(body).length !== fields.length || Object.keys(body).some(key=>!fields.includes(key))) throw invalidInput();
  for (const key of ['skuId','deliveryAddressId','replacementQuoteId']) {
    if (fields.includes(key) && (typeof body[key] !== 'string' || !digits.test(body[key]) || BigInt(body[key])>9223372036854775807n)) throw invalidInput();
  }
  if (operation === 'quote/create' && body.quantity !== 1) throw invalidInput();
  if (operation === 'handoff/create' && (!['pickup','delivered'].includes(body.kind) ||
      typeof body.proofToken !== 'string' || body.proofToken.length<1 || body.proofToken.length>1024)) throw invalidInput();
  if (operation === 'provider/event') {
    if (!['payment','refund'].includes(body.type) || body.currency !== 'YER' || typeof body.amount !== 'string' || !amount.test(body.amount)) throw invalidInput();
    for (const key of ['eventId',body.type === 'payment' ? 'providerRef' : 'receiptRef']) {
      if (typeof body[key] !== 'string' || !body[key].length || body[key].length>200) throw invalidInput();
    }
    const id = body.type === 'payment' ? body.attemptId : body.refundId;
    if (typeof id !== 'string' || !uuid.test(id)) throw invalidInput();
    if (body.type === 'payment' && (typeof body.paidAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(body.paidAt) || !Number.isFinite(Date.parse(body.paidAt)))) throw invalidInput();
  }
}

async function readBody(request) {
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length)>maximumBodyBytes)) throw invalidInput();
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes>maximumBodyBytes) throw invalidInput();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function publicError(error) {
  if (error instanceof HttpError) return error;
  if (error.code === '28000') return new HttpError(401,'INVALID_SESSION','الجلسة غير صالحة');
  if (error.code === '42501') return new HttpError(403,'ACCESS_DENIED','لا تملك صلاحية تنفيذ العملية');
  if (error.code === 'P0002') return new HttpError(404,'NOT_FOUND','السجل غير موجود');
  if (error.code === 'P0001') {
    const codes = [
      [/stock|available offer/i,'OUT_OF_STOCK','الكمية غير متوفرة'],
      [/expir|stale|price/i,'QUOTE_EXPIRED','انتهت صلاحية السعر'],
      [/idempot|fingerprint|request key/i,'IDEMPOTENCY_KEY_REUSED','استُخدم مفتاح الطلب ببيانات مختلفة'],
      [/allocated|replacement|decision|refund|reconciliation/i,'DECISION_ALREADY_COMMITTED','يوجد قرار سابق لهذه الدفعة'],
    ];
    const chosen = codes.find(([pattern])=>pattern.test(error.message));
    return new HttpError(409,chosen?.[1] || 'CONFLICT',chosen?.[2] || 'تعذّر إتمام العملية بحالتها الحالية');
  }
  if (['22P02','22003','22007','22008'].includes(error.code)) return invalidInput();
  if (['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01','53300','57014','55P03','40001','40P01'].includes(error.code)) {
    return new HttpError(503,'TEMPORARILY_UNAVAILABLE','الخدمة غير متاحة مؤقتًا، استعلم عن النتيجة ثم أعد نفس الطلب');
  }
  return new HttpError(500,'INTERNAL_ERROR','تعذّر إتمام العملية');
}

export function createApi(config) {
  if (!config.database || !config.gateway || !config.actors || !config.provider?.webhookSecret || !config.serviceToken) {
    throw new Error('API configuration is incomplete');
  }
  if (!Object.hasOwn(config.actors,config.serviceLogin)) throw new Error('Service identity is not configured');
  const poolOptions = { ...config.database, options:'-c statement_timeout=12000 -c idle_in_transaction_session_timeout=20000', max:5 };
  const audit = event => {
    try {
      if (config.audit) config.audit(event);
      else console.error(JSON.stringify({type:'api_audit',...event}));
    } catch { /* Logging failures must not turn a committed operation into a retry. */ }
  };
  const createPool = credentials => {
    const pool = new Pool({...poolOptions,...credentials});
    pool.on('error',()=>audit({operation:'database-connection',status:503}));
    return pool;
  };
  const gateway = createPool(config.gateway);
  const pools = new Map();
  const actorPool = login => {
    if (!Object.hasOwn(config.actors,login)) throw new HttpError(401,'INVALID_SESSION','الجلسة غير صالحة');
    if (!pools.has(login)) pools.set(login,createPool(config.actors[login]));
    return pools.get(login);
  };
  let timer;
  let worker;
  let closing = false;
  const serviceHash = hash(config.serviceToken);
  const server = http.createServer(async (request,response) => {
    const requestId = randomUUID();
    let operation;
    let status;
    let client;
    let transaction = false;
    try {
      const url = new URL(request.url,'http://localhost');
      if (url.search) throw invalidInput();
      const route = routeFor(request.method,url.pathname);
      operation = route.operation;
      const raw = await readBody(request);
      let body = {};
      if (request.method === 'POST') {
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw invalidInput();
        try {body = JSON.parse(raw.toString('utf8'));} catch {throw invalidInput();}
        validateBody(operation,body);
      } else if (raw.length) throw invalidInput();
      let tokenHash;
      let login;
      let key = request.headers['idempotency-key'];
      if (operation === 'provider/event') {
        const signature = request.headers['x-provider-signature'];
        const expected = createHmac('sha256',config.provider.webhookSecret).update(raw).digest();
        if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature) || !timingSafeEqual(expected,Buffer.from(signature,'hex'))) {
          throw new HttpError(403,'INVALID_PROVIDER_SIGNATURE','توقيع مزود الدفع غير صالح');
        }
        login = config.serviceLogin;
        tokenHash = serviceHash;
        key = body.eventId;
      } else {
        const authorization = request.headers.authorization;
        if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{20,256}$/.test(authorization)) {
          throw new HttpError(401,'INVALID_SESSION','الجلسة غير صالحة');
        }
        tokenHash = hash(authorization.slice(7));
        const result = await gateway.query('select purchase_api.authenticate($1) as login',[tokenHash]);
        login = result.rows[0]?.login;
      }
      if (request.method === 'POST' && operation !== 'provider/event' && (typeof key !== 'string' || !/^[A-Za-z0-9:._-]{1,200}$/.test(key))) {
        throw new HttpError(400,'INVALID_IDEMPOTENCY_KEY','مفتاح الطلب مطلوب وبصيغة صحيحة');
      }
      const data = {...body,...route.params};
      client = await actorPool(login).connect();
      await client.query('begin');
      transaction = true;
      let result;
      if (request.method === 'POST') {
        const fingerprint = hash(canonical(data));
        const executed = await client.query('select * from purchase_api.http_execute($1,$2::jsonb,$3,$4,$5)',[operation,JSON.stringify(data),key,fingerprint,tokenHash]);
        result = executed.rows[0];
        if (!result || !Number.isInteger(result.status) || !result.body) throw new Error('Invalid database API response');
      } else {
        const read = await client.query('select purchase_api.http_read($1,$2::jsonb,$3) as body',[operation,JSON.stringify(data),tokenHash]);
        result = {status:200,body:read.rows[0].body};
      }
      const context = {op:operation,key,client,request,response};
      await config.testHooks?.beforeCommit?.(context);
      if (response.destroyed || request.aborted) {
        await client.query('rollback');
        transaction = false;
        status = 499;
        return;
      }
      await client.query('commit');
      transaction = false;
      status = result.status;
      await config.testHooks?.afterCommit?.(context);
      if (response.destroyed) return;
      response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-request-id':requestId});
      response.end(JSON.stringify(result.body));
    } catch(error) {
      if (transaction) await client.query('rollback').catch(()=>{});
      const safe = publicError(error);
      status = safe.status;
      if (!response.destroyed && !response.headersSent) {
        response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-request-id':requestId});
        response.end(JSON.stringify({code:safe.code,message:safe.message,requestId}));
      }
    } finally {
      client?.release();
      audit({requestId,operation,status});
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  async function runWorkerOnce() {
    if (closing || worker) return null;
    worker = (async () => {
      const pool = actorPool(config.serviceLogin);
      const result = await pool.query('select purchase_api.next_http_job($1) as job',[serviceHash]);
      const job = result.rows[0]?.job;
      if (!job) return null;
      if (!['payment','refund'].includes(job.kind)) throw new Error('Unknown outbox job');
      if (job.action === 'reconcile') {
        const target = new URL('operations/' + encodeURIComponent(job.providerKey),config.provider.baseUrl.replace(/\/?$/,'/'));
        const reply = await fetch(target,{signal:AbortSignal.timeout(5000)});
        const text = await reply.text();
        if (reply.status !== 200 || Buffer.byteLength(text)>maximumBodyBytes) throw new Error('Payment status is unavailable');
        const current = JSON.parse(text);
        if (!current || typeof current !== 'object' || Array.isArray(current) ||
            Object.keys(current).some(key=>!['providerKey','state','event','signature'].includes(key)) ||
            current.providerKey !== job.providerKey || !['pending','unknown','failed','succeeded'].includes(current.state)) {
          throw new Error('Invalid payment status');
        }
        const {signature,...envelope} = current;
        const expected = createHmac('sha256',config.provider.webhookSecret).update(canonical(envelope)).digest();
        if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature) ||
            !timingSafeEqual(expected,Buffer.from(signature,'hex'))) throw new Error('Invalid payment status signature');
        if (current.state === 'succeeded') {
          const event = current.event;
          validateBody('provider/event',event);
          const matchesJob = job.kind === 'payment'
            ? event.type === 'payment' && event.attemptId === job.attemptId
            : event.type === 'refund' && event.refundId === job.refundId;
          if (!matchesJob) throw new Error('Payment status belongs to another operation');
          await pool.query('select * from purchase_api.http_execute($1,$2::jsonb,$3,$4,$5)',
            ['provider/event',JSON.stringify(event),event.eventId,hash(canonical(event)),serviceHash]);
          await pool.query('select purchase_api.finish_http_job($1,$2)',[job.jobId,serviceHash]);
        } else {
          await pool.query('select purchase_api.record_http_status($1,$2,$3)',[job.jobId,current.state,serviceHash]);
        }
        return job;
      }
      if (job.action !== 'send') throw new Error('Unknown outbox action');
      const target = new URL(job.kind === 'payment' ? 'payments' : 'refunds',config.provider.baseUrl.replace(/\/?$/,'/'));
      const submitted = await fetch(target,{
        method:'POST',headers:{'content-type':'application/json','Idempotency-Key':job.providerKey},
        body:JSON.stringify(job),signal:AbortSignal.timeout(5000),
      });
      await submitted.arrayBuffer();
      if (submitted.status !== 202) throw new Error('Payment provider did not accept the command');
      await pool.query('select purchase_api.finish_http_job($1,$2)',[job.jobId,serviceHash]);
      return job;
    })();
    try {return await worker;} finally {worker=undefined;}
  }

  return {
    server,
    runWorkerOnce,
    async listen({host='127.0.0.1',port=0} = {}) {
      await new Promise((resolve,reject)=>{
        server.once('error',reject);
        server.listen(port,host,()=>{server.removeListener('error',reject);resolve();});
      });
      const interval = config.workerIntervalMs ?? 1000;
      if (interval>0) timer = setInterval(()=>runWorkerOnce().catch(()=>audit({operation:'worker',status:503})),interval);
      timer?.unref();
      return server.address();
    },
    async close() {
      closing = true;
      clearInterval(timer);
      await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});
      await worker?.catch(()=>{});
      await Promise.all([gateway.end(),...[...pools.values()].map(pool=>pool.end())]);
    },
  };
}
