/**
 * 原地 XOR：`dst ^= src`。
 *
 * 呢個係 LT code 嘅最熱路徑（每個包都要做幾次，每次幾千 byte），
 * 所以對齊嘅時候行 32-bit 版本，一次過處理 4 個 byte。
 */
export function xorInto(dst: Uint8Array, src: Uint8Array): void {
  const n = dst.length;
  if (src.length !== n) {
    throw new RangeError(`xorInto 長度唔夾：${n} vs ${src.length}`);
  }
  if ((n & 3) === 0 && (dst.byteOffset & 3) === 0 && (src.byteOffset & 3) === 0) {
    const words = n >>> 2;
    const d = new Uint32Array(dst.buffer, dst.byteOffset, words);
    const s = new Uint32Array(src.buffer, src.byteOffset, words);
    for (let i = 0; i < words; i++) d[i]! ^= s[i]!;
    return;
  }
  for (let i = 0; i < n; i++) dst[i]! ^= src[i]!;
}
