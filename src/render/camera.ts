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

export interface CameraOption {
  deviceId: string;
  /** 瀏覽器畀嘅名。未攞權限之前係空字串 */
  label: string;
  /** 適合掃 QR 嘅程度，愈大愈好（見 `scoreCamera`） */
  score: number;
}

/**
 * 幫每個鏡頭評分，愈大愈適合掃 QR。
 *
 * **點解要揀鏡頭：** `facingMode: 'environment'` 由瀏覽器決定用邊個後置
 * 鏡頭，而多鏡頭手機好多時會揀「超廣角」。超廣角對掃 QR 係最差嘅選擇：
 * 桶形畸變會扭曲模組網格，而且同樣距離之下主體佔嘅像素少一截 ——
 * 直接撞穿「每模組 3 個像素」條底線。
 *
 * 仲有一個更隱蔽嘅：iOS 嘅「Dual / Triple Camera」係一個**虛擬**鏡頭，
 * 會按距離自己切換實體鏡頭。掃到一半突然由主鏡跳去超廣角，解碼率會
 * 無端端插水，而且睇落好似「靠近咗反而掃唔到」。
 *
 * iOS Safari 嘅 label 好清楚（"Back Camera" / "Back Ultra Wide Camera"），
 * 所以呢個評分喺 iPhone 上好準。Android Chrome 多數係
 * "camera2 0, facing back" 咁樣冇資訊，評分幫唔到手 —— 嗰陣就靠
 * 「後置嘅第一個」，通常就係主鏡。
 */
export function scoreCamera(label: string): number {
  const l = label.toLowerCase();
  let score = 0;

  // 後置優先（前置自拍鏡頭掃唔到對面部機）
  if (/back|rear|environment|後置|后置/.test(l)) score += 100;
  if (/front|face|user|前置/.test(l)) score -= 100;

  // 超廣角：畸變 + 主體太細，最差
  if (/ultra.?wide|超廣角|超广角|廣角|广角/.test(l)) score -= 60;
  // 虛擬多鏡頭：會喺掃描途中自己切換鏡頭
  if (/dual|triple|virtual/.test(l)) score -= 25;
  // 長焦：遠距離掃反而好，但近距離對唔到焦
  if (/telephoto|長焦|长焦/.test(l)) score += 5;
  // 乾淨嘅「後置鏡頭」通常就係主鏡
  if (/^back camera$|^rear camera$/.test(l.trim())) score += 30;

  return score;
}

/**
 * 列出所有可用鏡頭，最適合掃 QR 嗰個排頭。
 *
 * **一定要喺攞到權限之後先叫。** 未授權之前 `enumerateDevices()` 雖然
 * 會列到裝置，但 `label` 全部係空字串（防指紋追蹤），咁就評唔到分、
 * 用戶亦都揀唔到。
 */
export async function listCameras(): Promise<CameraOption[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `鏡頭 ${i + 1}`,
      score: scoreCamera(d.label),
    }))
    .sort((a, b) => b.score - a.score);
}

export class Camera {
  private stream: MediaStream | null = null;
  private handle: number | null = null;
  private rafId: number | null = null;
  private running = false;
  /** 每次 start 遞增；舊 rVFC 鏈見到對唔上就會自行終止 */
  private generation = 0;
  /** 實際協商到嘅組合，顯示畀用戶睇 */
  private negotiated = '';

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

  /** 而家用緊邊個鏡頭（deviceId）。 */
  get activeDeviceId(): string | null {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null;
  }

  /**
   * 開鏡頭。
   *
   * 畀咗 `deviceId` 就用嗰個實體鏡頭；冇就交返畀瀏覽器用 `facingMode`
   * 揀（多鏡頭手機好多時會揀到超廣角，所以 UI 會鼓勵用戶自己揀）。
   */
  async start(deviceId?: string): Promise<void> {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('呢個瀏覽器唔支援相機（getUserMedia）。需要 HTTPS 同一個正常瀏覽器。');
    }

    this.stream = await this.openBestStream(deviceId);

    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', ''); // iOS：唔好自動全螢幕播
    await this.video.play();

    // 對焦交畀相機自己 —— 動態 QR 距離唔變，連續自動對焦通常最穩
    this.running = true;
    this.generation++;
    this.pump(this.generation);
  }

  /**
   * 逐級試，攞到最好嗰個組合為止。
   *
   * **`frameRate: { ideal: 60 }` 喺 iOS 會靜靜雞畀返你 30。** `ideal` 對
   * iOS 嚟講只係「建議」，佢會照樣揀 30fps 嘅模式，而且完全唔會報錯 ——
   * 即係接收速度直接減半而你唔會知。要用 `exact` 佢先至真係畀你 60，
   * 但 `exact` 喺攞唔到嗰陣會掟 OverconstrainedError，所以要有後備。
   *
   * 60fps 通常喺 1280 闊度先取得到（1920 + 60fps 好多鏡頭做唔到），
   * 所以順序係：先保幀率，再保解像度。
   */
  private async openBestStream(deviceId?: string): Promise<MediaStream> {
    // 指定咗鏡頭就用 `exact` —— 用 `ideal` 嘅話瀏覽器可以照樣揀第二個，
    // 用戶明明揀咗主鏡結果又係超廣角，仲衰過冇得揀
    const pick: MediaTrackConstraints = deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: 'environment' } };

    const ladder: Array<{ label: string; video: MediaTrackConstraints }> = [
      {
        label: '1920×1080 @ 60fps（exact）',
        video: { ...pick, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { exact: 60 } },
      },
      {
        label: '1280×720 @ 60fps（exact）',
        video: { ...pick, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { exact: 60 } },
      },
      {
        label: '1920×1080 @ 60fps（ideal）',
        video: { ...pick, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
      },
      {
        label: '預設',
        video: { ...pick },
      },
    ];

    let lastError: unknown;
    for (const rung of ladder) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: rung.video, audio: false });
        this.negotiated = rung.label;
        return stream;
      } catch (err) {
        lastError = err;
        // OverconstrainedError 代表呢級太苛刻，試下一級。
        // 但權限被拒／冇鏡頭就再試都冇用，即刻掟返出去
        const name = err instanceof DOMException ? err.name : '';
        if (name === 'NotAllowedError' || name === 'NotFoundError' || name === 'NotReadableError') {
          throw err;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('開唔到鏡頭');
  }

  /**
   * 每個相機幀叫一次 `onFrame`。
   *
   * `gen` 係防殭屍迴圈嘅關鍵：**已經排隊咗嘅 rVFC callback 會活過
   * `stop()`，並且喺下一條 stream 開始時復活。** 淨係靠一個 `running`
   * boolean 唔夠 —— stop → start 之後 `running` 又變返 true，嗰個舊
   * callback 醒返之後就會再掛多一條鏈，於是兩條 capture loop 同時行，
   * 白白食雙倍 CPU 兼搶 worker。每次 start 遞增 generation，舊鏈見到
   * 對唔上就自己死。
   */
  private pump(gen: number): void {
    const video = this.video as RvfcVideo;

    if (typeof video.requestVideoFrameCallback === 'function') {
      const step = (now: number) => {
        if (!this.running || gen !== this.generation) return;
        this.options.onFrame(now);
        this.handle = video.requestVideoFrameCallback!(step);
      };
      this.handle = video.requestVideoFrameCallback(step);
      return;
    }

    // 後備（舊 Safari）：rAF 會重複解同一幀，但總好過完全用唔到
    const step = (now: number) => {
      if (!this.running || gen !== this.generation) return;
      this.options.onFrame(now);
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  /** 攞到嘅係階梯上邊一級（診斷用）。 */
  get negotiatedLabel(): string {
    return this.negotiated;
  }

  stop(): void {
    this.running = false;
    // 遞增之後，任何仲排住隊嘅 callback 都會即刻自我了斷
    this.generation++;

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
