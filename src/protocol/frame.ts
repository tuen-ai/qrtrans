import { crc32 } from './crc32';

/**
 * 幀格式 —— 一幀 = 一個 QR 嘅 byte payload。全部多 byte 欄位一律 little-endian。
 *
 * 共通結構：
 * ```
 * [0]      magic 0x51 ('Q')
 * [1]      高 4 bit = 協定版本，低 4 bit = 幀類型
 * [2..3]   sessionId (uint16)
 * [4..]    類型專屬內容
 * [末 4]   CRC-32（覆蓋前面所有 byte）
 * ```
 *
 * sessionId 令接收端唔會撈亂兩次唔同嘅傳輸（例如你傳到一半換咗檔案重播）。
 */

export const MAGIC = 0x51;
export const PROTOCOL_VERSION = 1;

export const FRAME_MANIFEST = 0;
export const FRAME_DATA = 1;

const HEADER_BYTES = 4;
const CRC_BYTES = 4;
const SEED_BYTES = 4;

/** DATA 幀除咗 block 內容之外嘅固定開銷（byte）。 */
export const DATA_FRAME_OVERHEAD = HEADER_BYTES + SEED_BYTES + CRC_BYTES; // 12

/** manifest flags */
export const FLAG_GZIP = 1 << 0;

/** 檔名 / MIME 喺幀入面各自最多 255 bytes（長度用 uint8 表示）。 */
const NAME_CAP = 255;

export interface Manifest {
  /** 實際經 QR 傳嘅 payload 長度（壓縮後） */
  payloadSize: number;
  /** 原始檔案長度（解壓後） */
  originalSize: number;
  /** 每個 source block 嘅 byte 數 */
  blockSize: number;
  /** source block 總數 K */
  blockCount: number;
  /** 見 FLAG_* */
  flags: number;
  /** 原始檔案嘅 SHA-256（32 bytes） */
  sha256: Uint8Array;
  fileName: string;
  mimeType: string;
}

export type DecodedFrame =
  | { kind: 'manifest'; sessionId: number; manifest: Manifest }
  | { kind: 'data'; sessionId: number; seed: number; payload: Uint8Array };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** 轉 UTF-8 並截到 `cap` bytes；`encodeInto` 保證唔會切爛一個 codepoint。 */
function encodeUtf8Capped(s: string, cap: number): Uint8Array {
  const buf = new Uint8Array(cap);
  const { written } = textEncoder.encodeInto(s, buf);
  return buf.subarray(0, written);
}

function writeHeader(view: DataView, type: number, sessionId: number): void {
  view.setUint8(0, MAGIC);
  view.setUint8(1, (PROTOCOL_VERSION << 4) | (type & 0x0f));
  view.setUint16(2, sessionId & 0xffff, true);
}

function sealCrc(bytes: Uint8Array): Uint8Array {
  const end = bytes.length - CRC_BYTES;
  const sum = crc32(bytes, 0, end);
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(end, sum, true);
  return bytes;
}

/** 編碼一個 MANIFEST 幀。 */
export function encodeManifestFrame(sessionId: number, m: Manifest): Uint8Array {
  if (m.sha256.length !== 32) {
    throw new RangeError(`sha256 必須係 32 bytes，收到 ${m.sha256.length}`);
  }
  const name = encodeUtf8Capped(m.fileName, NAME_CAP);
  const mime = encodeUtf8Capped(m.mimeType, NAME_CAP);

  // 4 header + 4 payloadSize + 4 originalSize + 2 blockSize + 4 blockCount
  // + 1 flags + 32 sha256 + (1 + name) + (1 + mime) + 4 crc
  const total = HEADER_BYTES + 4 + 4 + 2 + 4 + 1 + 32 + 1 + name.length + 1 + mime.length + CRC_BYTES;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  writeHeader(view, FRAME_MANIFEST, sessionId);
  let o = HEADER_BYTES;
  view.setUint32(o, m.payloadSize, true); o += 4;
  view.setUint32(o, m.originalSize, true); o += 4;
  view.setUint16(o, m.blockSize, true); o += 2;
  view.setUint32(o, m.blockCount, true); o += 4;
  view.setUint8(o, m.flags & 0xff); o += 1;
  out.set(m.sha256, o); o += 32;
  view.setUint8(o, name.length); o += 1;
  out.set(name, o); o += name.length;
  view.setUint8(o, mime.length); o += 1;
  out.set(mime, o); o += mime.length;

  return sealCrc(out);
}

/**
 * 編碼一個 DATA 幀。`block` 會原封不動抄入去，長度就係 blockSize。
 */
export function encodeDataFrame(sessionId: number, seed: number, block: Uint8Array): Uint8Array {
  const out = new Uint8Array(DATA_FRAME_OVERHEAD + block.length);
  const view = new DataView(out.buffer);
  writeHeader(view, FRAME_DATA, sessionId);
  view.setUint32(HEADER_BYTES, seed >>> 0, true);
  out.set(block, HEADER_BYTES + SEED_BYTES);
  return sealCrc(out);
}

/**
 * 解碼任何一幀。**任何一點對唔上就回傳 `null`** —— 呼叫者直接掉咗佢就算。
 * 相機喺高速閃爍下拍到半新半舊嘅畫面係常態，掉幀完全無傷（fountain code
 * 會源源不絕再送），但收咗一個壞包入解碼器就會靜靜雞污染還原結果。
 */
export function decodeFrame(bytes: Uint8Array): DecodedFrame | null {
  if (bytes.length < HEADER_BYTES + CRC_BYTES) return null;
  if (bytes[0] !== MAGIC) return null;

  const versionAndType = bytes[1]!;
  if (versionAndType >>> 4 !== PROTOCOL_VERSION) return null;
  const type = versionAndType & 0x0f;

  const end = bytes.length - CRC_BYTES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (view.getUint32(end, true) !== crc32(bytes, 0, end)) return null;

  const sessionId = view.getUint16(2, true);

  if (type === FRAME_DATA) {
    if (bytes.length <= DATA_FRAME_OVERHEAD) return null;
    const seed = view.getUint32(HEADER_BYTES, true);
    // 複製出嚟：來源 buffer 隨時會被 worker 重用
    const payload = bytes.slice(HEADER_BYTES + SEED_BYTES, end);
    return { kind: 'data', sessionId, seed, payload };
  }

  if (type === FRAME_MANIFEST) {
    let o = HEADER_BYTES;
    if (end - o < 4 + 4 + 2 + 4 + 1 + 32 + 1) return null;
    const payloadSize = view.getUint32(o, true); o += 4;
    const originalSize = view.getUint32(o, true); o += 4;
    const blockSize = view.getUint16(o, true); o += 2;
    const blockCount = view.getUint32(o, true); o += 4;
    const flags = view.getUint8(o); o += 1;
    const sha256 = bytes.slice(o, o + 32); o += 32;

    const nameLen = view.getUint8(o); o += 1;
    if (o + nameLen + 1 > end) return null;
    const fileName = textDecoder.decode(bytes.subarray(o, o + nameLen)); o += nameLen;

    const mimeLen = view.getUint8(o); o += 1;
    if (o + mimeLen > end) return null;
    const mimeType = textDecoder.decode(bytes.subarray(o, o + mimeLen));

    // 基本合理性檢查 —— 壞 manifest 會令接收端配錯記憶體
    if (blockSize < 1 || blockCount < 1) return null;
    if (payloadSize < 1 || payloadSize > blockSize * blockCount) return null;

    return {
      kind: 'manifest',
      sessionId,
      manifest: { payloadSize, originalSize, blockSize, blockCount, flags, sha256, fileName, mimeType },
    };
  }

  return null;
}
