import { FLAG_GZIP, type Manifest } from '../protocol/frame';
import { sha256, readAllBytes, type Bytes } from './pack';

/**
 * 還原：payload →（解 gzip）→ 驗 SHA-256 → Blob。
 *
 * 同 pack.ts 一樣，全程本機，零網絡。
 */

export interface Unpacked {
  blob: Blob;
  bytes: Bytes;
  /** SHA-256 對唔對得上原檔 */
  hashOk: boolean;
  /** 收到嘅 hash（十六進位，出錯時顯示畀用戶睇） */
  expectedHash: string;
  actualHash: string;
}

async function gunzip(bytes: Bytes): Promise<Bytes> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  return readAllBytes(ds.readable as ReadableStream<Uint8Array>);
}

/** 確保拎到一條自己擁有嘅 ArrayBuffer（Blob / WebCrypto 都要）。 */
function toOwnedBytes(bytes: Uint8Array): Bytes {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export async function unpackPayload(payload: Uint8Array, manifest: Manifest): Promise<Unpacked> {
  // 統一先抄一份自己擁有嘅 buffer：解碼器砌出嚟嘅係 subarray view，
  // 而 gunzip / WebCrypto / Blob 全部都要一條完整嘅 ArrayBuffer
  const owned = toOwnedBytes(payload);
  const bytes: Bytes = manifest.flags & FLAG_GZIP ? await gunzip(owned) : owned;

  // manifest 講明原檔幾長，多咗嘅一定係哪裡出錯
  if (bytes.length !== manifest.originalSize) {
    throw new Error(
      `解壓後長度唔啱：拎到 ${bytes.length} bytes，manifest 話應該 ${manifest.originalSize} bytes`,
    );
  }

  const actual = await sha256(bytes);
  const expectedHash = toHex(manifest.sha256);
  const actualHash = toHex(actual);

  return {
    bytes,
    blob: new Blob([bytes as unknown as BlobPart], { type: manifest.mimeType || 'application/octet-stream' }),
    hashOk: expectedHash === actualHash,
    expectedHash,
    actualHash,
  };
}
