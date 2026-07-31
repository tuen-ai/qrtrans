/**
 * 統計面板。
 *
 * 唯一嘅設計重點：**節流**。每收一幀就改 DOM 會直接拖低解碼速度 ——
 * 喺接收端呢個係實測得到嘅（DOM 寫入令 decode fps 明顯跌）。
 * 所以 `set()` 淨係更新記憶體入面嘅值，真正寫 DOM 最多每 250ms 一次，
 * 而且只寫真係變咗嘅格。
 */

const FLUSH_INTERVAL_MS = 250;

export type Tone = 'plain' | 'hot' | 'good';

interface Cell {
  valueEl: HTMLElement;
  rendered: string;
  renderedTone: Tone;
  value: string;
  tone: Tone;
}

export class StatsPanel {
  private readonly cells = new Map<string, Cell>();
  private timer: number | null = null;

  constructor(
    private readonly container: HTMLElement,
    keys: readonly string[],
  ) {
    container.replaceChildren();
    for (const key of keys) {
      const cell = document.createElement('div');
      cell.className = 'stat';

      const keyEl = document.createElement('div');
      keyEl.className = 'stat-key';
      keyEl.textContent = key;

      const valueEl = document.createElement('div');
      valueEl.className = 'stat-val';
      valueEl.textContent = '—';

      cell.append(keyEl, valueEl);
      container.append(cell);
      this.cells.set(key, {
        valueEl,
        rendered: '—',
        renderedTone: 'plain',
        value: '—',
        tone: 'plain',
      });
    }
  }

  set(key: string, value: string, tone: Tone = 'plain'): void {
    const cell = this.cells.get(key);
    if (!cell) return;
    cell.value = value;
    cell.tone = tone;
  }

  /** 開始定時刷新。 */
  start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /** 停止定時刷新，並最後寫一次（令用戶見到最終數字）。 */
  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  flush(): void {
    for (const cell of this.cells.values()) {
      if (cell.rendered !== cell.value) {
        cell.valueEl.textContent = cell.value;
        cell.rendered = cell.value;
      }
      if (cell.renderedTone !== cell.tone) {
        cell.valueEl.className = cell.tone === 'plain' ? 'stat-val' : `stat-val ${cell.tone}`;
        cell.renderedTone = cell.tone;
      }
    }
  }

  reset(): void {
    for (const cell of this.cells.values()) {
      cell.value = '—';
      cell.tone = 'plain';
    }
    this.flush();
  }

  destroy(): void {
    this.stop();
    this.container.replaceChildren();
    this.cells.clear();
  }
}

/** 大細格式化，例如 `1.4 MB`。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** 速率格式化，例如 `140.4 KB/s`。 */
export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
}

export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.floor(s % 60)}s`;
}

/** 滑動視窗幀率計。 */
export class RateMeter {
  private readonly stamps: number[] = [];

  constructor(private readonly windowMs = 1000) {}

  tick(now: number): void {
    this.stamps.push(now);
    const cutoff = now - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0]! < cutoff) this.stamps.shift();
  }

  /** 每秒幾多次。 */
  rate(now: number): number {
    const cutoff = now - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0]! < cutoff) this.stamps.shift();
    return (this.stamps.length * 1000) / this.windowMs;
  }
}
