import { Camera } from '../render/camera';
import { ScreenWakeLock } from '../render/wake-lock';
import { decodeFrame, type Manifest, type StreamInfo } from '../protocol/frame';
import { LtDecoder, expectedPackets } from '../protocol/lt-decoder';
import { unpackPayload, type Unpacked } from '../codec/unpack';
import { StatsPanel, RateMeter, formatBytes, formatRate, formatDuration } from './stats';
import type { DecodeRequest, DecodeResponse } from '../workers/decode.worker';

/**
 * 接收端：相機 → worker pool 解 QR → LT 解碼 → 還原檔案。
 *
 * 三個令佢快得起嚟嘅決定：
 *  1. **ROI 鎖定** —— 一解到就記住 QR 喺畫面邊度，之後淨係解嗰一小舊，
 *     解碼速度可以翻幾倍（對應畫面上嘅 LOCK 欄位）。
 *  2. **Worker pool 唔排隊** —— 全部 worker 忙就直接掉幀。排隊只會令
 *     延遲愈滾愈大，而掉幀對 fountain code 完全無傷。
 *  3. **統計節流** —— 每幀改 DOM 會實測拖低 decode fps。
 */

/** ROI 相對 QR 實際範圍放大幾多，畀手震留啲餘地 */
const ROI_MARGIN = 1.35;
/** 連續幾多幀解唔到就放棄 ROI，返去掃全畫面 */
const ROI_UNLOCK_MISSES = 15;
/** 送去解碼嘅圖最長邊上限；再大就淨係燒 CPU，對解碼率冇幫助 */
const MAX_DECODE_DIM = 1280;
/** 見到幾多次陌生 session 嘅 manifest 先當發送端換咗檔案 */
const SESSION_SWITCH_THRESHOLD = 3;

const STAT_KEYS = [
  'CAPTURE FPS',
  'DECODE FPS',
  'LOCK',
  'DROPPED',
  'GOODPUT',
  'ELAPSED',
  'FRAMES NEW/DUP/RED',
  '已解符號',
  'SESSION',
  'BLOCK LEN',
  'PAYLOAD',
] as const;

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

interface InFlight {
  region: Region;
  /** 送入 worker 嗰張圖相對原始相機幀嘅縮放比例 */
  scale: number;
}

export class ReceiverView {
  private readonly setupEl: HTMLElement;
  private readonly scanningEl: HTMLElement;
  private readonly doneEl: HTMLElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly againBtn: HTMLButtonElement;
  private readonly downloadBtn: HTMLButtonElement;
  private readonly errorEl: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly roiBox: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressLabel: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly stats: StatsPanel;

  private readonly camera: Camera;
  /** 掃描期間唔畀螢幕熄 —— 一熄相機就停 */
  private readonly wakeLock = new ScreenWakeLock();
  private pool: PoolWorker[] = [];
  private readonly inflight = new Map<number, InFlight>();
  private requestId = 0;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private roi: Region | null = null;
  /** ROI 係按住幾多格 QR 定出嚟 —— 防止部分偵測令佢愈縮愈細 */
  private roiCells = 0;
  /** 一共解到幾多個 QR 符號（可以多過相機幀數，因為一幀有幾格） */
  private symbolsDecoded = 0;
  private missStreak = 0;
  private dropped = 0;
  private startedAt = 0;
  private readonly captureMeter = new RateMeter();
  private readonly decodeMeter = new RateMeter();

  private session: number | null = null;
  /** 由 DATA 幀自述嘅資料 —— 收到第一幀就有 */
  private stream: StreamInfo | null = null;
  /** 由 MANIFEST 幀帶嘅檔案資料 —— 完成前一定要有 */
  private manifest: Manifest | null = null;
  private decoder: LtDecoder | null = null;
  private readonly foreignSessions = new Map<number, number>();

  private result: Unpacked | null = null;
  private objectUrl: string | null = null;
  private running = false;

  constructor(root: HTMLElement) {
    this.setupEl = must(root, '#recv-setup');
    this.scanningEl = must(root, '#recv-scanning');
    this.doneEl = must(root, '#recv-done');
    this.startBtn = must(root, '#recv-start');
    this.stopBtn = must(root, '#recv-stop');
    this.againBtn = must(root, '#recv-again');
    this.downloadBtn = must(root, '#recv-download');
    this.errorEl = must(root, '#recv-error');
    this.video = must(root, '#camera-video');
    this.roiBox = must(root, '#roi-box');
    this.stage = must(root, '.camera-stage');
    this.progressBar = must(root, '#recv-progress');
    this.progressLabel = must(root, '#recv-progress-label');
    this.banner = must(root, '#recv-banner');
    this.meta = must(root, '#recv-meta');
    this.stats = new StatsPanel(must(root, '#recv-stats'), STAT_KEYS);

    this.camera = new Camera(this.video, { onFrame: (now) => this.onCameraFrame(now) });

    this.startBtn.addEventListener('click', () => void this.start());
    this.stopBtn.addEventListener('click', () => this.stop());
    this.againBtn.addEventListener('click', () => void this.restart());
    this.downloadBtn.addEventListener('click', () => this.download());
  }

  // ── 生命週期 ──────────────────────────────────────────

  private async start(): Promise<void> {
    if (this.running) return;
    this.hideError();
    this.startBtn.disabled = true;

    try {
      this.resetSession();
      this.spawnPool();
      await this.camera.start();
      void this.wakeLock.request();
    } catch (err) {
      this.teardown();
      this.showError(this.explainCameraError(err));
      this.startBtn.disabled = false;
      return;
    }

    this.running = true;
    this.startedAt = performance.now();
    this.setupEl.hidden = true;
    this.doneEl.hidden = true;
    this.scanningEl.hidden = false;

    const s = this.camera.settings;
    if (s?.width && s.height) {
      this.stats.set('CAPTURE FPS', '—');
      this.progressLabel.textContent = `鏡頭 ${s.width}×${s.height}${s.frameRate ? ` @ ${Math.round(s.frameRate)}fps` : ''} · 等緊 manifest…`;
    }
    this.stats.start();
  }

  private async restart(): Promise<void> {
    this.releaseResult();
    this.doneEl.hidden = true;
    this.setupEl.hidden = false;
    this.startBtn.disabled = false;
    await this.start();
  }

  stop(): void {
    if (!this.running && this.pool.length === 0) return;
    this.teardown();
    this.stats.stop();
    this.scanningEl.hidden = true;
    // 已經有結果嘅話唔好熄咗個完成畫面
    if (this.doneEl.hidden) {
      this.setupEl.hidden = false;
      this.startBtn.disabled = false;
    }
  }

  private teardown(): void {
    this.running = false;
    this.wakeLock.release();
    this.camera.stop();
    for (const pw of this.pool) pw.worker.terminate();
    this.pool = [];
    this.inflight.clear();
    this.roi = null;
    this.roiCells = 0;
    this.roiBox.hidden = true;
  }

  private resetSession(): void {
    this.session = null;
    this.stream = null;
    this.manifest = null;
    this.decoder = null;
    this.foreignSessions.clear();
    this.dropped = 0;
    this.missStreak = 0;
    this.symbolsDecoded = 0;
    this.requestId = 0;
    this.stats.reset();
    this.progressBar.style.width = '0%';
  }

  private spawnPool(): void {
    const size = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('../workers/decode.worker.ts', import.meta.url), {
        type: 'module',
      });
      const pw: PoolWorker = { worker, busy: false };
      worker.onmessage = (e: MessageEvent<DecodeResponse>) => this.onDecodeResult(pw, e.data);
      worker.onerror = () => {
        pw.busy = false;
      };
      this.pool.push(pw);
    }
  }

  // ── 取幀 → 解碼 ───────────────────────────────────────

  private onCameraFrame(now: number): void {
    if (!this.running) return;
    this.captureMeter.tick(now);

    const vw = this.camera.frameWidth;
    const vh = this.camera.frameHeight;
    if (vw === 0 || vh === 0) return;

    const free = this.pool.find((w) => !w.busy);
    if (!free) {
      // 全部 worker 忙 —— 掉咗佢。排隊只會令延遲愈滾愈大，
      // 而 fountain code 對掉幀完全免疫
      this.dropped++;
      return;
    }

    const region = this.clampRegion(this.roi ?? { x: 0, y: 0, w: vw, h: vh }, vw, vh);
    const scale = Math.min(1, MAX_DECODE_DIM / Math.max(region.w, region.h));
    const cw = Math.max(1, Math.round(region.w * scale));
    const ch = Math.max(1, Math.round(region.h * scale));

    const ctx = this.ensureCanvas(cw, ch);
    ctx.drawImage(this.video, region.x, region.y, region.w, region.h, 0, 0, cw, ch);
    const image = ctx.getImageData(0, 0, cw, ch);

    free.busy = true;
    const id = ++this.requestId;
    this.inflight.set(id, { region, scale });

    const req: DecodeRequest = {
      type: 'decode',
      id,
      data: image.data,
      width: cw,
      height: ch,
    };
    free.worker.postMessage(req, [image.data.buffer]);
  }

  private ensureCanvas(w: number, h: number): CanvasRenderingContext2D {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!this.ctx) throw new Error('攞唔到取幀用嘅 2D context');
    }
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return this.ctx!;
  }

  private onDecodeResult(pw: PoolWorker, msg: DecodeResponse): void {
    pw.busy = false;
    const req = this.inflight.get(msg.id);
    this.inflight.delete(msg.id);
    if (!this.running) return;

    if (msg.symbols.length === 0) {
      this.missStreak++;
      if (this.roi && this.missStreak >= ROI_UNLOCK_MISSES) {
        // 用戶郁咗部機／發送端郁咗，返去掃全畫面重新搵
        this.roi = null;
        this.roiCells = 0;
        this.roiBox.hidden = true;
      }
      return;
    }

    this.missStreak = 0;
    // 一個相機幀可以帶返幾個獨立嘅 fountain 包（發送端排住 grid）——
    // decode fps 數嘅係相機幀，符號數另外計
    this.decodeMeter.tick(performance.now());
    this.symbolsDecoded += msg.symbols.length;

    // ROI 只喺「見到至少同以往一樣多格」嗰陣先更新。
    // 否則一個只解到一格嘅畫面就會令 ROI 縮到得嗰格咁細，
    // 之後永遠掃唔返其餘幾格 —— 一個會自我鎖死嘅陷阱
    if (req && msg.box && msg.symbols.length >= this.roiCells) {
      this.roiCells = msg.symbols.length;
      this.updateRoi(req, msg.box);
    }

    for (const bytes of msg.symbols) this.handleFrame(bytes);
    this.updateLiveStats();
  }

  // ── ROI 鎖定 ─────────────────────────────────────────

  private updateRoi(req: InFlight, box: Region): void {
    // box 係喺（已裁剪、已縮放）嗰張圖嘅座標，先換返做原始相機幀座標
    const cx = req.region.x + (box.x + box.w / 2) / req.scale;
    const cy = req.region.y + (box.y + box.h / 2) / req.scale;
    const w = (box.w / req.scale) * ROI_MARGIN;
    const h = (box.h / req.scale) * ROI_MARGIN;

    this.roi = this.clampRegion(
      { x: cx - w / 2, y: cy - h / 2, w, h },
      this.camera.frameWidth,
      this.camera.frameHeight,
    );
    this.paintRoiBox(this.roi);
  }

  private clampRegion(r: Region, vw: number, vh: number): Region {
    const w = Math.min(Math.max(16, Math.round(r.w)), vw);
    const h = Math.min(Math.max(16, Math.round(r.h)), vh);
    const x = Math.min(Math.max(0, Math.round(r.x)), vw - w);
    const y = Math.min(Math.max(0, Math.round(r.y)), vh - h);
    return { x, y, w, h };
  }

  /** 將 ROI 畫喺 video 上面。要處理 `object-fit: contain` 造成嘅黑邊。 */
  private paintRoiBox(roi: Region): void {
    const vw = this.camera.frameWidth;
    const vh = this.camera.frameHeight;
    const rect = this.stage.getBoundingClientRect();
    if (vw === 0 || vh === 0 || rect.width === 0) return;

    const scale = Math.min(rect.width / vw, rect.height / vh);
    const offsetX = (rect.width - vw * scale) / 2;
    const offsetY = (rect.height - vh * scale) / 2;

    this.roiBox.style.left = `${offsetX + roi.x * scale}px`;
    this.roiBox.style.top = `${offsetY + roi.y * scale}px`;
    this.roiBox.style.width = `${roi.w * scale}px`;
    this.roiBox.style.height = `${roi.h * scale}px`;
    this.roiBox.hidden = false;
  }

  // ── 幀處理 ────────────────────────────────────────────

  private handleFrame(bytes: Uint8Array): void {
    const frame = decodeFrame(bytes);
    if (!frame) return; // CRC 唔過 / 唔係我哋嘅幀 —— 靜靜哋掉咗佢

    if (frame.kind === 'manifest') {
      this.handleManifest(frame.sessionId, frame.manifest);
      return;
    }

    // v2：DATA 幀自述 blockCount / payloadSize，所以**第一個解到嘅幀就
    // 可以開始砌**，唔使等 manifest。以前喺等 manifest 期間收到嘅幀
    // 全部要掉，白白蝕咗成秒鐘嘅資料
    if (!this.adoptSession(frame.sessionId, frame.stream)) return;
    if (frame.payload.length !== this.decoder!.blockSize) return;

    this.decoder!.push(frame.seed, frame.payload);
    if (this.decoder!.isComplete) void this.finish();
  }

  /**
   * 決定收唔收呢個 session 嘅幀，需要就開一個新 decoder。
   * 回傳 false 代表呢一幀應該掉咗。
   */
  private adoptSession(sessionId: number, stream: StreamInfo): boolean {
    if (this.session === sessionId) return true;

    if (this.session !== null) {
      // 已經收緊另一個 session。發送端可能換咗檔案重播 —— 但都可能係
      // 一個誤解碼，所以要見到幾次先切換，唔好將收咗一半嘅進度扔咗
      const seen = (this.foreignSessions.get(sessionId) ?? 0) + 1;
      this.foreignSessions.set(sessionId, seen);
      if (seen < SESSION_SWITCH_THRESHOLD) return false;
    }

    this.session = sessionId;
    this.stream = stream;
    this.manifest = null; // 新 session，舊檔案資料唔再算數
    this.decoder = new LtDecoder(stream.blockCount, stream.blockSize);
    this.foreignSessions.clear();
    this.startedAt = performance.now();

    this.stats.set('SESSION', sessionId.toString(16).toUpperCase().padStart(4, '0'));
    this.stats.set('BLOCK LEN', `${stream.blockSize} B`);
    this.stats.set('PAYLOAD', formatBytes(stream.payloadSize));
    this.progressLabel.textContent = `收緊 ${formatBytes(stream.payloadSize)}…`;
    return true;
  }

  /**
   * MANIFEST 幀只帶「完成嗰陣先需要」嘅嘢：檔名、MIME、SHA-256、gzip flag。
   * 佢**唔會**再開 decoder —— 嗰個責任已經交咗畀 DATA 幀。
   */
  private handleManifest(sessionId: number, manifest: Omit<Manifest, 'blockSize'>): void {
    // 未見過任何 DATA 幀就唔好認 —— blockSize 只有 DATA 幀先知
    if (this.session !== sessionId || !this.stream) return;
    if (this.manifest) return; // 已經有咗，之後嘅插播唔使理

    if (manifest.blockCount !== this.stream.blockCount || manifest.payloadSize !== this.stream.payloadSize) {
      return; // 同 DATA 幀講嘅對唔上，寧可等下一個
    }

    this.manifest = { ...manifest, blockSize: this.stream.blockSize };
    this.progressLabel.textContent = `${manifest.fileName} · ${formatBytes(manifest.originalSize)}`;

    // 有可能 block 已經收齊咗，淨係等緊 manifest 先砌得成個檔案
    if (this.decoder?.isComplete) void this.finish();
  }

  private async finish(): Promise<void> {
    const decoder = this.decoder;
    const manifest = this.manifest;
    if (!decoder) return;
    if (!manifest) {
      // Block 收齊咗但 manifest 未到（細檔案有機會咁）。繼續掃住等 ——
      // manifest 每 4–32 幀就插播一次，好快就會嚟
      this.progressLabel.textContent = '資料收齊晒，等緊檔案資料…';
      return;
    }

    const elapsed = performance.now() - this.startedAt;
    this.teardown();
    this.stats.stop();

    let unpacked: Unpacked;
    try {
      unpacked = await unpackPayload(decoder.assemble(manifest.payloadSize), manifest);
    } catch (err) {
      this.scanningEl.hidden = true;
      this.setupEl.hidden = false;
      this.startBtn.disabled = false;
      this.showError(`還原失敗：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    this.result = unpacked;
    this.scanningEl.hidden = true;
    this.doneEl.hidden = false;

    const rate = manifest.originalSize / (elapsed / 1000);
    this.banner.className = `done-banner ${unpacked.hashOk ? 'ok' : 'bad'}`;
    this.banner.textContent = unpacked.hashOk
      ? `✓ 傳輸完成 — ${formatBytes(manifest.originalSize)}，用咗 ${formatDuration(elapsed)}（${formatRate(rate)}）`
      : '⚠ 收齊咗，但 SHA-256 對唔上 — 檔案可能有損';

    const rows = [
      `檔名：${manifest.fileName}`,
      `類型：${manifest.mimeType || '未知'}`,
      `大細：${formatBytes(manifest.originalSize)}`,
      `Block：${manifest.blockCount} × ${manifest.blockSize} B`,
      `收到嘅幀：新 ${decoder.packetsNew} / 重複 ${decoder.packetsDup} / 冗餘 ${decoder.packetsRedundant}`,
      `SHA-256：${unpacked.actualHash}`,
    ];
    if (!unpacked.hashOk) rows.push(`發送端聲稱：${unpacked.expectedHash}`);

    this.meta.replaceChildren(
      ...rows.map((text) => {
        const div = document.createElement('div');
        div.textContent = text;
        return div;
      }),
    );
  }

  private download(): void {
    if (!this.result || !this.manifest) return;
    this.revokeUrl();
    this.objectUrl = URL.createObjectURL(this.result.blob);

    const a = document.createElement('a');
    a.href = this.objectUrl;
    a.download = this.manifest.fileName;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    // 唔好即刻 revoke —— 部分瀏覽器要等下載真係開始咗先攞得到內容
    window.setTimeout(() => this.revokeUrl(), 60_000);
  }

  private revokeUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private releaseResult(): void {
    this.revokeUrl();
    this.result = null;
  }

  // ── 統計 ──────────────────────────────────────────────

  private updateLiveStats(): void {
    const now = performance.now();
    const capture = this.captureMeter.rate(now);
    const decode = this.decodeMeter.rate(now);

    this.stats.set('CAPTURE FPS', capture.toFixed(0));
    // 一個相機幀可以帶返幾個符號（發送端排住 grid），所以除咗幀率之外
    // 仲要顯示每幀解到幾多格 —— 嗰個先係真正嘅資料流入倍數
    this.stats.set(
      'DECODE FPS',
      this.roiCells > 1 ? `${decode.toFixed(1)} × ${this.roiCells} 格` : decode.toFixed(1),
      decode > 5 ? 'good' : 'hot',
    );
    this.stats.set('LOCK', this.roi ? '鎖定' : '搜尋中', this.roi ? 'good' : 'plain');
    this.stats.set('已解符號', String(this.symbolsDecoded));
    this.stats.set('DROPPED', String(this.dropped));
    this.stats.set('ELAPSED', formatDuration(now - this.startedAt));

    const decoder = this.decoder;
    if (!decoder) return;

    this.stats.set(
      'FRAMES NEW/DUP/RED',
      `${decoder.packetsNew}/${decoder.packetsDup}/${decoder.packetsRedundant}`,
    );
    const goodput = (decoder.solvedBlocks * decoder.blockSize) / ((now - this.startedAt) / 1000);
    this.stats.set('GOODPUT', formatRate(goodput), 'hot');

    // 用估算進度而唔係已解 block 數 —— 後者喺整個傳輸期間都會釘死喺 0%
    // 然後最後一刻彈到 100%（見 LtDecoder.estimatedProgress 嘅註釋）
    const pct = decoder.estimatedProgress * 100;
    this.progressBar.style.width = `${pct.toFixed(1)}%`;
    if (this.manifest) {
      this.progressLabel.textContent =
        `${this.manifest.fileName} · 收到 ${decoder.packetsNew} / 約 ${Math.ceil(expectedPackets(decoder.blockCount))} 幀（${pct.toFixed(0)}%）`;
    }
  }

  // ── 雜項 ──────────────────────────────────────────────

  private explainCameraError(err: unknown): string {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotAllowedError') {
      return '你拒絕咗鏡頭權限。請喺瀏覽器網址列嘅權限設定度重新允許，然後再試。';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return '搵唔到可用嘅鏡頭。';
    }
    if (name === 'NotReadableError') {
      return '鏡頭俾第個 app 佔用緊。請關閉其他用緊鏡頭嘅程式再試。';
    }
    if (!window.isSecureContext) {
      return '鏡頭需要 HTTPS。請用 https:// 開呢一頁（localhost 例外）。';
    }
    return err instanceof Error ? err.message : String(err);
  }

  private showError(message: string): void {
    this.errorEl.textContent = message;
    this.errorEl.hidden = false;
  }

  private hideError(): void {
    this.errorEl.hidden = true;
  }
}

function must<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`搵唔到 DOM 元素：${selector}`);
  return el;
}
