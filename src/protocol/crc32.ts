/**
 * CRC-32（IEEE 802.3，同 zip / png 一樣嘅多項式 0xEDB88320）。
 *
 * 點解要有：QR 本身有 Reed-Solomon 糾錯，但相機喺高速閃爍下仍然有機會
 * 「成功解碼但內容錯咗」。一個壞包餵入 LT peeling 解碼器會污染一連串
 * block，而且錯誤會靜靜雞散播到最後先發現。CRC 好平就擋得住呢種毒包。
 */

const TABLE = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

/** 計算 `bytes` 喺 [start, end) 範圍內嘅 CRC-32，回傳 32-bit 無號整數。 */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
