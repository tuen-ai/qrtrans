/**
 * 相機取幀。
 *
 * 用 `requestVideoFrameCallback()` 而唔係 `requestAnimationFrame()`：
 * rAF 跟顯示器刷新，同相機嘅出幀節奏冇關係，所以會**又重複又漏**——
 * 同一幀解兩次係白做，漏咗嘅幀就係永遠失去嘅資料。rVFC 保證每一個
 * 相機幀啱啱好行一次。
 */

/** rVFC 喺舊 TS lib 入面未有定義。 */
interface VideoFrameMetadata {
  presentationTime: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
}

type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?(
    cb: (now: number, metadata: VideoFrameMetadata) => void,
  ): number;
  cancelVideoFrameCallback?(handle: number): void;
};

export interface CameraOptions {
  /** 每個相機幀叫一次。`now` 係 `performance.now()` 時間軸。 */
  onFrame(now: number): void;
}

export class Camera {
  private stream: MediaStream | null = null;
  private handle: number | null = null;
  private rafId: number | null = null;
  private running = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly options: CameraOptions,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  get frameWidth(): number {
    return this.video.videoWidth;
  }

  get frameHeight(): number {
    return this.video.videoHeight;
  }

  /** 目前實際拎到嘅解像度同幀率，顯示畀用戶睇（真實值同 ideal 好多時唔同）。 */
  get settings(): MediaTrackSettings | null {
    return this.stream?.getVideoTracks()[0]?.getSettings() ?? null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('呢個瀏覽器唔支援相機（getUserMedia）。需要 HTTPS 同一個正常瀏覽器。');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        // 高解像度先睇得清密集嘅 QR 模組；高幀率先跟得上閃爍
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      },
      audio: false,
    });

    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', ''); // iOS：唔好自動全螢幕播
    await this.video.play();

    // 對焦交畀相機自己 —— 動態 QR 距離唔變，連續自動對焦通常最穩
    this.running = true;
    this.pump();
  }

  private pump(): void {
    const video = this.video as RvfcVideo;

    if (typeof video.requestVideoFrameCallback === 'function') {
      const step = (now: number) => {
        if (!this.running) return;
        this.options.onFrame(now);
        this.handle = video.requestVideoFrameCallback!(step);
      };
      this.handle = video.requestVideoFrameCallback(step);
      return;
    }

    // 後備（舊 Safari）：rAF 會重複解同一幀，但總好過完全用唔到
    const step = (now: number) => {
      if (!this.running) return;
      this.options.onFrame(now);
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  stop(): void {
    this.running = false;

    const video = this.video as RvfcVideo;
    if (this.handle !== null && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(this.handle);
    }
    this.handle = null;

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // 一定要逐條 track stop，否則相機指示燈會繼續著
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
  }
}
