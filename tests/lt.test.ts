import { describe, it, expect } from 'vitest';
import { Prng } from '../src/protocol/prng';
import { LtEncoder } from '../src/protocol/lt-encoder';
import { LtDecoder } from '../src/protocol/lt-decoder';

function randomBytes(n: number, seed: number): Uint8Array {
  const rng = new Prng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.nextInt(256);
  return out;
}

interface RunResult {
  restored: Uint8Array;
  packetsSent: number;
  packetsDelivered: number;
  overhead: number;
}

/**
 * 模擬一次完整傳輸：編碼器不斷產包，通道按 `dropRate` 隨機掉包，
 * 收到嘅餵入解碼器，直到還原成功或者放棄。
 */
function runTransfer(
  payload: Uint8Array,
  blockSize: number,
  dropRate: number,
  channelSeed: number,
  maxPackets = 500_000,
): RunResult {
  const encoder = new LtEncoder(payload, blockSize);
  const decoder = new LtDecoder(encoder.blockCount, blockSize);
  const channel = new Prng(channelSeed);
  const scratch = new Uint8Array(blockSize);

  let sent = 0;
  let delivered = 0;
  while (!decoder.isComplete && sent < maxPackets) {
    const seed = encoder.next(scratch);
    sent++;
    if (channel.nextInt(10_000) < dropRate * 10_000) continue; // 掉包
    delivered++;
    decoder.push(seed, scratch.slice());
  }

  if (!decoder.isComplete) {
    throw new Error(`還原失敗：K=${encoder.blockCount}, 送咗 ${sent} 個包`);
  }

  return {
    restored: decoder.assemble(payload.length),
    packetsSent: sent,
    packetsDelivered: delivered,
    overhead: delivered / encoder.blockCount - 1,
  };
}

describe('LT fountain code 端到端', () => {
  it('無掉包情況下完美還原（多種 K）', () => {
    const blockSize = 64;
    for (const k of [1, 2, 3, 10, 100, 1000]) {
      const payload = randomBytes(k * blockSize - 7, k); // 故意唔啱整除，測補零
      const { restored } = runTransfer(payload, blockSize, 0, k * 31 + 1);
      expect(restored).toEqual(payload);
    }
  });

  it('掉 10% / 30% / 50% 包都照樣 byte-for-byte 還原', () => {
    const blockSize = 128;
    const payload = randomBytes(200 * blockSize + 33, 0xabc);
    for (const dropRate of [0.1, 0.3, 0.5]) {
      for (let trial = 0; trial < 5; trial++) {
        const { restored } = runTransfer(payload, blockSize, dropRate, trial * 1000 + 7);
        expect(restored).toEqual(payload);
      }
    }
  });

  it('overhead 隨 K 增大而下降，並守住迴歸門檻', () => {
    const blockSize = 64;
    // 門檻按實測值定，留返約 1.6× 空間畀隨機波動；
    // 一旦有人改壞咗度分佈或者 PRNG，呢度就會爆
    const limits: Record<number, number> = { 100: 0.6, 500: 0.35, 2000: 0.2 };
    const overheads: Record<number, number> = {};

    for (const k of [100, 500, 2000]) {
      const payload = randomBytes(k * blockSize, k);
      const list: number[] = [];
      for (let trial = 0; trial < 8; trial++) {
        list.push(runTransfer(payload, blockSize, 0.2, k * 97 + trial).overhead);
      }
      const avg = list.reduce((a, b) => a + b, 0) / list.length;
      overheads[k] = avg;
      console.log(`K=${k} 平均 overhead ${(avg * 100).toFixed(1)}%`);
      expect(avg).toBeGreaterThanOrEqual(0);
      expect(avg, `K=${k} overhead 迴歸`).toBeLessThan(limits[k]!);
    }

    // LT code 係漸近最優：K 愈大 overhead 應該愈細
    expect(overheads[2000]!).toBeLessThan(overheads[100]!);
  });

  it('模糊測試：隨機 K、隨機大小、隨機掉包率', () => {
    const rng = new Prng(0xf00d);
    for (let trial = 0; trial < 25; trial++) {
      const blockSize = 4 * (1 + rng.nextInt(64)); // 4..256
      const size = 1 + rng.nextInt(30_000);
      const dropRate = rng.nextInt(45) / 100;
      const payload = randomBytes(size, trial * 7919);
      const { restored } = runTransfer(payload, blockSize, dropRate, trial * 104729 + 3);
      expect(restored, `trial ${trial} blockSize=${blockSize} size=${size}`).toEqual(payload);
    }
  });

  it('重複包計 DUP，冗餘包計 RED，唔會扭曲進度', () => {
    const blockSize = 32;
    const payload = randomBytes(50 * blockSize, 5);
    const encoder = new LtEncoder(payload, blockSize);
    const decoder = new LtDecoder(encoder.blockCount, blockSize);
    const scratch = new Uint8Array(blockSize);

    const seed = encoder.next(scratch);
    const first = scratch.slice();
    expect(decoder.push(seed, first.slice())).toBe('new');
    expect(decoder.push(seed, first.slice())).toBe('dup');
    expect(decoder.packetsDup).toBe(1);

    while (!decoder.isComplete) {
      const s = encoder.next(scratch);
      decoder.push(s, scratch.slice());
    }
    expect(decoder.assemble(payload.length)).toEqual(payload);
    expect(decoder.progress).toBe(1);
  });

  it('亂序到達照樣還原（相機掃到嘅次序唔保證）', () => {
    const blockSize = 96;
    const payload = randomBytes(300 * blockSize - 5, 0x5eed);
    const encoder = new LtEncoder(payload, blockSize);
    const scratch = new Uint8Array(blockSize);

    // 先攞一大批包出嚟，然後打亂次序
    const packets: Array<{ seed: number; data: Uint8Array }> = [];
    for (let i = 0; i < 600; i++) {
      const seed = encoder.next(scratch);
      packets.push({ seed, data: scratch.slice() });
    }
    const shuffler = new Prng(1234);
    for (let i = packets.length - 1; i > 0; i--) {
      const j = shuffler.nextInt(i + 1);
      [packets[i], packets[j]] = [packets[j]!, packets[i]!];
    }

    const decoder = new LtDecoder(encoder.blockCount, blockSize);
    for (const p of packets) {
      decoder.push(p.seed, p.data);
      if (decoder.isComplete) break;
    }
    expect(decoder.isComplete).toBe(true);
    expect(decoder.assemble(payload.length)).toEqual(payload);
  });

  it('長度唔啱嘅包會被安全拒絕，唔會污染解碼器', () => {
    const blockSize = 32;
    const payload = randomBytes(20 * blockSize, 11);
    const encoder = new LtEncoder(payload, blockSize);
    const decoder = new LtDecoder(encoder.blockCount, blockSize);
    expect(decoder.push(0, new Uint8Array(16))).toBe('redundant');
    expect(decoder.solvedBlocks).toBe(0);

    const scratch = new Uint8Array(blockSize);
    while (!decoder.isComplete) {
      const s = encoder.next(scratch);
      decoder.push(s, scratch.slice());
    }
    expect(decoder.assemble(payload.length)).toEqual(payload);
  });
});
