import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

import { packFile } from '../src/codec/pack';
import { unpackPayload } from '../src/codec/unpack';
import { LtEncoder } from '../src/protocol/lt-encoder';
import { LtDecoder } from '../src/protocol/lt-decoder';
import {
  encodeManifestFrame,
  encodeDataFrame,
  decodeFrame,
  manifestPeriod,
  type Manifest,
} from '../src/protocol/frame';
import { encodeQrMatrix, PROFILES, type QrProfile } from '../src/render/qr-encode';
import { Prng } from '../src/protocol/prng';

/**
 * 成個系統嘅端到端測試 —— 由一個真檔案，一路行到還原並驗 hash：
 *
 *   File → gzip → SHA-256 → manifest
 *        → LT fountain 產包 → 幀編碼 → QR 圖片
 *        →（模擬光學通道：隨機掉幀）
 *        → zxing 解 QR → 幀解析（CRC）→ LT peeling
 *        → gunzip → SHA-256 對數
 *
 * 唯一冇覆蓋到嘅就係真實相機同 canvas。呢個測試用嘅係同 app 完全一樣
 * 嘅模組，唔係另寫一份簡化版 —— 所以協定改壞咗呢度即刻會爆。
 */

const require = createRequire(import.meta.url);

beforeAll(() => {
  const wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
  const wasm = readFileSync(wasmPath);
  prepareZXingModule({
    overrides: {
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
    },
  });
});

function renderToImageData(size: number, modules: Uint8Array, scale: number, quiet = 4) {
  const side = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (!modules[my * size + mx]) continue;
      const px0 = (mx + quiet) * scale;
      const py0 = (my + quiet) * scale;
      for (let py = py0; py < py0 + scale; py++) {
        let o = (py * side + px0) * 4;
        for (let px = 0; px < scale; px++) {
          data[o] = 0;
          data[o + 1] = 0;
          data[o + 2] = 0;
          o += 4;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

/** 一幀 bytes → QR 圖 → zxing 解返出嚟。回傳 null 代表解唔到。 */
async function throughOpticalChannel(frame: Uint8Array, profile: QrProfile): Promise<Uint8Array | null> {
  const { size, modules } = encodeQrMatrix(frame, profile);
  const image = renderToImageData(size, modules, 3);
  const results = await readBarcodes(image as unknown as ImageData, {
    formats: ['QRCode'],
    tryHarder: false,
    tryRotate: false,
    tryInvert: false,
    tryDownscale: false,
    maxNumberOfSymbols: 1,
    binarizer: 'LocalAverage',
  });
  const hit = results.find((r) => r.isValid);
  return hit ? hit.bytes : null;
}

/** 造一個內容可壓縮 / 不可壓縮嘅假檔案。 */
function makeFile(name: string, type: string, bytes: Uint8Array): File {
  return new File([bytes as unknown as BlobPart], name, { type });
}

function compressibleBytes(n: number): Uint8Array {
  const text = new TextEncoder().encode('閃爍二維碼傳輸 flickering QR transfer 0123456789 ');
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = text[i % text.length]!;
  return out;
}

function incompressibleBytes(n: number, seed: number): Uint8Array {
  const rng = new Prng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.nextInt(256);
  return out;
}

interface LoopbackOutcome {
  framesSent: number;
  framesDecoded: number;
  manifest: Manifest;
  hashOk: boolean;
  restored: Uint8Array;
}

/**
 * 完整走一次傳輸。`dropRate` 模擬相機掉幀（真實情況通常 20–40%）。
 */
async function loopback(
  file: File,
  profile: QrProfile,
  dropRate: number,
  channelSeed: number,
): Promise<LoopbackOutcome> {
  const packed = await packFile(file, profile.blockSize);
  const sessionId = 0x4242;
  const period = manifestPeriod(packed.manifest.blockCount);

  const encoder = new LtEncoder(packed.payload, packed.manifest.blockSize);
  const manifestFrame = encodeManifestFrame(sessionId, packed.manifest);
  expect(manifestFrame.length).toBeLessThanOrEqual(profile.capacity);

  const scratch = new Uint8Array(packed.manifest.blockSize);
  const channel = new Prng(channelSeed);

  let decoder: LtDecoder | null = null;
  let receivedManifest: Manifest | null = null;
  let framesSent = 0;
  let framesDecoded = 0;
  let blockSize = 0;

  // 上限係一個安全網：正常應該遠遠早過呢個數就收齊
  const maxFrames = packed.manifest.blockCount * 8 + 200;

  while (framesSent < maxFrames) {
    const isManifest = framesSent % period === 0;
    const frame = isManifest
      ? manifestFrame
      : encodeDataFrame(sessionId, encoder.next(scratch), packed.manifest, scratch);
    framesSent++;

    if (channel.nextInt(10_000) < dropRate * 10_000) continue; // 相機掉咗呢一幀

    const bytes = await throughOpticalChannel(frame, profile);
    if (!bytes) continue;
    framesDecoded++;

    const parsed = decodeFrame(bytes);
    if (!parsed) continue;

    if (parsed.kind === 'manifest') {
      // v2：manifest 唔再開 decoder，佢只帶檔名／MIME／SHA-256
      if (!receivedManifest && blockSize > 0) {
        receivedManifest = { ...parsed.manifest, blockSize };
      }
      continue;
    }

    if (parsed.sessionId !== sessionId) continue;
    // v2：第一個 DATA 幀就開得到 decoder，唔使等 manifest
    if (!decoder) {
      blockSize = parsed.stream.blockSize;
      decoder = new LtDecoder(parsed.stream.blockCount, blockSize);
    }
    decoder.push(parsed.seed, parsed.payload);
    if (decoder.isComplete && receivedManifest) break;
  }

  if (!decoder?.isComplete || !receivedManifest) {
    throw new Error(`收唔齊：送咗 ${framesSent} 幀，解到 ${framesDecoded} 幀`);
  }

  const unpacked = await unpackPayload(
    decoder.assemble(receivedManifest.payloadSize),
    receivedManifest,
  );

  return {
    framesSent,
    framesDecoded,
    manifest: receivedManifest,
    hashOk: unpacked.hashOk,
    restored: unpacked.bytes,
  };
}

describe('端到端 loopback', () => {
  it('可壓縮嘅文字檔（平衡檔位，掉 25% 幀）', async () => {
    const original = compressibleBytes(120_000);
    const file = makeFile('筆記 notes.txt', 'text/plain', original);
    const out = await loopback(file, PROFILES.balanced, 0.25, 1);

    expect(out.hashOk).toBe(true);
    expect(out.restored).toEqual(original);
    expect(out.manifest.fileName).toBe('筆記 notes.txt');
    expect(out.manifest.mimeType).toBe('text/plain');
    // gzip 應該幫到手：實際傳嘅 payload 遠細過原檔
    expect(out.manifest.payloadSize).toBeLessThan(original.length / 4);
  }, 300_000);

  it('不可壓縮嘅二進位（極速檔位，掉 30% 幀）', async () => {
    const original = incompressibleBytes(150_000, 99);
    const file = makeFile('random.bin', 'application/octet-stream', original);
    const out = await loopback(file, PROFILES.turbo, 0.3, 2);

    expect(out.hashOk).toBe(true);
    expect(out.restored).toEqual(original);
    // 壓唔細就唔應該用壓縮版本
    expect(out.manifest.payloadSize).toBe(original.length);
    expect(out.manifest.flags & 1).toBe(0);
  }, 300_000);

  it('穩陣檔位 + 高掉幀率（50%）都收得齊', async () => {
    const original = incompressibleBytes(20_000, 7);
    const file = makeFile('small.dat', '', original);
    const out = await loopback(file, PROFILES.safe, 0.5, 3);

    expect(out.hashOk).toBe(true);
    expect(out.restored).toEqual(original);
  }, 300_000);

  it('接收端由中途開始都 lock 得到（模擬遲啲先舉起手機）', async () => {
    const original = incompressibleBytes(60_000, 11);
    const file = makeFile('late.bin', '', original);
    const profile = PROFILES.balanced;

    const packed = await packFile(file, profile.blockSize);
    const sessionId = 0x1357;
    const encoder = new LtEncoder(packed.payload, packed.manifest.blockSize);
    const manifestFrame = encodeManifestFrame(sessionId, packed.manifest);
    const scratch = new Uint8Array(packed.manifest.blockSize);

    // 發送端已經播咗一大輪，接收端先至開始睇
    const period = manifestPeriod(packed.manifest.blockCount);
    const SKIP = 137;
    for (let i = 0; i < SKIP; i++) {
      if (i % period !== 0) encoder.next(scratch);
    }

    let decoder: LtDecoder | null = null;
    let manifest: Manifest | null = null;
    let blockSize = 0;
    let framesUntilFirstBlock = -1;
    let frameIndex = SKIP;
    let seen = 0;

    while (frameIndex < SKIP + packed.manifest.blockCount * 6) {
      const isManifest = frameIndex % period === 0;
      const frame = isManifest
        ? manifestFrame
        : encodeDataFrame(sessionId, encoder.next(scratch), packed.manifest, scratch);
      frameIndex++;
      seen++;

      const bytes = await throughOpticalChannel(frame, profile);
      if (!bytes) continue;
      const parsed = decodeFrame(bytes);
      if (!parsed) continue;

      if (parsed.kind === 'manifest') {
        if (!manifest && blockSize > 0) manifest = { ...parsed.manifest, blockSize };
        continue;
      }
      if (!decoder) {
        blockSize = parsed.stream.blockSize;
        decoder = new LtDecoder(parsed.stream.blockCount, blockSize);
        if (framesUntilFirstBlock < 0) framesUntilFirstBlock = seen;
      }
      decoder.push(parsed.seed, parsed.payload);
      if (decoder.isComplete && manifest) break;
    }

    expect(decoder?.isComplete).toBe(true);
    const unpacked = await unpackPayload(decoder!.assemble(manifest!.payloadSize), manifest!);
    expect(unpacked.hashOk).toBe(true);
    expect(unpacked.bytes).toEqual(original);
    // v2 嘅重點：第一個 DATA 幀就開始砌，唔使等 manifest。
    // 只要唔係啱啱撞正 manifest 幀，第一幀就應該收到
    expect(framesUntilFirstBlock).toBeLessThanOrEqual(2);
  }, 300_000);

  it('v2 自述式表頭真係慳到頻寬（對比 v1 嘅每 12 幀插播）', () => {
    // v1：每幀表頭 12 B，但每 12 幀就有一幀係純 manifest（唔載任何資料）
    // v2：每幀表頭 20 B（多帶 blockCount + payloadSize），
    //     manifest 最疏降到每 32 幀
    for (const profile of [PROFILES.turbo, PROFILES.balanced, PROFILES.safe]) {
      const v1Effective = (((profile.capacity - 12) & ~3) * 11) / 12;
      const v2Effective = (profile.blockSize * 31) / 32;
      const gain = v2Effective / v1Effective - 1;
      console.log(
        `${profile.label}：v1 ${v1Effective.toFixed(0)} → v2 ${v2Effective.toFixed(0)} B/幀（+${(gain * 100).toFixed(1)}%）`,
      );
      expect(gain, `${profile.label} 冇慳到`).toBeGreaterThan(0.03);
    }
  });

  it('SHA-256 真係捉得到損壞（唔係擺個樣）', async () => {
    const original = incompressibleBytes(5_000, 5);
    const packed = await packFile(makeFile('x.bin', '', original), PROFILES.safe.blockSize);
    const corrupted = packed.payload.slice();
    corrupted[100]! ^= 0xff;

    const good = await unpackPayload(packed.payload, packed.manifest);
    const bad = await unpackPayload(corrupted, packed.manifest);
    expect(good.hashOk).toBe(true);
    expect(bad.hashOk).toBe(false);
  }, 60_000);
});
