import { LtEncoder } from '../protocol/lt-encoder';
import {
  encodeManifestFrame,
  encodeDataFrame,
  manifestPeriod,
  type Manifest,
} from '../protocol/frame';
import { encodeQrMatrix, getProfile, type ProfileId } from '../render/qr-encode';

/**
 * 發送端 worker：不停產生 fountain 包 → 編成 QR 模組矩陣 → 送返主線程。
 *
 * 點解要放喺 worker：QR 編碼加 Reed-Solomon 每幀都要一至幾毫秒。放喺
 * 主線程做就一定 jank，QR 閃到唔穩定，相機一掃就掉幀。主線程淨係應該
 * 做一件事：`drawImage`。
 *
 * **可以開幾個。** 每個 worker 只負責 `frameIndex % workerCount === workerId`
 * 嗰批幀，各自數自己嗰條。因為 fountain 包完全獨立、次序亦都無所謂，
 * 所以幾個 worker 之間唔使任何協調 —— 冇鎖、冇共享狀態、冇排序。
 *
 * 流量控制用 credit：主線程每消耗一幀就向**產生嗰個 worker** ack 一次，
 * 佢先再產多一幀。咁樣 queue 唔會愈積愈多食爆記憶體。
 */

export interface StartMessage {
  type: 'start';
  payload: Uint8Array;
  manifest: Manifest;
  profileId: ProfileId;
  sessionId: number;
  /** 呢個 worker 喺 pool 入面排第幾（0-based） */
  workerId: number;
  /** pool 一共幾多個 worker */
  workerCount: number;
  /** 呢個 worker 預先準備幾多幀 */
  prebuffer: number;
}

export type ToWorker = StartMessage | { type: 'ack' } | { type: 'stop' };

export interface FrameMessage {
  type: 'frame';
  /** 第幾幀（全 pool 共用同一個編號空間） */
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
let period = 12;
/** 呢個 worker 下一個要產嘅全域幀編號 */
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

  // 每 period 幀插播一次 manifest，令接收端攞到檔名、MIME 同 SHA-256
  const isManifest = frameIndex % period === 0;
  let frameBytes: Uint8Array;
  if (isManifest) {
    frameBytes = manifestFrame;
  } else {
    // seed 直接用全域幀編號 —— 各 worker 嘅編號唔會撞，所以 seed 亦唔會撞
    encoder.encodeSeed(frameIndex, scratch);
    frameBytes = encodeDataFrame(config.sessionId, frameIndex, config.manifest, scratch);
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
  // 跳去下一個屬於自己嘅編號
  frameIndex += config.workerCount;
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
      period = manifestPeriod(msg.manifest.blockCount);
      frameIndex = msg.workerId;
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
