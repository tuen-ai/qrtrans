import { describe, it, expect, afterEach } from 'vitest';
import { Camera, listCameras, scoreCamera } from '../src/render/camera';

/**
 * `Camera` 嘅生命週期防護。
 *
 * 呢度用一個**故意唔理會 `cancelVideoFrameCallback`** 嘅假 video 元素。
 * 咁做係有意嘅：真實世界有瀏覽器係咁樣，已排隊嘅 rVFC callback 會活過
 * `stop()`，然後喺下一條 stream 開始時復活。喺 Chromium 度 cancel 係
 * 可靠嘅，所以真瀏覽器測試**捉唔到**呢個問題（我試過，冇 generation
 * counter 都照過）—— 要重現就一定要模擬嗰種行為。
 *
 * 冇 generation counter 嘅話：停一次再開就會多一條 capture 鏈，
 * 每個相機幀被處理兩次，白食雙倍 CPU 兼搶晒 decode worker。
 */

type FrameCb = (now: number, meta: unknown) => void;

/** 假 video：記住所有 callback，而 cancel 係一個 no-op。 */
class LeakyVideo {
  pending: Array<{ id: number; cb: FrameCb }> = [];
  cancelled: number[] = [];
  srcObject: unknown = null;
  videoWidth = 640;
  videoHeight = 480;
  private nextId = 1;

  requestVideoFrameCallback(cb: FrameCb): number {
    const id = this.nextId++;
    this.pending.push({ id, cb });
    return id;
  }

  /** 記低有人叫過，但**唔會**真係取消 —— 呢個就係要模擬嘅壞行為。 */
  cancelVideoFrameCallback(id: number): void {
    this.cancelled.push(id);
  }

  setAttribute(): void {}
  play(): Promise<void> {
    return Promise.resolve();
  }

  /** 派發目前排住隊嘅 callback（唔包括佢哋期間新掛嘅）。 */
  flush(now = 0): void {
    const batch = this.pending;
    this.pending = [];
    for (const { cb } of batch) cb(now, {});
  }
}

function fakeTrack() {
  return { stop: () => {}, getSettings: () => ({ width: 640, height: 480, frameRate: 30 }) };
}

function installFakeMediaDevices(): void {
  const track = fakeTrack();
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: { getUserMedia: async () => stream },
      hardwareConcurrency: 4,
    },
  });
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
});

describe('Camera 生命週期', () => {
  it('就算瀏覽器唔理會 cancel，停咗再開都只會有一條 capture 鏈', async () => {
    installFakeMediaDevices();
    const video = new LeakyVideo();
    let frames = 0;
    const camera = new Camera(video as unknown as HTMLVideoElement, {
      onFrame: () => {
        frames++;
      },
    });

    await camera.start();
    video.flush();
    expect(frames).toBe(1); // 一條鏈 = 每次 flush 一幀

    // 停 → 開三次。每次都會留低一個「未被取消」嘅 callback
    for (let i = 0; i < 3; i++) {
      camera.stop();
      await camera.start();
    }

    // 而家排隊入面有：3 個殭屍 + 1 個新鏈嘅 callback
    expect(video.pending.length).toBeGreaterThan(1);
    expect(video.cancelled.length).toBeGreaterThan(0); // 確認我哋真係有叫過 cancel

    frames = 0;
    video.flush();
    expect(frames, '殭屍鏈復活咗 —— 每個相機幀被處理多過一次').toBe(1);

    // 再 flush 幾次：如果有殭屍鏈自我延續，數字會愈滾愈大
    for (let i = 0; i < 5; i++) {
      frames = 0;
      video.flush();
      expect(frames, `第 ${i + 2} 次 flush 收到 ${frames} 幀`).toBe(1);
    }

    camera.stop();
  });

  it('stop() 之後唔會再有 onFrame', async () => {
    installFakeMediaDevices();
    const video = new LeakyVideo();
    let frames = 0;
    const camera = new Camera(video as unknown as HTMLVideoElement, {
      onFrame: () => {
        frames++;
      },
    });

    await camera.start();
    camera.stop();
    frames = 0;
    video.flush();
    video.flush();
    expect(frames).toBe(0);
  });

  it('相機約束用階梯逐級降級，並記低實際攞到嗰級', async () => {
    // 頭兩級（exact 60fps）掟 OverconstrainedError，第三級成功
    const attempts: MediaTrackConstraints[] = [];
    const track = fakeTrack();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async (c: MediaStreamConstraints) => {
            attempts.push(c.video as MediaTrackConstraints);
            if (attempts.length <= 2) {
              throw new DOMException('over-constrained', 'OverconstrainedError');
            }
            return { getTracks: () => [track], getVideoTracks: () => [track] };
          },
        },
      },
    });

    const video = new LeakyVideo();
    const camera = new Camera(video as unknown as HTMLVideoElement, { onFrame: () => {} });
    await camera.start();

    // 頭兩次一定要試 exact —— iOS 對 ideal 會靜靜雞畀返 30fps
    expect((attempts[0]!.frameRate as ConstrainDoubleRange).exact).toBe(60);
    expect((attempts[1]!.frameRate as ConstrainDoubleRange).exact).toBe(60);
    // 第二級要降解像度先有機會攞到 60fps
    expect((attempts[1]!.width as ConstrainULongRange).ideal).toBe(1280);
    // 第三級先至退返做 ideal
    expect((attempts[2]!.frameRate as ConstrainDoubleRange).ideal).toBe(60);
    expect(camera.negotiatedLabel).toContain('ideal');

    camera.stop();
  });

  it('權限被拒就即刻放棄，唔會再試低級數（避免連環彈權限）', async () => {
    let calls = 0;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            calls++;
            throw new DOMException('denied', 'NotAllowedError');
          },
        },
      },
    });

    const video = new LeakyVideo();
    const camera = new Camera(video as unknown as HTMLVideoElement, { onFrame: () => {} });
    await expect(camera.start()).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('鏡頭揀選', () => {
  it('超廣角同虛擬多鏡頭排喺主鏡後面', () => {
    // iOS Safari 真實會出嘅 label
    const main = scoreCamera('Back Camera');
    const ultra = scoreCamera('Back Ultra Wide Camera');
    const dual = scoreCamera('Back Dual Wide Camera');
    const tele = scoreCamera('Back Telephoto Camera');
    const front = scoreCamera('Front Camera');

    // 主鏡要贏晒 —— 超廣角有桶形畸變兼主體太細，
    // 而 Dual/Triple 係虛擬鏡頭，會喺掃描途中自己切換實體鏡頭
    expect(main).toBeGreaterThan(ultra);
    expect(main).toBeGreaterThan(dual);
    expect(main).toBeGreaterThan(tele);
    // 前置鏡頭根本影唔到對面部機
    expect(front).toBeLessThan(0);
    expect(main).toBeGreaterThan(front);
  });

  it('Android 冇資訊嘅 label 唔會被誤判成差鏡頭', () => {
    // Android Chrome 通常係咁：完全冇線索
    const a = scoreCamera('camera2 0, facing back');
    const b = scoreCamera('camera2 1, facing front');
    expect(a).toBeGreaterThan(b); // 至少分得到前後
    expect(a).toBeGreaterThan(0); // 唔會因為冇資訊就當佢差
  });

  it('listCameras 只列 videoinput，而且最適合嗰個排頭', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          enumerateDevices: async () => [
            { kind: 'audioinput', deviceId: 'mic', label: 'Microphone' },
            { kind: 'videoinput', deviceId: 'ultra', label: 'Back Ultra Wide Camera' },
            { kind: 'videoinput', deviceId: 'front', label: 'Front Camera' },
            { kind: 'videoinput', deviceId: 'main', label: 'Back Camera' },
          ],
        },
      },
    });

    const cameras = await listCameras();
    expect(cameras.map((c) => c.deviceId)).toEqual(['main', 'ultra', 'front']);
    expect(cameras[0]!.label).toBe('Back Camera');
  });

  it('冇 label（未攞權限）都唔會爆，會出佔位名', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          enumerateDevices: async () => [
            { kind: 'videoinput', deviceId: 'a', label: '' },
            { kind: 'videoinput', deviceId: 'b', label: '' },
          ],
        },
      },
    });
    const cameras = await listCameras();
    expect(cameras).toHaveLength(2);
    expect(cameras[0]!.label).toMatch(/鏡頭 \d/);
  });

  it('指定 deviceId 要用 exact，而且唔可以再帶 facingMode', async () => {
    // 用 ideal 嘅話瀏覽器可以照樣揀第二個鏡頭 —— 用戶明明揀咗主鏡
    // 結果又係超廣角，仲衰過冇得揀
    const attempts: MediaTrackConstraints[] = [];
    const track = { stop: () => {}, getSettings: () => ({ deviceId: 'main' }) };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async (c: MediaStreamConstraints) => {
            attempts.push(c.video as MediaTrackConstraints);
            return { getTracks: () => [track], getVideoTracks: () => [track] };
          },
        },
      },
    });

    const video = new LeakyVideo();
    const camera = new Camera(video as unknown as HTMLVideoElement, { onFrame: () => {} });
    await camera.start('main');

    const first = attempts[0]!;
    expect((first.deviceId as ConstrainDOMStringParameters).exact).toBe('main');
    expect(first.facingMode).toBeUndefined();
    expect(camera.activeDeviceId).toBe('main');
    camera.stop();
  });

  it('冇指定 deviceId 就用 facingMode 交返畀瀏覽器揀', async () => {
    const attempts: MediaTrackConstraints[] = [];
    const track = { stop: () => {}, getSettings: () => ({}) };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async (c: MediaStreamConstraints) => {
            attempts.push(c.video as MediaTrackConstraints);
            return { getTracks: () => [track], getVideoTracks: () => [track] };
          },
        },
      },
    });

    const video = new LeakyVideo();
    const camera = new Camera(video as unknown as HTMLVideoElement, { onFrame: () => {} });
    await camera.start();
    expect((attempts[0]!.facingMode as ConstrainDOMStringParameters).ideal).toBe('environment');
    expect(attempts[0]!.deviceId).toBeUndefined();
    camera.stop();
  });
});
