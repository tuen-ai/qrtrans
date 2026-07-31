import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, globSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { tmpdir } from 'node:os';

import { packFile } from '../src/codec/pack';
import { LtEncoder } from '../src/protocol/lt-encoder';
import { encodeManifestFrame, encodeDataFrame } from '../src/protocol/frame';
import { encodeQrMatrix, PROFILES } from '../src/render/qr-encode';
import { Prng } from '../src/protocol/prng';

/**
 * 真瀏覽器測試。
 *
 * 兩個部分：
 *
 * 1. **煙霧測試** —— app 載入、worker 起得到、QR 真係逐幀喺度變，
 *    而且**冇任何外部網絡請求**（私隱要求嘅自動化驗證）。
 *
 * 2. **假鏡頭端到端** —— 將 QR 序列打包成一條 Y4M 影片餵畀 Chromium
 *    嘅 fake camera，然後行真正嘅接收端。呢個係唯一測得到 `camera.ts`、
 *    ROI 鎖定、worker pool 同 UI 串埋一齊行唔行得通嘅方法。
 */

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIST = join(REPO, 'dist');

/** 影片解像度。QR 連靜區 105 個模組 × 4 = 420px，喺 480 度好舒服。 */
const VIDEO_SIZE = 480;
const VIDEO_FPS = 30;
/** 生成幾多幀。要夠多先收得齊（實測掉幀之下大約 1.5–2 × K）。 */
const VIDEO_FRAMES = 120;

/**
 * 搵一個行得嘅 Chromium：先睇環境有冇預先裝好嘅，冇就用 Playwright
 * 自己下載嗰個。兩樣都冇（例如淨係 `npm ci` 冇 `playwright install`）
 * 就跳過呢啲測試，而唔係成個 CI 爆。
 */
function findChromium(): string | undefined {
  const preinstalled = globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome')[0];
  if (preinstalled) return preinstalled;
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // Playwright 未下載過瀏覽器
  }
  return undefined;
}

// ── 靜態伺服器 ──────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
};

function serveDist(): Promise<{ server: Server; base: string }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let path = normalize(join(DIST, decodeURIComponent(url.pathname)));
      if (!path.startsWith(DIST)) {
        res.writeHead(403).end();
        return;
      }
      if (url.pathname === '/') path = join(DIST, 'index.html');
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      // 127.0.0.1 算 secure context，所以唔使 HTTPS 都用得鏡頭
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

// ── Y4M 影片生成 ────────────────────────────────────────

/** 將一個 QR 模組矩陣畫成一幀 YUV420p（黑白，所以 U/V 恆定 128）。 */
function qrToYuvFrame(size: number, modules: Uint8Array, side: number): Uint8Array {
  const quiet = 4;
  const padded = size + quiet * 2;
  const scale = Math.floor((side * 0.88) / padded);
  const drawn = padded * scale;
  const origin = Math.floor((side - drawn) / 2);

  const ySize = side * side;
  const cSize = (side >> 1) * (side >> 1);
  const out = new Uint8Array(ySize + cSize * 2);

  // 背景畫成中灰，模擬真實場景唔係純白 —— 順便逼二值化器做啲嘢
  out.fill(150, 0, ySize);
  out.fill(128, ySize);

  // 靜區（白）
  for (let y = 0; y < drawn; y++) {
    out.fill(255, (origin + y) * side + origin, (origin + y) * side + origin + drawn);
  }

  // 模組（黑）
  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (!modules[my * size + mx]) continue;
      const px0 = origin + (mx + quiet) * scale;
      const py0 = origin + (my + quiet) * scale;
      for (let py = py0; py < py0 + scale; py++) {
        out.fill(0, py * side + px0, py * side + px0 + scale);
      }
    }
  }
  return out;
}

async function buildQrVideo(path: string, payloadBytes: Uint8Array): Promise<{ sha256: string; fileName: string }> {
  const profile = PROFILES.safe;
  const fileName = 'fake-camera.bin';
  const file = new File([payloadBytes as unknown as BlobPart], fileName, {
    type: 'application/octet-stream',
  });
  const packed = await packFile(file, profile.blockSize);

  const sessionId = 0x7f7f;
  const encoder = new LtEncoder(packed.payload, packed.manifest.blockSize);
  const manifestFrame = encodeManifestFrame(sessionId, packed.manifest);
  const scratch = new Uint8Array(packed.manifest.blockSize);

  const header = Buffer.from(`YUV4MPEG2 W${VIDEO_SIZE} H${VIDEO_SIZE} F${VIDEO_FPS}:1 Ip A1:1 C420jpeg\n`);
  const chunks: Buffer[] = [header];

  for (let i = 0; i < VIDEO_FRAMES; i++) {
    const frameBytes =
      i % 12 === 0 ? manifestFrame : encodeDataFrame(sessionId, encoder.next(scratch), scratch);
    const { size, modules } = encodeQrMatrix(frameBytes, profile);
    chunks.push(Buffer.from('FRAME\n'));
    chunks.push(Buffer.from(qrToYuvFrame(size, modules, VIDEO_SIZE)));
  }

  await writeFile(path, Buffer.concat(chunks));

  const digest = await crypto.subtle.digest('SHA-256', payloadBytes.slice().buffer as ArrayBuffer);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { sha256, fileName };
}

// ── 測試 ────────────────────────────────────────────────

const chromiumPath = findChromium();
const workDir = join(tmpdir(), 'qrtrans-browser-test');

let server: Server;
let base: string;

beforeAll(async () => {
  if (!existsSync(join(DIST, 'index.html'))) {
    execFileSync('npx', ['vite', 'build'], { cwd: REPO, stdio: 'pipe' });
  }
  await mkdir(workDir, { recursive: true });
  ({ server, base } = await serveDist());
}, 180_000);

afterAll(async () => {
  server?.close();
  await rm(workDir, { recursive: true, force: true });
});

describe.skipIf(!chromiumPath)('真瀏覽器', () => {
  it('發送端：worker 起得到、QR 逐幀變、幀率達標、零外部請求', async () => {
    const browser: Browser = await chromium.launch({ executablePath: chromiumPath });
    try {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const requests: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('request', (r) => requests.push(r.url()));

      await page.goto(base, { waitUntil: 'networkidle' });

      await page.evaluate(() => {
        const bytes = new Uint8Array(40_000);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 7)) & 0xff;
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'browser-test.bin', { type: 'application/octet-stream' }));
        const input = document.querySelector<HTMLInputElement>('#file-input')!;
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      await page.selectOption('#profile-select', 'balanced');
      await page.selectOption('#fps-select', '30');
      await page.click('#send-start');
      await page.waitForSelector('#send-playing:not([hidden])', { timeout: 15_000 });
      // 等到 canvas 量好尺寸（唔再係 300px 預設值）
      await page.waitForFunction(
        () => (document.querySelector('#qr-canvas') as HTMLCanvasElement).width !== 300,
        { timeout: 15_000 },
      );

      const hashes: number[] = [];
      let canvasWidth = 0;
      for (let i = 0; i < 12; i++) {
        const snap = await page.evaluate(() => {
          const c = document.querySelector<HTMLCanvasElement>('#qr-canvas')!;
          const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let h = 2166136261;
          for (let j = 0; j < d.length; j += 97) {
            h ^= d[j]!;
            h = Math.imul(h, 16777619);
          }
          return { hash: h >>> 0, width: c.width };
        });
        hashes.push(snap.hash);
        canvasWidth = snap.width;
        await page.waitForTimeout(60);
      }

      await page.waitForTimeout(1200);
      const stats = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('#send-stats .stat')].map((el) => [
            el.querySelector('.stat-key')!.textContent,
            el.querySelector('.stat-val')!.textContent,
          ]),
        ),
      );

      // 畫面真係喺度閃：12 個取樣至少要有 8 個唔同嘅幀
      expect(new Set(hashes).size).toBeGreaterThanOrEqual(8);
      // canvas 邊長一定要係模組數嘅整數倍（v27 = 125 + 8 靜區 = 133）
      expect(canvasWidth % 133).toBe(0);
      expect(canvasWidth).toBeGreaterThan(300);
      // 門檻定得鬆過目標（30fps）：CI runner 冇 GPU 又要同其他 job 爭 CPU。
      // 呢度想捉嘅係「管線塞死咗」，唔係量度真實效能 —— 真實幀率要喺
      // 實機度睇。低過 15 就代表 worker 或者 rAF 迴圈出咗事
      expect(Number(stats['實際 FPS'])).toBeGreaterThan(15);
      expect(Number(stats['已播幀數'])).toBeGreaterThan(20);

      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);

      // 私隱：除咗自己個 origin，唔應該有任何請求出街
      const external = requests.filter(
        (u) => !u.startsWith(base) && !u.startsWith('blob:') && !u.startsWith('data:'),
      );
      expect(external).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 180_000);

  it('接收端：用假鏡頭餵一條 QR 影片，完整還原並驗到 SHA-256', async () => {
    const videoPath = join(workDir, 'qr.y4m');
    const rng = new Prng(0xcafe);
    const payload = new Uint8Array(9_000);
    for (let i = 0; i < payload.length; i++) payload[i] = rng.nextInt(256);
    const { sha256, fileName } = await buildQrVideo(videoPath, payload);

    const browser = await chromium.launch({
      executablePath: chromiumPath,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${videoPath}`,
      ],
    });
    try {
      const context = await browser.newContext({ permissions: ['camera'] });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));

      await page.goto(`${base}#receive`, { waitUntil: 'networkidle' });
      await page.click('#recv-start');
      await page.waitForSelector('#recv-scanning:not([hidden])', { timeout: 20_000 });

      // 影片係循環播嘅，所以收唔齊都會一路試落去
      await page.waitForSelector('#recv-done:not([hidden])', { timeout: 120_000 });

      const banner = (await page.textContent('#recv-banner'))!;
      const meta = (await page.textContent('#recv-meta'))!;
      const stats = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('#recv-stats .stat')].map((el) => [
            el.querySelector('.stat-key')!.textContent,
            el.querySelector('.stat-val')!.textContent,
          ]),
        ),
      );

      expect(pageErrors).toEqual([]);
      expect(banner).toContain('傳輸完成');
      expect(banner).not.toContain('對唔上');
      // 接收端顯示嘅 hash 要同我哋餵入去嘅原檔一模一樣
      expect(meta).toContain(sha256);
      expect(meta).toContain(fileName);
      // ROI 鎖定應該喺過程中生效過
      expect(stats['LOCK']).toBe('鎖定');
      expect(Number(stats['DECODE FPS'])).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  }, 240_000);
});
