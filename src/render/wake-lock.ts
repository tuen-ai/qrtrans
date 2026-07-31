/**
 * 螢幕防熄。
 *
 * 兩邊都關鍵，但原因唔同：
 *  - **發送端**：螢幕變暗 = QR 對比度跌 = 接收端即刻解唔到；熄屏 = 傳輸直接死
 *  - **接收端**：熄屏 = 相機停 = 前功盡廢
 *
 * 傳一個大檔案要成分鐘，好容易踩中系統嘅自動熄屏。
 *
 * 兩個易踩嘅位：
 *  1. **切走再返嚟就要重新申請** —— 系統喺頁面隱藏時會自動釋放 wake lock，
 *     而且唔會自己還返畀你。所以要聽 `visibilitychange`。
 *  2. **一定唔可以掟錯** —— Safari 舊版、非 secure context、電量低模式
 *     都可能冇呢個 API 或者拒絕。冇咗只係螢幕會熄，唔應該搞到成個傳輸失敗。
 */

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

function wakeLockApi(): WakeLockLike | undefined {
  return (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
}

export class ScreenWakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;
  private readonly onVisibilityChange = (): void => {
    if (this.wanted && document.visibilityState === 'visible') void this.acquire();
  };

  /** 開始維持螢幕長亮。重複叫係安全嘅。 */
  async request(): Promise<void> {
    if (this.wanted) return;
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    await this.acquire();
  }

  /** 唔再需要就放返出嚟，等系統可以正常熄屏慳電。 */
  release(): void {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    const sentinel = this.sentinel;
    this.sentinel = null;
    void sentinel?.release().catch(() => {
      // 已經自己釋放咗就冇嘢做
    });
  }

  /** 而家真係鎖住咗螢幕未？（畀 UI 顯示用） */
  get isHeld(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  private async acquire(): Promise<void> {
    if (!this.wanted || this.isHeld) return;
    const api = wakeLockApi();
    if (!api) return; // 冇支援就算，唔好當成錯誤

    try {
      const sentinel = await api.request('screen');
      if (!this.wanted) {
        // 等緊嘅時候已經被叫停
        void sentinel.release().catch(() => undefined);
        return;
      }
      this.sentinel = sentinel;
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) this.sentinel = null;
      });
    } catch {
      // 電量低模式、非 secure context、用戶設定……冇得鎖就冇得鎖，
      // 螢幕會熄，但傳輸邏輯本身唔應該因為咁而失敗
    }
  }
}
