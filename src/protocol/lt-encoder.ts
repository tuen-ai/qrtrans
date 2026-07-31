import { makeSoliton, deriveIndices, type Soliton } from './soliton';
import { xorInto } from './xor';

/**
 * LT fountain code 編碼器。
 *
 * 佢係一個**無限**噴泉：`next()` 可以永遠叫落去，每次出一個新嘅隨機組合包。
 * 因為冇回傳通道（相機睇住個畫面，冇嘢可以應機），所以我哋唔知接收端收到幾多、
 * 掉咗邊啲 —— fountain code 嘅重點就係「唔使知」：接收端收夠大約 1.05 × K
 * 個包（任何組合都得）就砌得返成個檔案。
 */
export class LtEncoder {
  readonly blockCount: number;
  readonly blockSize: number;
  private readonly soliton: Soliton;
  /** 全部 source block 攤平喺一條 buffer 度（尾段已補零） */
  private readonly data: Uint8Array;
  private seed = 0;

  constructor(payload: Uint8Array, blockSize: number) {
    if (!Number.isInteger(blockSize) || blockSize < 4) {
      throw new RangeError(`blockSize 要 >= 4，收到 ${blockSize}`);
    }
    if (payload.length < 1) {
      throw new RangeError('payload 唔可以係空');
    }
    this.blockSize = blockSize;
    this.blockCount = Math.ceil(payload.length / blockSize);
    // 一次過配一條連續 buffer，令每個 block 都係 blockSize 對齊嘅 subarray，
    // xorInto 就可以行 32-bit 快路徑
    this.data = new Uint8Array(this.blockCount * blockSize);
    this.data.set(payload);
    this.soliton = makeSoliton(this.blockCount);
  }

  /**
   * 產生下一個包，直接寫入 `out`（長度必須 = blockSize），回傳呢個包嘅 seed。
   *
   * 接收端只需要呢個 seed + manifest 入面嘅 K，就可以自行推導出包覆蓋咗
   * 邊幾個 block —— 所以 index 清單唔使傳。
   */
  next(out: Uint8Array): number {
    if (out.length !== this.blockSize) {
      throw new RangeError(`out 長度要係 ${this.blockSize}，收到 ${out.length}`);
    }
    const seed = this.seed;
    this.seed = (this.seed + 1) >>> 0;

    const indices = deriveIndices(this.soliton, seed);
    out.fill(0);
    for (const idx of indices) {
      const off = idx * this.blockSize;
      xorInto(out, this.data.subarray(off, off + this.blockSize));
    }
    return seed;
  }
}
