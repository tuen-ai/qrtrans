import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 私隱防線嘅自動化守衛。
 *
 * 呢個專案有一條唔可以妥協嘅要求：**用戶揀嘅檔案永遠唔會離開部機**。
 * 光靠人手 review 唔夠 —— 一個唔小心加入嘅 `fetch()`、一個第三方 CDN
 * 連結、一句 analytics，都會靜靜雞打爆呢條防線。所以喺 CI 度守住。
 *
 * （真瀏覽器嗰邊仲有一層：browser.test.ts 會全程監聽網絡請求，
 * 斷言除咗自己個 origin 之外一個請求都冇。）
 */

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(REPO, 'src');

function sourceFiles(): string[] {
  return globSync(join(SRC, '**/*.ts'));
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('私隱防線', () => {
  it('原始碼入面冇任何外送資料嘅 API', () => {
    // service worker 係唯一例外：佢嘅本職就係代理頁面自己嘅請求，
    // 冇 fetch 就做唔到嘢。下面有一個專門測試守住佢只准同源。
    const SW = join(SRC, 'sw.ts');

    // 逐個檢查所有可以將 bytes 送出去嘅途徑
    const forbidden: Array<[RegExp, string]> = [
      [/\bfetch\s*\(/, 'fetch()'],
      [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
      [/\bnew\s+WebSocket\b/, 'WebSocket'],
      [/\bsendBeacon\s*\(/, 'navigator.sendBeacon()'],
      [/\bnew\s+EventSource\b/, 'EventSource'],
      [/\bnew\s+RTCPeerConnection\b/, 'RTCPeerConnection'],
      [/\bnavigator\.geolocation\b/, 'geolocation'],
      [/\bform\.submit\s*\(/, 'form submit'],
    ];

    const offences: string[] = [];
    for (const file of sourceFiles()) {
      const text = read(file);
      for (const [pattern, label] of forbidden) {
        // sw.ts 淨係豁免 fetch()，其餘途徑照樣唔准
        if (file === SW && label === 'fetch()') continue;
        if (pattern.test(text)) offences.push(`${relative(REPO, file)}：${label}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('service worker 只准同源，唔可以做外送通道', () => {
    const sw = read(join(SRC, 'sw.ts'));

    // 兩道閘：非 GET 唔理、跨域唔理。任何一道冇咗，SW 就可以變成
    // 一條繞過 CSP 嘅出口（SW 入面嘅請求唔受頁面 CSP 管）
    expect(sw).toMatch(/request\.method\s*!==\s*'GET'\s*\)\s*return/);
    expect(sw).toMatch(/url\.origin\s*!==\s*sw\.location\.origin\s*\)\s*return/);

    // 每一個 fetch 嘅目標都必須源自被攔截嘅 request 本身，
    // 唔可以係任何寫死或者拼出嚟嘅 URL
    const fetchCalls = sw.match(/\bfetch\s*\([^)]*\)/g) ?? [];
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const call of fetchCalls) {
      expect(call, `可疑嘅 fetch 目標：${call}`).toMatch(/^fetch\(request\)$/);
    }

    // 唔准真係叫 skipWaiting()：頁面行到一半換版本兼清走舊 cache，
    // 就會令仲未 load 嘅 worker ／ wasm（帶 hash 嘅檔名）404。
    // 註釋度提到個名唔算，所以要 match 呼叫而唔係字串
    expect(sw).not.toMatch(/\bskipWaiting\s*\(/);
  });

  it('冇引用任何外部網域（CDN、字型、分析）', () => {
    const offences: string[] = [];
    const external = /https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+/gi;

    for (const file of [...sourceFiles(), join(REPO, 'index.html'), join(SRC, 'style.css')]) {
      const text = read(file);
      for (const line of text.split('\n')) {
        // 註解入面提到網址（例如解釋點解唔用 CDN）唔算
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) continue;
        const hits = line.match(external);
        if (hits) offences.push(`${relative(REPO, file)}：${hits.join(', ')}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('zxing 嘅 wasm 係自我托管，唔係行 CDN', () => {
    const worker = read(join(SRC, 'workers/decode.worker.ts'));
    // 必須用 Vite 嘅 ?url 匯入（會抄一份入 build 產物並畀同源 URL），
    // 而且要明確覆寫 locateFile —— 否則 zxing-wasm 預設會去 jsDelivr
    expect(worker).toContain("zxing_reader.wasm?url");
    expect(worker).toMatch(/locateFile:\s*\(\)\s*=>\s*wasmUrl/);
  });

  it('index.html 嘅 CSP 鎖死晒所有外送途徑', () => {
    const html = read(join(REPO, 'index.html'));
    const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
    expect(match, '搵唔到 CSP meta tag').not.toBeNull();

    const csp = match![1]!.replace(/\s+/g, ' ');
    // connect-src 'self' 就係擋住 fetch / XHR / WebSocket / sendBeacon 嘅嗰道閘
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    // img-src / media-src 唔可以放行任意網域，否則 CSS 同 <img> 都變外送通道
    expect(csp).toMatch(/img-src 'self' blob: data:/);
    expect(csp).toMatch(/media-src 'self' blob:/);
    expect(csp).not.toContain('*');
  });

  it('build 產物入面冇殘留外部網域', () => {
    const dist = join(REPO, 'dist');
    const files = globSync(join(dist, '**/*.{js,html,css}'));
    // globalSetup 已經 build 咗，所以冇檔案就係真係出咗事，唔可以靜靜跳過
    expect(files.length).toBeGreaterThan(0);

    const offences: string[] = [];
    for (const file of files) {
      const text = read(file);
      for (const host of ['jsdelivr', 'unpkg', 'cdn.', 'googleapis', 'google-analytics', 'sentry']) {
        if (text.includes(host)) offences.push(`${relative(REPO, file)}：${host}`);
      }
    }
    expect(offences).toEqual([]);
  });
});
