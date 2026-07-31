import { Encoder, Byte, Charset } from '@nuintun/qrcode';
import { DATA_FRAME_OVERHEAD } from '../protocol/frame';

/**
 * QR 編碼 —— 二進位 byte mode。
 *
 * 兩個關鍵決定：
 *
 * 1. **一定要行 byte mode，唔可以經 UTF-8。** 我哋傳嘅係任意二進位，
 *    如果當文字咁 UTF-8 編碼，一個 0x80–0xFF 嘅 byte 會膨脹成 2 個 byte，
 *    容量即刻打對折，而且解碼端會嘗試「修正」非法序列，直接搞爛資料。
 *    做法：將 bytes 攤成 latin1 字串（每個字元碼 = 一個 byte），配
 *    `Charset.ISO_8859_1`。呢個係 QR byte mode 嘅預設字集，所以
 *    **唔會**多出一段 ECI header 蝕容量。
 *
 * 2. **版本固定，唔用 Auto。** 每一幀都要一模一樣大細 —— 如果 QR 隨住
 *    內容大細變版本，畫面上個碼會忽大忽小，相機成日要重新對焦同重新
 *    搵定位圖案，掉幀率會爆升。
 */

export type ProfileId = 'turbo' | 'balanced' | 'safe';

export interface QrProfile {
  id: ProfileId;
  /** UI 顯示名 */
  label: string;
  /** 一句話講點揀 */
  hint: string;
  version: number;
  level: 'L' | 'M' | 'Q' | 'H';
  /**
   * 呢個版本 + 糾錯等級喺 byte mode 下嘅最大容量（ISO/IEC 18004）。
   * 測試會逐個 profile 驗證：啱啱好塞得落，多一個 byte 就要爆。
   */
  capacity: number;
  /** QR 邊長（模組數）= 17 + 4 × version */
  size: number;
  /** 扣走幀表頭之後，每幀載得落幾多 payload；已對齊到 4 嘅倍數行 XOR 快路徑 */
  blockSize: number;
}

function makeProfile(
  id: ProfileId,
  label: string,
  hint: string,
  version: number,
  level: QrProfile['level'],
  capacity: number,
): QrProfile {
  return {
    id,
    label,
    hint,
    version,
    level,
    capacity,
    size: 17 + 4 * version,
    // 向下對齊到 4 的倍數：xorInto 就可以一次過處理 4 個 byte
    blockSize: (capacity - DATA_FRAME_OVERHEAD) & ~3,
  };
}

export const PROFILES: Record<ProfileId, QrProfile> = {
  turbo: makeProfile('turbo', '極速', '大螢幕 + 光線充足；QR 好密，相機要夠好', 40, 'L', 2953),
  balanced: makeProfile('balanced', '平衡', '一般手機掃電腦螢幕，預設之選', 27, 'L', 1465),
  safe: makeProfile('safe', '穩陣', '光線差、手震、細螢幕；慢但幾乎實收到', 20, 'M', 666),
};

export const DEFAULT_PROFILE: ProfileId = 'balanced';

export function getProfile(id: ProfileId): QrProfile {
  return PROFILES[id];
}

/** 一個已編碼好嘅 QR：`modules[y * size + x]` 為 1 代表黑。 */
export interface QrMatrix {
  size: number;
  modules: Uint8Array;
}

/**
 * 將 bytes 攤成 latin1 字串。分段處理，避免 `String.fromCharCode(...arr)`
 * 喺大 array 上爆 call stack。
 */
function bytesToLatin1(bytes: Uint8Array): string {
  const CHUNK = 4096;
  if (bytes.length <= CHUNK) {
    return String.fromCharCode(...bytes);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return s;
}

/** latin1 字串轉返 bytes —— 傳畀 Encoder 做 TextEncode，保證 byte 精確。 */
function latin1ToBytes(content: string): Uint8Array {
  const out = new Uint8Array(content.length);
  for (let i = 0; i < content.length; i++) out[i] = content.charCodeAt(i) & 0xff;
  return out;
}

/**
 * 將一幀 bytes 編成 QR 模組矩陣。
 *
 * 回傳嘅係**矩陣**而唔係圖片 —— 咁樣就可以喺 worker 入面編碼，
 * transfer 一個細細嘅 Uint8Array 返主線程，主線程淨係負責畫。
 */
export function encodeQrMatrix(payload: Uint8Array, profile: QrProfile): QrMatrix {
  if (payload.length === 0) {
    throw new RangeError('payload 唔可以係空');
  }
  if (payload.length > profile.capacity) {
    throw new RangeError(
      `payload ${payload.length} bytes 超出 ${profile.label}（v${profile.version}-${profile.level}）嘅 ${profile.capacity} bytes 容量`,
    );
  }

  const encoder = new Encoder({
    level: profile.level,
    version: profile.version,
    encode: latin1ToBytes,
  });
  const encoded = encoder.encode(new Byte(bytesToLatin1(payload), Charset.ISO_8859_1));

  const size = encoded.size;
  const modules = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      modules[row + x] = encoded.get(x, y);
    }
  }
  return { size, modules };
}
