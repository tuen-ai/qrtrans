import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { encodeQrMatrix, PROFILES, type QrMatrix, type QrProfile } from '../src/render/qr-encode';
import { Prng } from '../src/protocol/prng';
import { encodeDataFrame, decodeFrame } from '../src/protocol/frame';

/**
 * 成個系統最高風險嘅一段：任意二進位 → QR → 光學 → 解碼 → 一模一樣嘅二進位。
 *
 * 呢度冇真相機，但我哋驗證咗編碼器同解碼器之間嘅**位元合約**：
 * byte mode 冇被當成文字、冇多咗 ECI header、容量數字啱、
 * zxing 嘅 `.bytes` 係原封不動嘅原始 bytes。
 * 相機噪聲交畀 QR 本身嘅 Reed-Solomon 同我哋嘅 CRC 處理。
 */

const require = createRequire(import.meta.url);

beforeAll(() => {
  // 自我托管 wasm —— 預設會去 jsDelivr CDN 攞，喺呢個專案入面絕對唔可以
  const wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
  const wasmBinary = readFileSync(wasmPath);
  prepareZXingModule({
    overrides: {
      wasmBinary: wasmBinary.buffer.slice(
        wasmBinary.byteOffset,
        wasmBinary.byteOffset + wasmBinary.byteLength,
      ) as ArrayBuffer,
    },
  });
});

/** 將模組矩陣畫成一張乾淨嘅 RGBA 圖（白底黑碼 + quiet zone）。 */
function renderToImageData(matrix: QrMatrix, scale: number, quietModules = 4) {
  const { size, modules } = matrix;
  const side = (size + quietModules * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);

  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (!modules[my * size + mx]) continue;
      const px0 = (mx + quietModules) * scale;
      const py0 = (my + quietModules) * scale;
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
  return { data, width: side, height: side, colorSpace: 'srgb' as const };
}

async function decodeMatrix(matrix: QrMatrix, scale = 3): Promise<Uint8Array | null> {
  const image = renderToImageData(matrix, scale);
  const results = await readBarcodes(image as unknown as ImageData, {
    formats: ['QRCode'],
    tryHarder: false,
    tryRotate: false,
    tryInvert: false,
    maxNumberOfSymbols: 1,
  });
  const hit = results.find((r) => r.isValid);
  return hit ? hit.bytes : null;
}

function randomBytes(n: number, seed: number): Uint8Array {
  const rng = new Prng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.nextInt(256);
  return out;
}

describe('QR 二進位往返', () => {
  for (const profile of Object.values(PROFILES) as QrProfile[]) {
    describe(`${profile.label}（v${profile.version}-${profile.level}）`, () => {
      it('矩陣大細 = 17 + 4 × version', () => {
        const m = encodeQrMatrix(new Uint8Array([1, 2, 3]), profile);
        expect(m.size).toBe(17 + 4 * profile.version);
        expect(m.size).toBe(profile.size);
      });

      it('容量數字啱：啱啱好塞得落，多一個 byte 就爆', () => {
        expect(() => encodeQrMatrix(new Uint8Array(profile.capacity), profile)).not.toThrow();
        expect(() => encodeQrMatrix(new Uint8Array(profile.capacity + 1), profile)).toThrow();
      });

      it('滿載嘅隨機二進位可以 byte-for-byte 還原', async () => {
        const payload = randomBytes(profile.capacity, profile.version);
        const decoded = await decodeMatrix(encodeQrMatrix(payload, profile));
        expect(decoded).not.toBeNull();
        expect(decoded).toEqual(payload);
      });

      it('高位 byte（0x80–0xFF）唔會俾人當成 UTF-8 搞爛', async () => {
        // 呢啲 byte 序列如果被當 UTF-8 解就會出替換字元
        const payload = new Uint8Array(profile.capacity);
        for (let i = 0; i < payload.length; i++) payload[i] = 0x80 + (i % 0x80);
        const decoded = await decodeMatrix(encodeQrMatrix(payload, profile));
        expect(decoded).toEqual(payload);
      });

      it('全零同全 0xFF 都過到', async () => {
        for (const fill of [0x00, 0xff]) {
          const payload = new Uint8Array(profile.capacity).fill(fill);
          const decoded = await decodeMatrix(encodeQrMatrix(payload, profile));
          expect(decoded, `fill=0x${fill.toString(16)}`).toEqual(payload);
        }
      });

      it('blockSize 對齊 4 而且啱啱好連表頭塞得落一幀', () => {
        expect(profile.blockSize % 4).toBe(0);
        const frame = encodeDataFrame(1, 2, new Uint8Array(profile.blockSize));
        expect(frame.length).toBeLessThanOrEqual(profile.capacity);
        expect(() => encodeQrMatrix(frame, profile)).not.toThrow();
      });

      it('完整一幀（DATA 幀 → QR → 解碼 → 幀解析）行得通', async () => {
        const block = randomBytes(profile.blockSize, profile.version * 31);
        const frame = encodeDataFrame(0xa5a5, 0x12345678, block);
        const decodedBytes = await decodeMatrix(encodeQrMatrix(frame, profile));
        expect(decodedBytes).not.toBeNull();

        const parsed = decodeFrame(decodedBytes!);
        expect(parsed?.kind).toBe('data');
        if (parsed?.kind !== 'data') throw new Error('unreachable');
        expect(parsed.sessionId).toBe(0xa5a5);
        expect(parsed.seed).toBe(0x12345678);
        expect(parsed.payload).toEqual(block);
      });
    });
  }

  it('冇多咗 ECI header —— 否則每幀白蝕幾個 byte', async () => {
    // 用滿載 payload 測：如果編碼器插咗 ECI，容量就會唔夠，encode 會掟錯
    const profile = PROFILES.turbo;
    const payload = randomBytes(profile.capacity, 7);
    const matrix = encodeQrMatrix(payload, profile);
    const image = renderToImageData(matrix, 3);
    const results = await readBarcodes(image as unknown as ImageData, {
      formats: ['QRCode'],
      tryHarder: false,
      maxNumberOfSymbols: 1,
    });
    expect(results[0]?.hasECI).toBe(false);
  });
});
