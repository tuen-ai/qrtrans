import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
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

/** 短 SHA-256（黃金向量用）。 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

describe('Prng', () => {
  it('同一個 seed 產生同一條數列（兩端 bit-exact 嘅前提）', () => {
    const a = new Prng(12345);
    const b = new Prng(12345);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('輸出永遠喺 uint32 範圍', () => {
    // 喺迴圈入面逐次 expect 會慢到 timeout，所以累積咗先一次過斷言
    const rng = new Prng(0);
    let bad = 0;
    for (let i = 0; i < 100_000; i++) {
      const v = rng.next();
      if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) bad++;
    }
    expect(bad).toBe(0);
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
    let outOfRange = 0;
    for (let i = 0; i < trials; i++) {
      const v = rng.nextInt(n);
      if (v < 0 || v >= n) outOfRange++;
      else counts[v]!++;
    }
    expect(outOfRange).toBe(0);

    const expected = trials / n;
    const worstDeviation = Math.max(...counts.map((c) => Math.abs(c - expected) / expected));
    expect(worstDeviation).toBeLessThan(0.05);
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

  it('黃金向量：度分佈同 index 推導嘅結果一個 bit 都唔准變', () => {
    // 呢個係協定嘅凍結點。發送端同接收端有可能係唔同瀏覽器、唔同引擎、
    // 唔同版本 —— 只要兩邊推導出嘅 block index 有少少唔同，LT 解碼就會
    // 靜靜雞砌出垃圾，最後淨係得個 SHA-256 對唔上，完全冇線索。
    //
    // 順帶一提：參考實作（decimen）為咗呢個問題手寫咗個確定性 log，
    // 因為佢哋直接攞 Float64 CDF 同 float 比大細，`Math.log` 差一個 ULP
    // 就會挪動門檻。我哋將 CDF 量化成 uint32 桶，安全邊際大好多（見下
    // 一個測試），所以唔需要嗰個。呢兩個測試就係守住呢個結論。
    const vectors: Array<[number, string, string]> = [
      [1, 'ad95131bc0b799c0', 'ac6e5db2e0d7e638'],
      [2, 'b640a5d4e5c72012', '4d06e1879dba5d21'],
      [7, 'ac18084fe98146f7', '3a18c08cff7d6390'],
      [64, '1553c3284f9570fd', '9c8384499959568a'],
      [100, '05088621c45391b0', 'ddc9cf7e4f893a70'],
      [733, 'e9e9ea9b0832ece2', '84761ec1acd136bb'],
      [1000, 'f3c2e7d0cba3457b', '22e90b0a911be3ac'],
      [5000, 'f8c1b88b35e465d7', '0a50bc7cc8d498b1'],
    ];

    for (const [k, cdfHash, idxHash] of vectors) {
      const soliton = makeSoliton(k);
      expect(sha256Hex(new Uint8Array(soliton.cdf.buffer)), `K=${k} 嘅 CDF 變咗`).toBe(cdfHash);

      const indices: number[] = [];
      for (let seed = 0; seed < 50; seed++) indices.push(...deriveIndices(soliton, seed));
      expect(sha256Hex(new TextEncoder().encode(indices.join(','))), `K=${k} 嘅 index 推導變咗`).toBe(
        idxHash,
      );
    }
  });

  it('Math.log 差到 1e-12 相對誤差，量化門檻都唔會郁', () => {
    // ECMAScript 冇規定 `Math.log` 嘅精度（implementation-approximated），
    // 所以 V8（電腦發送端）同 JavaScriptCore（iPhone 接收端）可以差一兩個
    // ULP，即約 2e-16 相對誤差。
    //
    // 實測我哋嘅安全邊際：1e-12 安全，1e-11 開始有門檻郁。即係話容錯
    // 空間比引擎實際差異大約 4 個數量級 —— 夠，但唔係無限大，所以
    // 呢個測試同上面嘅黃金向量都要留住。
    const original = Math.log;
    try {
      for (const k of [100, 1000, 5000]) {
        const base = makeSoliton(k);
        (Math as { log: (x: number) => number }).log = (x) => original(x) * (1 + 1e-12);
        const perturbed = makeSoliton(k);
        expect(perturbed.cdf, `K=${k}：Math.log 差 1e-12 就令分佈改變咗`).toEqual(base.cdf);
      }
    } finally {
      (Math as { log: (x: number) => number }).log = original;
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
    // MANIFEST 唔再帶 blockSize —— 嗰個由 DATA 幀嘅長度推導
    const { blockSize: _omitted, ...expected } = manifest;
    expect(out.manifest).toEqual(expected);
  });

  it('DATA 編完再解一模一樣', () => {
    const block = new Uint8Array(2940).map((_, i) => (i * 31) & 0xff);
    const stream = { blockCount: 42, payloadSize: 42 * 2940 - 100 };
    const frame = encodeDataFrame(0x1234, 0xdeadbeef, stream, block);
    expect(frame.length).toBe(DATA_FRAME_OVERHEAD + block.length);
    const out = decodeFrame(frame);
    expect(out?.kind).toBe('data');
    if (out?.kind !== 'data') throw new Error('unreachable');
    expect(out.sessionId).toBe(0x1234);
    expect(out.seed).toBe(0xdeadbeef);
    expect(out.stream.blockCount).toBe(stream.blockCount);
    expect(out.stream.payloadSize).toBe(stream.payloadSize);
    // blockSize 唔喺表頭 —— 由幀長度推導返出嚟
    expect(out.stream.blockSize).toBe(block.length);
    expect(out.payload).toEqual(block);
  });

  it('任何一個 bit 錯咗都要被 CRC 擋住', () => {
    const block = new Uint8Array(64).map((_, i) => i);
    const frame = encodeDataFrame(1, 2, { blockCount: 1, payloadSize: 64 }, block);
    for (let byteIdx = 0; byteIdx < frame.length; byteIdx++) {
      for (const bit of [0x01, 0x80]) {
        const bad = frame.slice();
        bad[byteIdx]! ^= bit;
        expect(decodeFrame(bad)).toBeNull();
      }
    }
  });

  it('壞 magic / 壞版本 / 太短 都回傳 null', () => {
    const frame = encodeDataFrame(1, 2, { blockCount: 1, payloadSize: 32 }, new Uint8Array(32));
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

  it('不合理嘅 DATA 幀會被拒（防止配錯記憶體）', () => {
    const block = new Uint8Array(64);
    // payloadSize 大過 blockCount × blockSize —— 唔可能
    expect(decodeFrame(encodeDataFrame(1, 2, { blockCount: 1, payloadSize: 99999 }, block))).toBeNull();
    // payloadSize 細到用少過 blockCount 個 block 就夠 —— 亦唔可能
    expect(decodeFrame(encodeDataFrame(1, 2, { blockCount: 5, payloadSize: 64 }, block))).toBeNull();
    // 啱啱好合理嘅就要收
    expect(decodeFrame(encodeDataFrame(1, 2, { blockCount: 2, payloadSize: 100 }, block))).not.toBeNull();
  });
});
