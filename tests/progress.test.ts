import { describe, it, expect } from 'vitest';
import { Prng } from '../src/protocol/prng';
import { LtEncoder } from '../src/protocol/lt-encoder';
import { LtDecoder, expectedPackets } from '../src/protocol/lt-decoder';

/**
 * 進度條行為。
 *
 * 呢個唔係「錦上添花」嘅 UX 測試 —— 舊實作用已解 block 數做進度，
 * 實測喺收到 75% 需要嘅幀嗰陣先解出 1.9% block，即係成條進度條
 * 由頭到尾都係 0%，最後一刻彈到 100%。用戶掃到一半實以為壞咗。
 */

function transfer(k: number, blockSize: number, dropRate: number, seed: number) {
  const rng = new Prng(seed);
  const payload = new Uint8Array(k * blockSize);
  for (let i = 0; i < payload.length; i++) payload[i] = rng.nextInt(256);

  const encoder = new LtEncoder(payload, blockSize);
  const decoder = new LtDecoder(encoder.blockCount, blockSize);
  const channel = new Prng(seed ^ 0x5a5a);
  const scratch = new Uint8Array(blockSize);

  const samples: Array<{ frames: number; estimated: number; blocks: number }> = [];
  let frames = 0;
  while (!decoder.isComplete && frames < k * 10) {
    const s = encoder.next(scratch);
    if (channel.nextInt(100) < dropRate * 100) continue;
    frames++;
    decoder.push(s, scratch.slice());
    samples.push({
      frames,
      estimated: decoder.estimatedProgress,
      blocks: decoder.progress,
    });
  }
  return { decoder, samples, frames };
}

describe('進度估算', () => {
  it('已解 block 數確實係後置爆發（呢個就係唔可以用佢嘅原因）', () => {
    const { samples, frames } = transfer(1000, 64, 0.25, 7);
    const at = (fraction: number) => samples[Math.floor(samples.length * fraction) - 1]!;

    // 記錄實際形狀 —— 呢個係「壞」嘅曲線
    expect(at(0.25).blocks).toBeLessThan(0.05);
    expect(at(0.5).blocks).toBeLessThan(0.1);
    expect(at(0.75).blocks).toBeLessThan(0.2);
    expect(frames).toBeGreaterThan(1000);
  });

  it('估算進度大致線性推進，唔會長期釘住', () => {
    const { samples } = transfer(1000, 64, 0.25, 7);
    const at = (fraction: number) => samples[Math.floor(samples.length * fraction) - 1]!;

    // 每個四分位都要有明顯進展 —— 呢個就係修正嘅重點
    expect(at(0.25).estimated).toBeGreaterThan(0.15);
    expect(at(0.5).estimated).toBeGreaterThan(0.35);
    expect(at(0.75).estimated).toBeGreaterThan(0.55);
    expect(at(0.99).estimated).toBeGreaterThan(0.75);
  });

  it('單調不減 —— 進度條唔可以倒退', () => {
    for (const k of [50, 300, 2000]) {
      const { samples } = transfer(k, 32, 0.3, k * 13);
      let prev = 0;
      for (const s of samples) {
        expect(s.estimated, `K=${k} 喺第 ${s.frames} 幀倒退咗`).toBeGreaterThanOrEqual(prev);
        prev = s.estimated;
      }
    }
  });

  it('未完成前封頂 99%，完成即刻 100%', () => {
    const { decoder, samples } = transfer(300, 32, 0.2, 99);
    for (const s of samples.slice(0, -1)) {
      expect(s.estimated).toBeLessThanOrEqual(0.99);
    }
    expect(decoder.isComplete).toBe(true);
    expect(decoder.estimatedProgress).toBe(1);
  });

  it('就算 overhead 估錯，尾段都會被實際 block 進度接手', () => {
    // 掉幀率極高 → 需要嘅幀數遠多過估算 → byFrames 會爆錶被 clamp 到 0.99；
    // 但完成一刻一定要係 1，唔可以卡喺 0.99
    const { decoder } = transfer(200, 32, 0.6, 5);
    expect(decoder.isComplete).toBe(true);
    expect(decoder.estimatedProgress).toBe(1);
  });

  it('expectedPackets 貼近實測所需幀數', () => {
    for (const k of [100, 500, 1000, 2000]) {
      const { frames } = transfer(k, 32, 0.2, k * 31);
      const estimate = expectedPackets(k);
      const ratio = frames / estimate;
      // 估算同實際差距要喺 ±35% 內，先至令進度條唔會太離譜
      expect(ratio, `K=${k}：實際 ${frames} 幀 vs 估算 ${estimate.toFixed(0)}`).toBeGreaterThan(0.65);
      expect(ratio, `K=${k}：實際 ${frames} 幀 vs 估算 ${estimate.toFixed(0)}`).toBeLessThan(1.35);
    }
  });
});
