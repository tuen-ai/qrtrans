import { crc32 } from './crc32';

/**
 * 幀格式 v2 —— 一幀 = 一個 QR 嘅 byte payload。全部多 byte 欄位一律 little-endian。
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
 * ## v2 改咗乜：自述式 DATA 幀
 *
 * v1 嘅 DATA 幀淨係帶一個 seed，接收端**一定要**先收到一個 MANIFEST 幀
 * 先至知道 K 同 blockSize，喺嗰之前收到嘅 DATA 幀全部要掉。而 MANIFEST
 * 幀本身唔載任何資料，即係每 12 幀就有一幀係純開銷。
 *
 * v2 將「開始解碼所需嘅最少資料」（blockCount + payloadSize）搬入每一個
 * DATA 幀。blockSize 唔使傳 —— 由幀長度減表頭就推得返。咁樣：
 *
 *  - **第一個解到嘅幀就即刻開始砌**，唔會浪費任何幀
 *  - MANIFEST 由每 12 幀降到最疏每 32 幀，浪費嘅幀由 8.3% 跌到 3.1%
 *  - 表頭由 12 bytes 加到 20 bytes
 *
 * 淨計每幀有效載荷（極速檔位）：2695 → 2840 bytes，+5.4%。
 *
 * MANIFEST 剩返嘅嘢（檔名、MIME、SHA-256、gzip flag）淨係喺**完成嗰陣**
 * 先需要，所以疏啲送完全冇問題。
 */

export const MAGIC = 0x51;
/** v1 = 舊格式（DATA 幀唔自述）。舊版接收端會直接拒收 v2 幀，唔會出垃圾。 */
export const PROTOCOL_VERSION = 2;

export const FRAME_MANIFEST = 0;
export const FRAME_DATA = 1;

const HEADER_BYTES = 4;
const CRC_BYTES = 4;
/** DATA 幀專屬欄位：seed + blockCount + payloadSize */
const DATA_FIELDS = 12;

/** DATA 幀除咗 block 內容之外嘅固定開銷（byte）。 */
export const DATA_FRAME_OVERHEAD = HEADER_BYTES + DATA_FIELDS + CRC_BYTES; // 20

/** manifest flags */
export const FLAG_GZIP = 1 << 0;

/** 檔名 / MIME 喺幀入面各自最多 255 bytes（長度用 uint8 表示）。 */
const NAME_CAP = 255;

/**
 * 隔幾多幀插播一次 MANIFEST。
 *
 * 大檔案（K 大）疏啲送，慳頻寬；細檔案密啲送，因為佢可能喺幾十幀之內
 * 就傳完 —— 冇 manifest 就算 block 收齊都改唔到檔名、驗唔到 hash。
 */
export function manifestPeriod(blockCount: number): number {
  return Math.min(32, Math.max(4, Math.ceil(blockCount / 6)));
}

/** DATA 幀入面已經帶咗、足以開始解碼嘅資料。 */
export interface StreamInfo {
  blockCount: number;
  blockSize: number;
  payloadSize: number;
}

/** 完成傳輸先至需要嘅資料，由 MANIFEST 幀帶。 */
export interface Manifest extends StreamInfo {
  /** 原始檔案長度（解壓後） */
  originalSize: number;
  /** 見 FLAG_* */
  flags: number;
  /** 原始檔案嘅 SHA-256（32 bytes） */
  sha256: Uint8Array;
  fileName: string;
  mimeType: string;
}

export type DecodedFrame =
  | { kind: 'manifest'; sessionId: number; manifest: Omit<Manifest, 'blockSize'> }
  | { kind: 'data'; sessionId: number; seed: number; stream: StreamInfo; payload: Uint8Array };

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

  // 4 header + 4 payloadSize + 4 originalSize + 4 blockCount + 1 flags
  // + 32 sha256 + (1 + name) + (1 + mime) + 4 crc
  const total = HEADER_BYTES + 4 + 4 + 4 + 1 + 32 + 1 + name.length + 1 + mime.length + CRC_BYTES;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  writeHeader(view, FRAME_MANIFEST, sessionId);
  let o = HEADER_BYTES;
  view.setUint32(o, m.payloadSize, true); o += 4;
  view.setUint32(o, m.originalSize, true); o += 4;
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
 * 編碼一個 DATA 幀。`block` 會原封不動抄入去，佢嘅長度就係 blockSize ——
 * 所以 blockSize 唔使佔表頭位置，接收端由幀長度減返 20 就得。
 */
export function encodeDataFrame(
  sessionId: number,
  seed: number,
  stream: Pick<StreamInfo, 'blockCount' | 'payloadSize'>,
  block: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(DATA_FRAME_OVERHEAD + block.length);
  const view = new DataView(out.buffer);
  writeHeader(view, FRAME_DATA, sessionId);
  let o = HEADER_BYTES;
  view.setUint32(o, seed >>> 0, true); o += 4;
  view.setUint32(o, stream.blockCount, true); o += 4;
  view.setUint32(o, stream.payloadSize, true); o += 4;
  out.set(block, o);
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
    let o = HEADER_BYTES;
    const seed = view.getUint32(o, true); o += 4;
    const blockCount = view.getUint32(o, true); o += 4;
    const payloadSize = view.getUint32(o, true); o += 4;

    // blockSize 由幀長度推導 —— 唔使佔表頭位
    const blockSize = end - o;
    if (!isSaneStream(blockCount, blockSize, payloadSize)) return null;

    // 複製出嚟：來源 buffer 隨時會被 worker 重用
    const payload = bytes.slice(o, end);
    return { kind: 'data', sessionId, seed, stream: { blockCount, blockSize, payloadSize }, payload };
  }

  if (type === FRAME_MANIFEST) {
    let o = HEADER_BYTES;
    if (end - o < 4 + 4 + 4 + 1 + 32 + 1) return null;
    const payloadSize = view.getUint32(o, true); o += 4;
    const originalSize = view.getUint32(o, true); o += 4;
    const blockCount = view.getUint32(o, true); o += 4;
    const flags = view.getUint8(o); o += 1;
    const sha256 = bytes.slice(o, o + 32); o += 32;

    const nameLen = view.getUint8(o); o += 1;
    if (o + nameLen + 1 > end) return null;
    const fileName = textDecoder.decode(bytes.subarray(o, o + nameLen)); o += nameLen;

    const mimeLen = view.getUint8(o); o += 1;
    if (o + mimeLen > end) return null;
    const mimeType = textDecoder.decode(bytes.subarray(o, o + mimeLen));

    if (blockCount < 1 || payloadSize < 1) return null;

    return {
      kind: 'manifest',
      sessionId,
      manifest: { payloadSize, originalSize, blockCount, flags, sha256, fileName, mimeType },
    };
  }

  return null;
}

/**
 * 基本合理性檢查 —— 壞資料會令接收端配錯記憶體。
 *
 * CRC 已經擋咗絕大部分，但一個 32-bit CRC 仍然有 2^-32 撞啱嘅機會，
 * 而一個亂數 blockCount 可以令我哋即刻試圖配幾 GB 記憶體。
 */
function isSaneStream(blockCount: number, blockSize: number, payloadSize: number): boolean {
  if (blockCount < 1 || blockSize < 1 || payloadSize < 1) return false;
  // payload 一定要塞得落 blockCount 個 block，而且唔可以少過（blockCount - 1）個
  if (payloadSize > blockCount * blockSize) return false;
  if (payloadSize <= (blockCount - 1) * blockSize) return false;
  return true;
}
