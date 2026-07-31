import { Prng } from './prng';

/**
 * Robust Soliton 度分佈 + 由 seed 推導 block index。
 *
 * 呢個檔案係**發送端同接收端唯一嘅共用真相**：兩邊都叫同一個
 * `deriveIndices()`，所以永遠唔會對唔上。如果將來要改參數，
 * 改呢度一次就得，但要記住**新舊版本唔相容**（幀格式有版本號擋住）。
 */

/**
 * Robust Soliton 參數。
 *
 * 呢兩個數係實測掃出嚟嘅：以「總共要播幾多幀先收得齊」為指標，
 * 掃 c ∈ [0.01, 0.3] × δ ∈ [0.01, 1.0]，喺 K ∈ {50, 200, 1000, 3000}
 * 同 20% / 35% 掉幀率之下取平均。頭幾名之間嘅差距喺噪音範圍內
 * （1.685 vs 1.689 ×K），所以揀咗個比較常規嘅組合。
 *
 * 實測基準（平均要播嘅幀數，相對 K）：
 *   掉 20%：K=1000 → 1.46×K　K=3000 → 1.34×K
 *   掉 35%：K=1000 → 1.70×K　K=3000 → 1.64×K
 */
export const SOLITON_C = 0.03;
/** 解碼失敗機率上限（同時控制尖峰位置）。 */
export const SOLITON_DELTA = 0.5;

export interface Soliton {
  /** source block 總數 */
  readonly k: number;
  /** 累積分佈；cdf[d - 1] = P(degree <= d) 量化成 uint32 門檻 */
  readonly cdf: Uint32Array;
}

/**
 * 起一個 Robust Soliton 分佈表。K 一確定就叫一次，之後每個包只係
 * 二分搜尋一次，所以就算 K = 5000 都唔會拖慢產包速度。
 *
 * 概率量化成 uint32 門檻（唔係留住浮點）—— 咁樣抽度數就變成純整數比較，
 * 徹底避免任何跨引擎浮點差異令兩端推導出唔同嘅 index。
 */
export function makeSoliton(
  k: number,
  c: number = SOLITON_C,
  delta: number = SOLITON_DELTA,
): Soliton {
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(`makeSoliton 需要 k >= 1，收到 ${k}`);
  }

  const p = new Float64Array(k + 1); // 用 index 1..k，index 0 唔用

  if (k === 1) {
    p[1] = 1;
  } else {
    // 理想孤波分佈 ρ
    p[1] = 1 / k;
    for (let d = 2; d <= k; d++) p[d] = 1 / (d * (d - 1));

    // 穩健化尖峰 τ
    const r = c * Math.log(k / delta) * Math.sqrt(k);
    if (r > 0) {
      const kr = Math.floor(k / r);
      const spikeEnd = Math.min(kr - 1, k);
      for (let d = 1; d <= spikeEnd; d++) p[d]! += r / (d * k);
      // 尖峰本身；r <= delta 嘅話 log 會變負數，要擋住
      if (kr >= 1 && kr <= k && r > delta) {
        p[kr]! += (r * Math.log(r / delta)) / k;
      }
    }
  }

  // 正規化 + 量化成 uint32 累積門檻
  let total = 0;
  for (let d = 1; d <= k; d++) total += p[d]!;

  const cdf = new Uint32Array(k);
  let acc = 0;
  for (let d = 1; d <= k; d++) {
    acc += p[d]! / total;
    // 2^32 - 1 為上限；最後一格一定要爆頂，確保任何 u 都揀到嘢
    const q = Math.floor(acc * 0x100000000);
    cdf[d - 1] = q >= 0xffffffff ? 0xffffffff : q;
  }
  cdf[k - 1] = 0xffffffff;

  return { k, cdf };
}

/** 由一個 uint32 隨機值揀度數（1..k）。二分搜尋，O(log k)。 */
export function pickDegree(soliton: Soliton, u: number): number {
  const { cdf, k } = soliton;
  let lo = 0;
  let hi = k - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (u <= cdf[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo + 1;
}

/**
 * 由 seed 推導出一個 fountain 包所覆蓋嘅 source block index（已排序）。
 *
 * **發送端同接收端都用呢個函數** —— 所以包入面唔使帶 index 清單，
 * 只帶一個 4-byte seed，慳返大量頻寬。
 */
export function deriveIndices(soliton: Soliton, seed: number): number[] {
  const { k } = soliton;
  const rng = new Prng(seed);
  const degree = pickDegree(soliton, rng.next());

  if (degree >= k) {
    // 全部 block 都覆蓋
    const all = new Array<number>(k);
    for (let i = 0; i < k; i++) all[i] = i;
    return all;
  }

  if (degree * 2 <= k) {
    // 度數細：拒絕重抽最快，碰撞機率低
    const seen = new Set<number>();
    const out: number[] = [];
    while (out.length < degree) {
      const i = rng.nextInt(k);
      if (!seen.has(i)) {
        seen.add(i);
        out.push(i);
      }
    }
    out.sort((a, b) => a - b);
    return out;
  }

  // 度數大（罕見）：局部 Fisher-Yates，避免拒絕重抽退化成長 loop
  const pool = new Array<number>(k);
  for (let i = 0; i < k; i++) pool[i] = i;
  for (let i = 0; i < degree; i++) {
    const j = i + rng.nextInt(k - i);
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  const out = pool.slice(0, degree);
  out.sort((a, b) => a - b);
  return out;
}
