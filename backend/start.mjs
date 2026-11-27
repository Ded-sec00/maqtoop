import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApi } from './server.mjs';

if (!process.env.MAQTOOP_API_CONFIG) throw new Error('Set MAQTOOP_API_CONFIG to a private configuration file');
const config = JSON.parse(await readFile(resolve(process.env.MAQTOOP_API_CONFIG),'utf8'));
const api = createApi(config);
const address = await api.listen(config.listen);
console.log('Maqtoop purchase API listening at http://' + address.address + ':' + address.port);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await api.close();
}
process.once('SIGINT',()=>stop().catch(()=>{process.exitCode=1;}));
process.once('SIGTERM',()=>stop().catch(()=>{process.exitCode=1;}));
