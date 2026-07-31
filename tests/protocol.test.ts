import { describe, it, expect } from 'vitest';
import { Prng } from '../src/protocol/prng';
import { crc32 } from '../src/protocol/crc32';
import { makeSoliton, deriveIndices, pickDegree } from '../src/protocol/soliton';
import { xorInto } from '../src/protocol/xor';
import {
  encodeManifestFrame,
  encodeDataFrame,
  decodeFrame,
  DATA_FRAME_OVERHEAD,
  FLAG_GZIP,
  type Manifest,
} from '../src/protocol/frame';

describe('Prng', () => {
  it('同一個 seed 產生同一條數列（兩端 bit-exact 嘅前提）', () => {
    const a = new Prng(12345);
    const b = new Prng(12345);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('輸出永遠喺 uint32 範圍', () => {
    const rng = new Prng(0);
    for (let i = 0; i < 10000; i++) {
      const v = rng.next();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('相鄰 seed 嘅數列唔相關（我哋嘅 seed 就係遞增 counter）', () => {
    // 頭 8 個輸出全部一樣嘅話代表有嚴重相關性
    for (let s = 0; s < 50; s++) {
      const a = new Prng(s);
      const b = new Prng(s + 1);
      let same = 0;
      for (let i = 0; i < 8; i++) if (a.next() === b.next()) same++;
      expect(same).toBeLessThan(4);
    }
  });

  it('nextInt 落喺範圍內而且大致均勻', () => {
    const rng = new Prng(7);
    const n = 10;
    const counts = new Array<number>(n).fill(0);
    const trials = 200_000;
    for (let i = 0; i < trials; i++) {
      const v = rng.nextInt(n);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(n);
      counts[v]!++;
    }
    for (const c of counts) {
      expect(Math.abs(c - trials / n) / (trials / n)).toBeLessThan(0.05);
    }
  });

  it('nextInt(1) 永遠 0，n <= 0 要掟錯', () => {
    const rng = new Prng(1);
    expect(rng.nextInt(1)).toBe(0);
    expect(() => rng.nextInt(0)).toThrow();
  });
});

describe('crc32', () => {
  it('對得上已知向量', () => {
    const enc = new TextEncoder();
    expect(crc32(enc.encode(''))).toBe(0x00000000);
    expect(crc32(enc.encode('a'))).toBe(0xe8b7be43);
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(enc.encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('改一個 bit 就變值', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    b[2]! ^= 0x01;
    expect(crc32(a)).not.toBe(crc32(b));
  });
});

describe('xorInto', () => {
  it('對齊同唔對齊嘅路徑結果一樣', () => {
    const rng = new Prng(99);
    for (const n of [4, 8, 100, 101, 2941, 2944]) {
      const a = new Uint8Array(n);
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        a[i] = rng.nextInt(256);
        b[i] = rng.nextInt(256);
      }
      const expected = new Uint8Array(n);
      for (let i = 0; i < n; i++) expected[i] = a[i]! ^ b[i]!;

      const fast = a.slice();
      xorInto(fast, b);
      expect(fast).toEqual(expected);

      // 迫佢行 byte 路徑：byteOffset 唔係 4 嘅倍數
      const padded = new Uint8Array(n + 1);
      padded.set(a, 1);
      const slow = padded.subarray(1);
      xorInto(slow, b);
      expect(slow).toEqual(expected);
    }
  });

  it('自己 XOR 自己等於全零', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    xorInto(a, a.slice());
    expect(a.every((v) => v === 0)).toBe(true);
  });
});

describe('Robust Soliton', () => {
  it('度數永遠落喺 1..K', () => {
    for (const k of [1, 2, 10, 100, 1000, 5000]) {
      const s = makeSoliton(k);
      const rng = new Prng(k);
      for (let i = 0; i < 2000; i++) {
        const d = pickDegree(s, rng.next());
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(k);
      }
    }
  });

  it('K=1 只會出度數 1', () => {
    const s = makeSoliton(1);
    for (let i = 0; i < 100; i++) expect(pickDegree(s, i * 40_000_000)).toBe(1);
  });

  it('deriveIndices 兩邊推導出完全一樣嘅集合（成個系統嘅命脈）', () => {
    for (const k of [1, 2, 7, 64, 733, 5000]) {
      const encoderSide = makeSoliton(k);
      const decoderSide = makeSoliton(k);
      for (let seed = 0; seed < 300; seed++) {
        expect(deriveIndices(decoderSide, seed)).toEqual(deriveIndices(encoderSide, seed));
      }
    }
  });

  it('index 唔重複、已排序、喺範圍內', () => {
    const k = 500;
    const s = makeSoliton(k);
    for (let seed = 0; seed < 3000; seed++) {
      const idx = deriveIndices(s, seed);
      expect(idx.length).toBeGreaterThanOrEqual(1);
      expect(idx.length).toBeLessThanOrEqual(k);
      expect(new Set(idx).size).toBe(idx.length);
      for (let i = 0; i < idx.length; i++) {
        expect(idx[i]!).toBeGreaterThanOrEqual(0);
        expect(idx[i]!).toBeLessThan(k);
        if (i > 0) expect(idx[i]!).toBeGreaterThan(idx[i - 1]!);
      }
    }
  });

  it('有相當比例嘅低度數包，否則解碼永遠啟動唔到', () => {
    const k = 1000;
    const s = makeSoliton(k);
    const rng = new Prng(42);
    let degreeOne = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) if (pickDegree(s, rng.next()) === 1) degreeOne++;
    // Robust Soliton 嘅尖峰保證度數 1 有可觀比例
    expect(degreeOne / n).toBeGreaterThan(0.005);
  });
});

describe('幀格式', () => {
  const manifest: Manifest = {
    payloadSize: 123456,
    originalSize: 200000,
    blockSize: 2940,
    blockCount: 42,
    flags: FLAG_GZIP,
    sha256: new Uint8Array(32).map((_, i) => (i * 7) & 0xff),
    fileName: '測試檔案 test.pdf',
    mimeType: 'application/pdf',
  };

  it('MANIFEST 編完再解一模一樣', () => {
    const frame = encodeManifestFrame(0xbeef, manifest);
    const out = decodeFrame(frame);
    expect(out?.kind).toBe('manifest');
    if (out?.kind !== 'manifest') throw new Error('unreachable');
    expect(out.sessionId).toBe(0xbeef);
    expect(out.manifest).toEqual(manifest);
  });

  it('DATA 編完再解一模一樣', () => {
    const block = new Uint8Array(2940).map((_, i) => (i * 31) & 0xff);
    const frame = encodeDataFrame(0x1234, 0xdeadbeef, block);
    expect(frame.length).toBe(DATA_FRAME_OVERHEAD + block.length);
    const out = decodeFrame(frame);
    expect(out?.kind).toBe('data');
    if (out?.kind !== 'data') throw new Error('unreachable');
    expect(out.sessionId).toBe(0x1234);
    expect(out.seed).toBe(0xdeadbeef);
    expect(out.payload).toEqual(block);
  });

  it('任何一個 bit 錯咗都要被 CRC 擋住', () => {
    const block = new Uint8Array(64).map((_, i) => i);
    const frame = encodeDataFrame(1, 2, block);
    for (let byteIdx = 0; byteIdx < frame.length; byteIdx++) {
      for (const bit of [0x01, 0x80]) {
        const bad = frame.slice();
        bad[byteIdx]! ^= bit;
        expect(decodeFrame(bad)).toBeNull();
      }
    }
  });

  it('壞 magic / 壞版本 / 太短 都回傳 null', () => {
    const frame = encodeDataFrame(1, 2, new Uint8Array(32));
    const badMagic = frame.slice();
    badMagic[0] = 0x50;
    expect(decodeFrame(badMagic)).toBeNull();

    expect(decodeFrame(new Uint8Array(4))).toBeNull();
    expect(decodeFrame(new Uint8Array(0))).toBeNull();
    expect(decodeFrame(frame.subarray(0, 6))).toBeNull();
  });

  it('超長檔名會安全截斷，唔會切爛 UTF-8 codepoint', () => {
    const frame = encodeManifestFrame(1, { ...manifest, fileName: '中'.repeat(500) });
    const out = decodeFrame(frame);
    if (out?.kind !== 'manifest') throw new Error('應該解到 manifest');
    // 每個中文字 3 bytes，255 / 3 = 85 個字
    expect(out.manifest.fileName).toBe('中'.repeat(85));
  });

  it('不合理嘅 manifest 會被拒（防止配錯記憶體）', () => {
    const frame = encodeManifestFrame(1, { ...manifest, blockCount: 1, blockSize: 10 });
    // payloadSize(123456) > blockSize * blockCount(10) → 應該拒
    expect(decodeFrame(frame)).toBeNull();
  });
});
