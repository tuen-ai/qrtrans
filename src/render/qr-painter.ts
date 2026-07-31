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

  /** 收到新一幀矩陣，寫入離屏 buffer。 */
  setMatrix(size: number, modules: Uint8Array): void {
    const padded = size + QUIET_MODULES * 2;
    if (padded !== this.paddedSize || !this.imageData) {
      this.paddedSize = padded;
      this.offscreen.width = padded;
      this.offscreen.height = padded;
      this.imageData = this.offCtx.createImageData(padded, padded);
    }

    const data = this.imageData.data;
    data.fill(255); // 白底（連 alpha 一齊填成 255）

    for (let my = 0; my < size; my++) {
      const srcRow = my * size;
      const dstRow = (my + QUIET_MODULES) * padded + QUIET_MODULES;
      for (let mx = 0; mx < size; mx++) {
        if (!modules[srcRow + mx]) continue;
        const o = (dstRow + mx) * 4;
        data[o] = 0;
        data[o + 1] = 0;
        data[o + 2] = 0;
      }
    }

    this.offCtx.putImageData(this.imageData, 0, 0);
    this.hasFrame = true;
  }

  /**
   * 調整顯示 canvas 大細。會將像素尺寸夾成模組數嘅整數倍 ——
   * 咁樣每個模組都係一模一樣嘅正方形，冇 half-pixel 造成嘅灰邊，
   * 相機二值化嗰陣乾淨好多。
   */
  resize(cssSize: number, dpr: number): void {
    if (this.paddedSize === 0) return;
    const wanted = Math.max(1, Math.floor(cssSize * dpr));
    const scale = Math.max(1, Math.floor(wanted / this.paddedSize));
    const pixels = scale * this.paddedSize;
    if (this.canvas.width !== pixels) {
      this.canvas.width = pixels;
      this.canvas.height = pixels;
    }
    // CSS 尺寸維持整數倍嘅實際像素除以 dpr，避免瀏覽器再做一次縮放
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
