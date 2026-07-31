import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, globSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PWA build 產物檢查。
 *
 * 呢啲全部都係「靜靜雞壞咗好難察覺」嘅嘢：manifest 少一個欄位、
 * service worker 嘅 placeholder 冇被取代、sw.js 俾人加咗 hash……
 * app 表面上照行，但就係裝唔到、又或者離線開唔到。
 */

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIST = join(REPO, 'dist');

function readDist(file: string): string {
  return readFileSync(join(DIST, file), 'utf8');
}

/** 由 build 好嘅 sw.js 度抽返個 precache 清單出嚟。 */
function precacheList(): string[] {
  const code = readDist('sw.js');
  const match = code.match(/JSON\.parse\((".*?[^\\]")\)/s);
  expect(match, 'sw.js 入面搵唔到 JSON.parse 嘅 precache 清單').not.toBeNull();
  return JSON.parse(JSON.parse(match![1]!)) as string[];
}

describe('PWA manifest', () => {
  it('欄位齊全而且值合理', () => {
    const manifest = JSON.parse(readDist('manifest.webmanifest'));

    expect(manifest.name).toBeTruthy();
    // 主畫面圖示下面顯示嘅名，太長會被截
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    // standalone 先至冇瀏覽器網址列，睇落似個 app
    expect(manifest.display).toBe('standalone');
    // GitHub Pages 個 app 喺 /<repo>/ 之下，寫死絕對路徑就會壞
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('有 Android 要求嘅 192 同 512 PNG，同埋一個 maskable', () => {
    const manifest = JSON.parse(readDist('manifest.webmanifest'));
    const icons = manifest.icons as Array<{ src: string; sizes: string; type: string; purpose: string }>;

    const png = icons.filter((i) => i.type === 'image/png');
    expect(png.map((i) => i.sizes)).toContain('192x192');
    expect(png.map((i) => i.sizes)).toContain('512x512');
    // maskable 先至唔會喺圓形／方角遮罩下面俾人切爛
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);

    // 每個圖示檔案都要真係存在，而且係相對路徑
    for (const icon of icons) {
      expect(icon.src.startsWith('./'), `${icon.src} 應該用相對路徑`).toBe(true);
      expect(existsSync(join(DIST, icon.src.slice(2))), `${icon.src} 唔存在`).toBe(true);
    }
  });
});

describe('Service worker', () => {
  it('檔名穩定，冇被加 hash', () => {
    // 瀏覽器係靠同一條 URL 認返「同一個 SW」先知有冇更新；
    // 檔名一帶 hash，每次 build 都變成一個全新嘅 SW
    expect(existsSync(join(DIST, 'sw.js'))).toBe(true);
  });

  it('placeholder 已經填好，唔會 install 時炸', () => {
    const code = readDist('sw.js');
    expect(code).not.toContain('__PRECACHE_MANIFEST__');
    expect(code).not.toContain('__CACHE_VERSION__');
    expect(code).toMatch(/qrtrans-[0-9a-f]{12}/);
  });

  it('係 classic script（冇 import / export），否則舊瀏覽器註冊唔到', () => {
    const code = readDist('sw.js');
    expect(code).not.toMatch(/\bimport\s*[({'"]/);
    expect(code).not.toMatch(/\bexport\s*[{*]/);
  });

  it('precache 涵蓋離線行 app 所需嘅一切', () => {
    const precache = precacheList();

    // app shell —— 冇咗離線就開唔到頁面
    expect(precache).toContain('index.html');
    // manifest 同圖示 —— 冇咗離線裝唔到
    expect(precache).toContain('manifest.webmanifest');
    expect(precache).toContain('icon-192.png');
    expect(precache).toContain('icon-512.png');

    // 兩個 worker 同 wasm 都係**用嗰陣先 load** 嘅（按「開始播放」／
    // 「開啟鏡頭」先至攞），所以最易被漏 —— 但佢哋先係核心功能
    expect(precache.some((f) => /encode\.worker.*\.js$/.test(f)), '冇 encode worker').toBe(true);
    expect(precache.some((f) => /decode\.worker.*\.js$/.test(f)), '冇 decode worker').toBe(true);
    expect(precache.some((f) => f.endsWith('.wasm')), '冇 zxing wasm').toBe(true);
    expect(precache.some((f) => f.endsWith('.css')), '冇 CSS').toBe(true);

    // 每個都要真係喺 dist 度存在，否則 install 時靜靜雞跳過
    for (const file of precache) {
      expect(existsSync(join(DIST, file)), `precache 列咗 ${file} 但佢唔存在`).toBe(true);
    }
  });

});

describe('產物真係會註冊 service worker', () => {
  it('主 bundle 入面搵得返註冊呼叫', () => {
    // 呢個測試存在嘅原因：`registerServiceWorker()` 入面有一句
    // `if (import.meta.env.DEV) return;`。如果 build 唔係喺 production
    // 環境行（例如 vitest 將 NODE_ENV 設咗做 'test'），Vite 會將 DEV
    // 當成 true，成段註冊碼就會喺產物度被消除 —— app 睇落一切正常，
    // 但永遠裝唔到、離線用唔到，而且冇任何錯誤訊息。
    const bundles = globSync(join(DIST, 'assets/index-*.js'));
    expect(bundles.length).toBeGreaterThan(0);
    const code = bundles.map((f) => readFileSync(f, 'utf8')).join('\n');

    expect(code, 'bundle 入面搵唔到 navigator.serviceWorker').toContain('serviceWorker');
    expect(code, "bundle 入面搵唔到 './sw.js' —— 註冊碼被 tree-shake 咗").toContain('./sw.js');
  });
});

describe('HTML 入面嘅 PWA 掛鈎', () => {
  it('接咗 manifest 同 iOS 專用嘅 meta', () => {
    const html = readDist('index.html');
    expect(html).toMatch(/<link[^>]+rel="manifest"[^>]+href="\.\/manifest\.webmanifest"/);
    // iOS 唔識 manifest 嘅 display / icons，全部靠呢幾個
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(html).toMatch(/<link[^>]+rel="apple-touch-icon"/);
    expect(html).toContain('apple-mobile-web-app-title');
  });

  it('CSP 冇擋住 service worker', () => {
    const html = readDist('index.html');
    const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)![1]!;
    // worker-src 要包 'self'，否則 SW 註冊唔到（而且係靜靜雞失敗）
    expect(csp.replace(/\s+/g, ' ')).toMatch(/worker-src 'self'/);
  });
});
