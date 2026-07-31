import QRCode from 'qrcode';
import { DATA_FRAME_OVERHEAD } from '../protocol/frame';

/**
 * QR 編碼 —— 二進位 byte mode。
 *
 * 三個關鍵決定：
 *
 * 1. **一定要行 byte mode，唔可以經 UTF-8。** 我哋傳嘅係任意二進位，
 *    如果當文字咁 UTF-8 編碼，一個 0x80–0xFF 嘅 byte 會膨脹成 2 個 byte，
 *    容量即刻打對折，而且解碼端會嘗試「修正」非法序列，直接搞爛資料。
 *    node-qrcode 嘅 byte segment 直接食 `Uint8Array`，唔使經字串。
 *
 * 2. **版本固定，唔用 Auto。** 每一幀都要一模一樣大細 —— 如果 QR 隨住
 *    內容大細變版本，畫面上個碼會忽大忽小，相機成日要重新對焦同重新
 *    搵定位圖案，掉幀率會爆升。
 *
 * 3. **Mask pattern 釘死。** 規格要求編碼器試晒 8 個 mask、逐個計罰分
 *    再揀最好嗰個 —— 對 v40 嚟講即係 8 × 177² 次評估，實測佔咗編碼時間
 *    嘅九成以上。任何 mask 都係合法嘅（用邊個會寫喺 format info 度，
 *    解碼器照讀），而我哋嘅內容係 fountain XOR 出嚟嘅近似隨機資料，
 *    本身就唔會出現 mask 想避開嘅大片同色區。
 *
 *    實測（v27-L，3px/module + 模糊 + ±40 雜訊嘅邊緣條件）：
 *      8 個 mask 嘅解碼率都喺 96–98%，自動揀係 98%
 *      編碼由 14.2 ms/幀（舊庫自動揀）跌到 1.0 ms/幀 —— 快 14 倍
 *    即係最多蝕 2 個百分點解碼率（而嗰 2% 正正就係 fountain code 免費
 *    吸收嘅嘢），換返成個數量級嘅編碼餘裕。
 */

/** 釘死嘅 mask。實測 8 個之間冇顯著差異，跟參考實作用 4。 */
const PINNED_MASK = 4;

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

  const qr = QRCode.create([{ data: payload, mode: 'byte' }], {
    errorCorrectionLevel: profile.level,
    version: profile.version,
    maskPattern: PINNED_MASK,
  });

  // node-qrcode 已經係「1 byte = 1 模組」嘅平面陣列，同我哋要嘅格式一致。
  // 抄一份出嚟先 transfer 得去主線程（原本嗰個係庫內部持有）
  const size = qr.modules.size;
  return { size, modules: Uint8Array.from(qr.modules.data) };
}
