/**
 * 確定性偽隨機數產生器 —— 發送端同接收端必須產生**完全一樣**嘅數列，
 * 因為接收端要靠同一個 seed 重新推導出每個 fountain 包 XOR 咗邊幾個 block。
 *
 * 用 SplitMix32（而唔係 xorshift32）：xorshift32 用連續 seed（1, 2, 3…）
 * 開頭幾個輸出會高度相關，而我哋嘅 seed 正正就係遞增 counter。
 * SplitMix32 本身就係 counter-based mixer，相鄰 seed 嘅數列完全無關。
 *
 * 全部運算都係 32-bit 整數（Math.imul + `>>> 0`），冇浮點，
 * 所以喺任何 JS 引擎、任何平台上都 bit-exact。
 */
export class Prng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** 下一個 32-bit 無號整數，範圍 [0, 2^32) */
  next(): number {
    this.s = (this.s + 0x9e3779b9) >>> 0;
    let z = this.s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  }

  /**
   * 無偏嘅 [0, n) 整數。
   * 用 rejection sampling —— 直接 `% n` 會令細數字出現得多啲（modulo bias），
   * 喺 LT code 度會扭曲度分佈。
   */
  nextInt(n: number): number {
    if (n <= 0) throw new RangeError(`nextInt 需要 n > 0，收到 ${n}`);
    if (n === 1) return 0;
    // 2^32 除唔盡 n 嘅話，尾段要拒絕重抽
    const limit = 0x100000000 - (0x100000000 % n);
    let x = this.next();
    while (x >= limit) x = this.next();
    return x % n;
  }
}

/** 一次性 32-bit 混淆函數（同 Prng 內部同一個 finalizer）。 */
export function mix32(x: number): number {
  let z = (x + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}
