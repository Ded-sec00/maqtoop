import sharp from 'sharp';
import { AuthError } from './auth.mjs';

const maximumBytes=5*1024*1024;
let decoding=0;
export async function readPrivateImage(request){
  const type=request.headers['content-type'];
  if(!['image/png','image/jpeg'].includes(type))throw new AuthError(400,'INVALID_IMAGE','صيغة الصورة غير صالحة');
  const length=request.headers['content-length'];
  if(length && (!/^\d+$/.test(length)||Number(length)>maximumBytes))throw new AuthError(413,'IMAGE_TOO_LARGE','حجم الصورة يتجاوز الحد');
  const chunks=[];let count=0;
  for await(const chunk of request.iterator({destroyOnReturn:false})){
    count+=chunk.length;
    if(count>maximumBytes){request.resume();throw new AuthError(413,'IMAGE_TOO_LARGE','حجم الصورة يتجاوز الحد');}
    chunks.push(chunk);
  }
  if(!count)throw new AuthError(400,'INVALID_IMAGE','الصورة فارغة');
  if(decoding>=2)throw new AuthError(429,'IMAGE_PROCESSING_BUSY','حاول رفع الصورة لاحقًا');
  const bytes=Buffer.concat(chunks);decoding++;
  try{
    const image=sharp(bytes,{limitInputPixels:16000000,failOn:'warning',animated:false});
    const meta=await image.metadata();
    if(meta.format!==(type==='image/png'?'png':'jpeg')||(meta.pages||1)>1)throw new Error('Unsupported image');
    // Decode the complete pixels: metadata/header inspection alone accepts truncated images.
    await image.raw().toBuffer();
    return {bytes,type};
  }catch{throw new AuthError(400,'INVALID_IMAGE','محتوى الصورة غير صالح');}
  finally{decoding--;}
}
