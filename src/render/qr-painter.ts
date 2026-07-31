/**
 * 將 QR 模組矩陣畫上 canvas。
 *
 * 關鍵手法：先喺一個「1 像素 = 1 模組」嘅離屏 canvas 上 `putImageData`，
 * 再用 `drawImage` 放大到顯示 canvas，並且熄晒 image smoothing。
 *
 * 點解唔直接 `fillRect` 每個模組：v40 有 177 × 177 = 31,329 個模組，
 * 每幀行三萬幾次 fillRect 喺 60fps 之下完全唔掂。ImageData 寫入係
 * 一個緊湊嘅 loop，之後放大交畀 GPU 做，成本近乎零。
 */

/** QR 四邊嘅靜區（模組數）。標準要求 4，少過就有啲解碼器讀唔到。 */
export const QUIET_MODULES = 4;

export class QrPainter {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly offscreen: HTMLCanvasElement;
  private readonly offCtx: CanvasRenderingContext2D;
  private imageData: ImageData | null = null;
  private paddedSize = 0;
  private hasFrame = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('攞唔到 2D canvas context');
    this.ctx = ctx;

    this.offscreen = document.createElement('canvas');
    const offCtx = this.offscreen.getContext('2d', { alpha: false, willReadFrequently: false });
    if (!offCtx) throw new Error('攞唔到離屏 2D canvas context');
    this.offCtx = offCtx;
  }

  /** 依家畫緊嘅 QR 連靜區有幾多個模組（顯示尺寸最好係佢嘅整數倍）。 */
  get modulesPerSide(): number {
    return this.paddedSize;
  }

  /**
   * 收到新一幀，寫入離屏 buffer。
   *
   * `modules` 入面順序放住 `grid × grid` 個獨立 QR（每個 `size × size`），
   * 由左上到右下逐行排。每個碼都有自己嘅 4 模組靜區，所以兩個相鄰嘅碼
   * 之間自然就有 8 個模組嘅白邊 —— 唔使額外留間隔，解碼器分得清。
   */
  setMatrix(size: number, modules: Uint8Array, grid = 1): void {
    const cell = size + QUIET_MODULES * 2;
    const padded = cell * grid;
    if (padded !== this.paddedSize || !this.imageData) {
      this.paddedSize = padded;
      this.offscreen.width = padded;
      this.offscreen.height = padded;
      this.imageData = this.offCtx.createImageData(padded, padded);
    }

    const data = this.imageData.data;
    data.fill(255); // 白底（連 alpha 一齊填成 255）

    const perCell = size * size;
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const base = (gy * grid + gx) * perCell;
        const originX = gx * cell + QUIET_MODULES;
        const originY = gy * cell + QUIET_MODULES;
        for (let my = 0; my < size; my++) {
          const srcRow = base + my * size;
          const dstRow = (originY + my) * padded + originX;
          for (let mx = 0; mx < size; mx++) {
            if (!modules[srcRow + mx]) continue;
            const o = (dstRow + mx) * 4;
            data[o] = 0;
            data[o + 1] = 0;
            data[o + 2] = 0;
          }
        }
      }
    }

    this.offCtx.putImageData(this.imageData, 0, 0);
    this.hasFrame = true;
  }

  /**
   * 調整顯示 canvas 大細。
   *
   * 整數倍縮放最靚 —— 每個模組都係一模一樣嘅正方形。但如果硬性要求
   * 整數倍，喺可用空間得模組數 1.x 倍嗰陣就要向下取整到 1 倍，白白
   * 嘥掉最多一半面積。多碼並排之後模組總數翻幾倍，好容易撞正呢個情況。
   *
   * 對相機嚟講，**QR 喺畫面上有幾大**比「模組闊度完全一致」重要得多：
   * 前者直接決定相機每個模組收到幾多像素（實測低過 3 就完全解唔到），
   * 後者只係令模組闊度喺 3 同 4 像素之間跳，解碼器嘅網格估算食得住。
   *
   * 所以：整數倍嘅損失喺 15% 以內就用整數倍，否則填滿可用空間。
   * 兩種情況都熄咗 image smoothing，所以永遠唔會有灰邊。
   */
  resize(cssSize: number, dpr: number): void {
    if (this.paddedSize === 0) return;
    const wanted = Math.max(1, Math.floor(cssSize * dpr));
    const exact = wanted / this.paddedSize;
    const integer = Math.floor(exact);

    const pixels = integer >= 1 && integer / exact >= 0.85 ? integer * this.paddedSize : wanted;
    if (this.canvas.width !== pixels) {
      this.canvas.width = pixels;
      this.canvas.height = pixels;
    }
    const css = pixels / dpr;
    this.canvas.style.width = `${css}px`;
    this.canvas.style.height = `${css}px`;
  }

  /** 將目前嘅一幀放大畫上顯示 canvas。呢個係主線程每幀唯一要做嘅事。 */
  draw(): void {
    if (!this.hasFrame) return;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.offscreen, 0, 0, this.canvas.width, this.canvas.height);
  }

  /** 清空成白色（停止播放時用，唔好留住最後一幀畀相機繼續收）。 */
  clear(): void {
    this.hasFrame = false;
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
