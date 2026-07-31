import { makeSoliton, deriveIndices, type Soliton } from './soliton';
import { xorInto } from './xor';

/** 一個包對解碼進度嘅貢獻分類（對應 UI 上嘅 FRAMES NEW/DUP/RED）。 */
export type PacketOutcome =
  /** 新資訊：解出咗 block，或者存低咗等第日級聯 */
  | 'new'
  /** 同一個 seed 收過（畫面同一幀被連續影到兩次） */
  | 'dup'
  /** seed 係新嘅，但內容已經完全可以由已知 block 推出，冇新資訊 */
  | 'redundant';

interface Pending {
  data: Uint8Array;
  unknown: Set<number>;
}

/**
 * LT fountain code 解碼器 —— peeling（belief propagation）。
 *
 * 每收一個包就即刻做增量處理，唔會等「收晒先計」：
 *  1. 先用已知 block XOR 走，睇下淨低幾多個未知
 *  2. 淨返 1 個未知 → 即刻解出嗰個 block
 *  3. 解出新 block 之後，級聯去 reduce 所有牽涉到佢嘅待決包，可能引發雪崩
 *
 * 掉幀對佢完全無傷 —— 掉咗就等下一個包，唔使重傳、唔使任何回傳通道。
 */
export class LtDecoder {
  readonly blockCount: number;
  readonly blockSize: number;

  private readonly soliton: Soliton;
  private readonly solved: Array<Uint8Array | null>;
  /** blockIdx → 仲有呢個未知數嘅待決包 */
  private readonly waiting: Array<Set<Pending>>;
  private readonly seenSeeds = new Set<number>();

  private solvedCount = 0;
  packetsNew = 0;
  packetsDup = 0;
  packetsRedundant = 0;

  constructor(blockCount: number, blockSize: number) {
    if (!Number.isInteger(blockCount) || blockCount < 1) {
      throw new RangeError(`blockCount 要 >= 1，收到 ${blockCount}`);
    }
    this.blockCount = blockCount;
    this.blockSize = blockSize;
    this.soliton = makeSoliton(blockCount);
    this.solved = new Array<Uint8Array | null>(blockCount).fill(null);
    this.waiting = Array.from({ length: blockCount }, () => new Set<Pending>());
  }

  get isComplete(): boolean {
    return this.solvedCount === this.blockCount;
  }

  get progress(): number {
    return this.solvedCount / this.blockCount;
  }

  get solvedBlocks(): number {
    return this.solvedCount;
  }

  /** 餵一個包入去。`payload` 會被接管（唔好喺外面再用）。 */
  push(seed: number, payload: Uint8Array): PacketOutcome {
    if (payload.length !== this.blockSize) return 'redundant';
    if (this.isComplete) return 'redundant';

    if (this.seenSeeds.has(seed)) {
      this.packetsDup++;
      return 'dup';
    }
    this.seenSeeds.add(seed);

    const indices = deriveIndices(this.soliton, seed);
    const data = payload;
    const unknown = new Set<number>();

    for (const idx of indices) {
      const known = this.solved[idx];
      if (known) xorInto(data, known);
      else unknown.add(idx);
    }

    if (unknown.size === 0) {
      this.packetsRedundant++;
      return 'redundant';
    }

    this.packetsNew++;

    if (unknown.size > 1) {
      // 未解得到，存低等第日有 block 解出咗再 reduce
      const pending: Pending = { data, unknown };
      for (const idx of unknown) this.waiting[idx]!.add(pending);
      return 'new';
    }

    // 度數 1：直接解出一個 block，然後睇下引唔引發雪崩
    const idx = unknown.values().next().value as number;
    this.solve(idx, data);
    return 'new';
  }

  /** 解出一個 block 並級聯 reduce 所有等緊佢嘅包。 */
  private solve(startIdx: number, startData: Uint8Array): void {
    this.solved[startIdx] = startData;
    this.solvedCount++;

    const queue: number[] = [startIdx];
    while (queue.length > 0) {
      const b = queue.pop()!;
      const blockData = this.solved[b]!;
      const listeners = this.waiting[b]!;
      if (listeners.size === 0) continue;
      this.waiting[b] = new Set<Pending>();

      for (const pkt of listeners) {
        if (!pkt.unknown.has(b)) continue; // 已經處理咗嘅殘留引用
        xorInto(pkt.data, blockData);
        pkt.unknown.delete(b);

        if (pkt.unknown.size !== 1) continue;

        const last = pkt.unknown.values().next().value as number;
        this.waiting[last]!.delete(pkt);
        pkt.unknown.clear();

        const already = this.solved[last];
        if (already) {
          // 罕見：級聯途中已經有第二條路解咗佢，呢個包淨返冗餘
          continue;
        }
        this.solved[last] = pkt.data;
        this.solvedCount++;
        queue.push(last);
      }
    }
  }

  /**
   * 砌返個 payload。淨係喺 `isComplete` 之後先叫得。
   * `payloadSize` 用嚟切走最後一個 block 嘅補零。
   */
  assemble(payloadSize: number): Uint8Array {
    if (!this.isComplete) {
      throw new Error('仲未收齊所有 block，唔砌得');
    }
    const out = new Uint8Array(this.blockCount * this.blockSize);
    for (let i = 0; i < this.blockCount; i++) {
      out.set(this.solved[i]!, i * this.blockSize);
    }
    return out.subarray(0, payloadSize);
  }
}
