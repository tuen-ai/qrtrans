import { describe, it, expect } from 'vitest';
import { encodeQrMatrix, PROFILES } from '../src/render/qr-encode';
import { Prng } from '../src/protocol/prng';

/**
 * QR 編碼速度嘅迴歸門檻。
 *
 * 背景：舊實作用 @nuintun/qrcode 並且由佢自動揀 mask pattern。規格要求
 * 試晒 8 個 mask、逐個計罰分再揀最好 —— v40 即係 8 × 177² 次評估。實測
 * 30.7 ms/幀，等於**單核 33 fps 上限**，即係「極速」檔位揀 60fps 根本
 * 追唔到，畫面會重複播舊幀。
 *
 * 換咗 node-qrcode 並釘死 mask 之後：2.3 ms/幀，433 fps 上限。快 13 倍。
 *
 * 呢個測試唔係要量度絕對效能（CI 機器快慢差好遠），而係守住「唔好有人
 * 唔小心改返去自動揀 mask」—— 嗰個係 10 倍以上嘅倒退，但功能完全正常，
 * 淨係得個幀率靜靜雞跌，好難察覺。
 */

function randomBytes(n: number, seed: number): Uint8Array {
  const rng = new Prng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.nextInt(256);
  return out;
}

function msPerFrame(payload: Uint8Array, profile: (typeof PROFILES)[keyof typeof PROFILES]): number {
  encodeQrMatrix(payload, profile); // 熱身
  const N = 30;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    payload[0] = i & 0xff;
    encodeQrMatrix(payload, profile);
  }
  return (performance.now() - t0) / N;
}

describe('QR 編碼效能', () => {
  it('最密嘅檔位都追得到 60fps，仲要有大量餘裕', () => {
    const profile = PROFILES.turbo;
    const ms = msPerFrame(randomBytes(profile.capacity, 1), profile);
    const ceiling = 1000 / ms;
    console.log(`極速 v40-L：${ms.toFixed(2)} ms/幀（單核 ${ceiling.toFixed(0)} fps 上限）`);

    // 門檻定喺 8 ms（125 fps）—— 遠鬆過實測嘅 2.3 ms，但一旦有人改返
    // 去自動揀 mask（30+ ms）就即刻爆
    expect(ms, '編碼慢咗好多 —— 係咪改返咗自動揀 mask？').toBeLessThan(8);
    expect(ceiling).toBeGreaterThan(120);
  });

  it('每個檔位都留到多碼並排嘅餘裕', () => {
    for (const profile of Object.values(PROFILES)) {
      const ms = msPerFrame(randomBytes(profile.capacity, profile.version), profile);
      // 2×2 grid 喺 60fps 之下每秒要 240 幀
      const loadAt2x2 = ms * 240;
      console.log(
        `${profile.label}：${ms.toFixed(2)} ms/幀 → 2×2 grid @60fps 用 ${(loadAt2x2 / 10).toFixed(0)}% 個核`,
      );
      expect(loadAt2x2, `${profile.label} 追唔到 2×2 grid @60fps`).toBeLessThan(1000);
    }
  });

  it('編碼結果穩定：同一個 payload 每次出一樣嘅矩陣', () => {
    // 釘死 mask 嘅副作用之一係編碼變成純函數 —— 冇咗「揀邊個 mask」
    // 呢個同內容有關嘅分支
    const profile = PROFILES.balanced;
    const payload = randomBytes(profile.capacity, 7);
    const a = encodeQrMatrix(payload, profile);
    const b = encodeQrMatrix(payload, profile);
    expect(a.size).toBe(b.size);
    expect(a.modules).toEqual(b.modules);
  });
});
