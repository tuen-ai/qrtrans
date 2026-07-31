import { packFile, SOFT_SIZE_LIMIT } from '../codec/pack';
import { PROFILES, DEFAULT_PROFILE, getProfile, type ProfileId } from '../render/qr-encode';
import { QrPainter } from '../render/qr-painter';
import { StatsPanel, RateMeter, formatBytes, formatRate, formatDuration } from './stats';
import type { FromWorker, ToWorker } from '../workers/encode.worker';

/**
 * 發送端：揀檔案 → 打包 → 開 worker 產 QR → 逐幀閃。
 *
 * 主線程喺播放期間只做兩件事：`painter.draw()` 同 `postMessage({type:'ack'})`。
 * 所有重工（fountain 產包 + QR 編碼）都喺 worker，所以幀率好穩。
 */

/** 隔幾多幀插播一次 manifest。太疏 → 接收端要等好耐先 lock 到；太密 → 蝕頻寬。 */
const MANIFEST_PERIOD = 12;
/** 預先準備幾多幀。太少會斷流，太多食記憶體又令 stop 反應慢。 */
const PREBUFFER = 8;

const STAT_KEYS = [
  '檔案',
  '原始大細',
  '實際傳送',
  'BLOCK LEN',
  'BLOCK 數 (K)',
  '目標 FPS',
  '實際 FPS',
  '已播幀數',
  '理論吞吐',
  'ELAPSED',
  'SESSION',
  '緩衝',
] as const;

interface QueuedFrame {
  size: number;
  modules: Uint8Array;
  isManifest: boolean;
  bytes: number;
}

export class SenderView {
  private readonly setupEl: HTMLElement;
  private readonly playingEl: HTMLElement;
  private readonly dropZone: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly profileSelect: HTMLSelectElement;
  private readonly profileHint: HTMLElement;
  private readonly fpsSelect: HTMLSelectElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly fullscreenBtn: HTMLButtonElement;
  private readonly errorEl: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly painter: QrPainter;
  private readonly stats: StatsPanel;

  private file: File | null = null;
  private worker: Worker | null = null;
  private queue: QueuedFrame[] = [];
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** 上次量尺寸嗰陣係幾多個模組；變咗就要重新量 */
  private sizedFor = 0;

  private startedAt = 0;
  private framesShown = 0;
  private lastFrameAt = 0;
  private readonly fpsMeter = new RateMeter();
  private targetFps = 30;
  private running = false;

  constructor(root: HTMLElement) {
    this.setupEl = must(root, '#send-setup');
    this.playingEl = must(root, '#send-playing');
    this.dropZone = must(root, '#drop-zone');
    this.fileInput = must(root, '#file-input');
    this.profileSelect = must(root, '#profile-select');
    this.profileHint = must(root, '#profile-hint');
    this.fpsSelect = must(root, '#fps-select');
    this.startBtn = must(root, '#send-start');
    this.stopBtn = must(root, '#send-stop');
    this.fullscreenBtn = must(root, '#send-fullscreen');
    this.errorEl = must(root, '#send-error');
    this.stage = must(root, '#qr-stage');

    this.painter = new QrPainter(must<HTMLCanvasElement>(root, '#qr-canvas'));
    this.stats = new StatsPanel(must(root, '#send-stats'), STAT_KEYS);

    this.buildProfileOptions();
    this.wireFilePicking();

    this.profileSelect.addEventListener('change', () => this.onProfileChange());
    this.fpsSelect.addEventListener('change', () => {
      this.targetFps = Number(this.fpsSelect.value);
      this.stats.set('目標 FPS', String(this.targetFps));
    });
    this.startBtn.addEventListener('click', () => void this.start());
    this.stopBtn.addEventListener('click', () => this.stop());
    this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
  }

  // ── 設定階段 ──────────────────────────────────────────

  private buildProfileOptions(): void {
    for (const profile of Object.values(PROFILES)) {
      const opt = document.createElement('option');
      opt.value = profile.id;
      opt.textContent = `${profile.label} — v${profile.version}-${profile.level}，每幀 ${profile.blockSize} B`;
      this.profileSelect.append(opt);
    }
    // 手機螢幕細，QR 畫得細，v40 幾乎唔可能掃得到 —— 預設幫用戶降檔
    const isSmallScreen = Math.min(window.screen.width, window.screen.height) < 600;
    this.profileSelect.value = isSmallScreen ? 'safe' : DEFAULT_PROFILE;
    if (isSmallScreen) this.fpsSelect.value = '20';
    this.targetFps = Number(this.fpsSelect.value);
    this.onProfileChange();
  }

  private onProfileChange(): void {
    this.profileHint.textContent = getProfile(this.selectedProfileId()).hint;
    if (this.file) this.showFileSummary(this.file);
  }

  private selectedProfileId(): ProfileId {
    return this.profileSelect.value as ProfileId;
  }

  private wireFilePicking(): void {
    this.dropZone.addEventListener('click', () => this.fileInput.click());
    this.dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.fileInput.click();
      }
    });
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) this.acceptFile(file);
    });

    for (const type of ['dragenter', 'dragover'] as const) {
      this.dropZone.addEventListener(type, (e) => {
        e.preventDefault();
        this.dropZone.classList.add('dragover');
      });
    }
    for (const type of ['dragleave', 'drop'] as const) {
      this.dropZone.addEventListener(type, () => this.dropZone.classList.remove('dragover'));
    }
    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file) this.acceptFile(file);
    });
  }

  private acceptFile(file: File): void {
    this.file = file;
    this.startBtn.disabled = false;
    this.hideError();
    this.showFileSummary(file);
    if (file.size > SOFT_SIZE_LIMIT) {
      this.showError(
        `${formatBytes(file.size)} 係大咗啲。傳得完，但要播好耐，而且接收端會食唔少記憶體。`,
      );
    }
  }

  private showFileSummary(file: File): void {
    const profile = getProfile(this.selectedProfileId());
    // 未壓縮前嘅粗略估算，畀用戶有個心理準備
    const blocks = Math.ceil(file.size / profile.blockSize);
    const framesNeeded = blocks * 1.5; // 實測掉幀之下大約 1.5×K
    const seconds = framesNeeded / this.targetFps;
    const title = must<HTMLElement>(this.dropZone, '.dropzone-title');
    const hint = must<HTMLElement>(this.dropZone, '.dropzone-hint');
    title.textContent = file.name;
    hint.textContent = `${formatBytes(file.size)} · 約 ${blocks} 個 block · 估計 ${formatDuration(seconds * 1000)}（未計壓縮）`;
  }

  // ── 播放 ──────────────────────────────────────────────

  private async start(): Promise<void> {
    if (!this.file || this.running) return;
    this.hideError();
    this.startBtn.disabled = true;

    const profile = getProfile(this.selectedProfileId());
    let packed;
    try {
      packed = await packFile(this.file, profile.blockSize);
    } catch (err) {
      this.showError(`打包失敗：${err instanceof Error ? err.message : String(err)}`);
      this.startBtn.disabled = false;
      return;
    }

    const sessionId = crypto.getRandomValues(new Uint16Array(1))[0]!;

    this.running = true;
    this.queue = [];
    this.framesShown = 0;
    this.startedAt = performance.now();
    this.lastFrameAt = 0;
    this.setupEl.hidden = true;
    this.playingEl.hidden = false;

    this.stats.set('檔案', packed.manifest.fileName);
    this.stats.set('原始大細', formatBytes(packed.manifest.originalSize));
    this.stats.set(
      '實際傳送',
      packed.compressionRatio > 0.01
        ? `${formatBytes(packed.payload.length)}（壓縮 ${(packed.compressionRatio * 100).toFixed(0)}%）`
        : formatBytes(packed.payload.length),
      packed.compressionRatio > 0.01 ? 'good' : 'plain',
    );
    this.stats.set('BLOCK LEN', `${packed.manifest.blockSize} B`);
    this.stats.set('BLOCK 數 (K)', String(packed.manifest.blockCount));
    this.stats.set('目標 FPS', String(this.targetFps));
    this.stats.set('SESSION', sessionId.toString(16).toUpperCase().padStart(4, '0'));
    this.stats.start();

    this.worker = new Worker(new URL('../workers/encode.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e) => this.failPlayback(e.message || 'worker 出錯');

    const startMsg: ToWorker = {
      type: 'start',
      payload: packed.payload,
      manifest: packed.manifest,
      profileId: profile.id,
      sessionId,
      manifestPeriod: MANIFEST_PERIOD,
      prebuffer: PREBUFFER,
    };
    // payload 直接 transfer 過去，唔使複製（之後主線程用唔著佢）
    this.worker.postMessage(startMsg, [packed.payload.buffer]);

    this.observeResize();
    this.rafId = requestAnimationFrame((t) => this.tick(t));
  }

  private onWorkerMessage(msg: FromWorker): void {
    if (msg.type === 'error') {
      this.failPlayback(msg.message);
      return;
    }
    this.queue.push({
      size: msg.size,
      modules: msg.modules,
      isManifest: msg.isManifest,
      bytes: msg.bytes,
    });
  }

  /**
   * 每個顯示刷新叫一次。用累積時間去決定要唔要換下一幀 ——
   * 咁樣 30fps 目標喺 60Hz / 120Hz 螢幕上都準。
   */
  private tick(now: number): void {
    if (!this.running) return;
    this.rafId = requestAnimationFrame((t) => this.tick(t));

    const interval = 1000 / this.targetFps;
    // 容忍半幀誤差，唔好因為 rAF 差少少就跳過一整幀
    if (this.lastFrameAt !== 0 && now - this.lastFrameAt < interval * 0.9) return;

    const frame = this.queue.shift();
    if (!frame) return; // worker 未追到，今個刷新維持上一幀

    this.painter.setMatrix(frame.size, frame.modules);
    // 第一幀到咗（或者用戶轉咗檔位令 QR 版本變）之後先至知道要點樣量尺寸
    if (this.sizedFor !== this.painter.modulesPerSide) this.applySize();
    this.painter.draw();
    this.worker?.postMessage({ type: 'ack' } satisfies ToWorker);

    this.lastFrameAt = now;
    this.framesShown++;
    this.fpsMeter.tick(now);
    this.updateLiveStats(now);
  }

  private updateLiveStats(now: number): void {
    const elapsed = now - this.startedAt;
    const fps = this.fpsMeter.rate(now);
    this.stats.set('實際 FPS', fps.toFixed(1), fps >= this.targetFps * 0.9 ? 'good' : 'hot');
    this.stats.set('已播幀數', String(this.framesShown));
    this.stats.set('ELAPSED', formatDuration(elapsed));
    this.stats.set('緩衝', `${this.queue.length} / ${PREBUFFER}`, this.queue.length === 0 ? 'hot' : 'plain');

    const profile = getProfile(this.selectedProfileId());
    // 「理論吞吐」= 假設接收端一幀都唔漏嘅上限，用嚟同接收端實際 goodput 對比
    const dataFraction = 1 - 1 / MANIFEST_PERIOD;
    this.stats.set('理論吞吐', formatRate(profile.blockSize * this.targetFps * dataFraction));
  }

  /**
   * 重新計 QR 顯示尺寸。
   *
   * 一定要由**闊度**同視窗高度去計，唔可以用 `.qr-stage` 嘅高度 ——
   * 個 stage 嘅高度係由入面個 canvas 撐起嘅，攞佢嚟計就會變成循環依賴，
   * canvas 會永遠卡喺 300px 預設值。
   */
  private applySize = (): void => {
    if (this.painter.modulesPerSide === 0) return;
    const pad = 24; // .qr-stage 上下左右嘅 padding
    const available = Math.min(
      this.stage.clientWidth - pad,
      // 留返位畀統計面板同掣，唔好要用戶捲屏先見到成個 QR
      window.innerHeight * 0.62,
    );
    this.painter.resize(Math.max(120, available), window.devicePixelRatio || 1);
    this.sizedFor = this.painter.modulesPerSide;
    this.painter.draw();
  };

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(this.applySize);
    // 觀察 stage 嘅父元素：佢嘅闊度先係真正嘅可用空間
    this.resizeObserver.observe(this.stage.parentElement ?? this.stage);
    window.addEventListener('resize', this.applySize);
    this.applySize();
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void this.stage.requestFullscreen?.().catch(() => {
        this.showError('呢個瀏覽器唔支援全螢幕（iOS Safari 就係咁）。可以將視窗拉大啲代替。');
      });
    }
  }

  private failPlayback(message: string): void {
    this.stop();
    this.showError(`播放出錯：${message}`);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener('resize', this.applySize);
    this.sizedFor = 0;

    this.worker?.postMessage({ type: 'stop' } satisfies ToWorker);
    this.worker?.terminate();
    this.worker = null;
    this.queue = [];

    this.stats.stop();
    this.painter.clear();
    this.playingEl.hidden = true;
    this.setupEl.hidden = false;
    this.startBtn.disabled = this.file === null;
    if (document.fullscreenElement) void document.exitFullscreen();
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
