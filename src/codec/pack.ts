import { FLAG_GZIP, type Manifest } from '../protocol/frame';

/**
 * 檔案打包：File → （可選 gzip）→ SHA-256 → manifest。
 *
 * **全程喺瀏覽器記憶體入面做，冇任何網絡請求。** 呢個檔案入面唔應該
 * 出現 fetch / XHR / WebSocket —— 檔案內容淨係會經螢幕上嘅 QR 離開。
 */

/**
 * 一個「自己擁有一條 ArrayBuffer」嘅 byte 陣列。
 *
 * TypeScript 5.7 之後 `Uint8Array` 對 buffer 型別有泛型，而 `SharedArrayBuffer`
 * 唔可以 transfer 去 worker、亦都唔可以直接餵 WebCrypto。明確標成
 * `Uint8Array<ArrayBuffer>` 就令編譯器幫我哋守住呢個界線。
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** 超過呢個大細就警告：K 太大會食好多記憶體，而且傳輸時間長到唔實際。 */
export const SOFT_SIZE_LIMIT = 8 * 1024 * 1024;

export interface Packed {
  manifest: Manifest;
  /** 真正經 QR 傳嘅 bytes（壓縮後，如果有壓縮） */
  payload: Bytes;
  /** 壓縮省咗幾多（0 = 冇壓縮） */
  compressionRatio: number;
}

export async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Bytes> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** 用瀏覽器原生 CompressionStream 做 gzip —— 唔使夾任何第三方庫。 */
async function gzip(bytes: Bytes): Promise<Bytes> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  return readAllBytes(cs.readable as ReadableStream<Uint8Array>);
}

export async function sha256(bytes: Uint8Array): Promise<Bytes> {
  // digest 要一個獨立嘅 ArrayBuffer；如果 view 唔係覆蓋成個 buffer 就要先抄一份
  const buf =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.slice().buffer as ArrayBuffer);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

/**
 * 打包一個檔案，準備開始播。
 *
 * gzip 係「試咗先算」：壓完大過原檔（已壓縮嘅 jpg / mp4 / zip 好常見）
 * 就掉返轉頭用原檔，唔好為咗壓縮而蝕多幾幀。
 */
export async function packFile(file: File, blockSize: number): Promise<Packed> {
  const original = new Uint8Array(await file.arrayBuffer());
  if (original.length === 0) {
    throw new Error('空檔案冇嘢好傳');
  }

  const digest = await sha256(original);

  let payload = original;
  let flags = 0;
  try {
    const compressed = await gzip(original);
    if (compressed.length < original.length) {
      payload = compressed;
      flags |= FLAG_GZIP;
    }
  } catch {
    // 舊瀏覽器冇 CompressionStream —— 唔壓就算，唔好因為咁而用唔到
  }

  const blockCount = Math.ceil(payload.length / blockSize);

  return {
    payload,
    compressionRatio: 1 - payload.length / original.length,
    manifest: {
      payloadSize: payload.length,
      originalSize: original.length,
      blockSize,
      blockCount,
      flags,
      sha256: digest,
      fileName: file.name || 'download.bin',
      mimeType: file.type || 'application/octet-stream',
    },
  };
}
