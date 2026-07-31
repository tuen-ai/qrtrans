import { LtEncoder } from '../protocol/lt-encoder';
import { encodeManifestFrame, encodeDataFrame, type Manifest } from '../protocol/frame';
import { encodeQrMatrix, getProfile, type ProfileId } from '../render/qr-encode';

/**
 * 發送端 worker：不停產生 fountain 包 → 編成 QR 模組矩陣 → 送返主線程。
 *
 * 點解要放喺 worker：v40 QR 每幀要行一次 Reed-Solomon 同 8 個 mask 嘅
 * 評分，係幾毫秒級嘅工作。放喺主線程做就一定 jank，QR 閃到唔穩定，
 * 相機一掃就掉幀。主線程淨係應該做一件事：`drawImage`。
 *
 * 流量控制用 credit：主線程每消耗一幀就 `ack` 一次，worker 先再產多一幀。
 * 咁樣 queue 永遠維持喺 PREBUFFER 左右，唔會愈積愈多食爆記憶體。
 */

export interface StartMessage {
  type: 'start';
  payload: Uint8Array;
  manifest: Manifest;
  profileId: ProfileId;
  sessionId: number;
  /** 隔幾多幀插播一次 manifest */
  manifestPeriod: number;
  /** 預先準備幾多幀 */
  prebuffer: number;
}

export type ToWorker = StartMessage | { type: 'ack' } | { type: 'stop' };

export interface FrameMessage {
  type: 'frame';
  /** 第幾幀（由開始播計起） */
  index: number;
  size: number;
  modules: Uint8Array;
  /** 呢幀係 manifest 定係 data */
  isManifest: boolean;
  /** payload byte 數，用嚟計 goodput */
  bytes: number;
}

export type FromWorker = FrameMessage | { type: 'error'; message: string };

let encoder: LtEncoder | null = null;
let manifestFrame: Uint8Array | null = null;
let scratch: Uint8Array | null = null;
let config: StartMessage | null = null;
let frameIndex = 0;
let credits = 0;
let pumping = false;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

/** 產生下一幀嘅 QR，送返主線程。 */
function produceFrame(): void {
  if (!encoder || !config || !manifestFrame || !scratch) return;
  const profile = getProfile(config.profileId);

  // 每 manifestPeriod 幀插播一次 manifest，令接收端隨時舉起手機都 lock 得到
  const isManifest = frameIndex % config.manifestPeriod === 0;
  let frameBytes: Uint8Array;
  if (isManifest) {
    frameBytes = manifestFrame;
  } else {
    const seed = encoder.next(scratch);
    frameBytes = encodeDataFrame(config.sessionId, seed, scratch);
  }

  const matrix = encodeQrMatrix(frameBytes, profile);
  post(
    {
      type: 'frame',
      index: frameIndex,
      size: matrix.size,
      modules: matrix.modules,
      isManifest,
      bytes: isManifest ? 0 : encoder.blockSize,
    },
    [matrix.modules.buffer],
  );
  frameIndex++;
}

/**
 * 有 credit 就繼續產幀。每產一幀就讓返控制權出去（`setTimeout(0)`），
 * 否則 worker 會塞住自己嘅 message queue，收唔到 `ack` / `stop`。
 */
function pump(): void {
  if (pumping) return;
  pumping = true;
  const step = () => {
    if (!encoder || credits <= 0) {
      pumping = false;
      return;
    }
    try {
      produceFrame();
      credits--;
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      encoder = null;
      pumping = false;
      return;
    }
    setTimeout(step, 0);
  };
  step();
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const msg = event.data;

  if (msg.type === 'start') {
    try {
      config = msg;
      const profile = getProfile(msg.profileId);
      encoder = new LtEncoder(msg.payload, msg.manifest.blockSize);
      scratch = new Uint8Array(msg.manifest.blockSize);
      manifestFrame = encodeManifestFrame(msg.sessionId, msg.manifest);
      if (manifestFrame.length > profile.capacity) {
        throw new Error(
          `manifest 幀 ${manifestFrame.length} bytes 塞唔落 ${profile.label}（${profile.capacity} bytes）—— 檔名太長？`,
        );
      }
      frameIndex = 0;
      credits = msg.prebuffer;
      pump();
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      encoder = null;
    }
    return;
  }

  if (msg.type === 'ack') {
    credits++;
    pump();
    return;
  }

  if (msg.type === 'stop') {
    encoder = null;
    manifestFrame = null;
    scratch = null;
    config = null;
    credits = 0;
  }
};
