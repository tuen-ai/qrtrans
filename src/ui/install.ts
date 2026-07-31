/**
 * 「裝落主畫面」嘅提示 + service worker 註冊。
 *
 * 三種情況要分開處理：
 *  - **Chrome / Edge / Android**：會派 `beforeinstallprompt`，可以出個掣直接裝
 *  - **iOS Safari**：冇任何 API，用戶要自己「分享 → 加入主畫面」，所以只可以出指引
 *  - **已經裝咗**（standalone 模式開緊）：咩都唔使出
 *
 * 用戶收起咗就記住（localStorage），唔好次次都煩佢。
 */

const DISMISS_KEY = 'qrtrans.install-dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** 而家係咪已經以 app 形式行緊？ */
function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari 用自己一套
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ 報做 Mac，要靠觸控點數分辨
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false; // 私隱模式下 localStorage 會掟錯，當冇收起過
  }
}

function remember(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // 記唔到就算，最多下次再問一次
  }
}

export function setupInstall(): void {
  const bar = document.querySelector<HTMLElement>('#install-bar');
  const text = document.querySelector<HTMLElement>('#install-text');
  const button = document.querySelector<HTMLButtonElement>('#install-btn');
  const dismiss = document.querySelector<HTMLButtonElement>('#install-dismiss');
  if (!bar || !text || !button || !dismiss) return;

  dismiss.addEventListener('click', () => {
    bar.hidden = true;
    remember();
  });

  if (isStandalone() || wasDismissed()) return;

  if (isIos()) {
    // Safari 冇安裝 API，唯一可以做嘅就係話畀用戶知點撳
    text.textContent = '想離線用？撳下面嘅「分享」→「加入主畫面」。';
    bar.hidden = false;
    return;
  }

  let deferred: BeforeInstallPromptEvent | null = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    // 阻止瀏覽器自己彈，改為由我哋控制時機
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    button.hidden = false;
    bar.hidden = false;
  });

  button.addEventListener('click', async () => {
    if (!deferred) return;
    button.disabled = true;
    try {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === 'accepted') bar.hidden = true;
    } finally {
      // 一個 beforeinstallprompt 事件只可以用一次
      deferred = null;
      button.disabled = false;
      button.hidden = true;
    }
  });

  window.addEventListener('appinstalled', () => {
    bar.hidden = true;
    remember();
  });
}

/**
 * 註冊 service worker。
 *
 * 只喺 production build 做 —— dev 模式下 SW 會攔截住 Vite 嘅 HMR 請求，
 * 改咗嘢唔會即時反映，好易搞到人以為改動冇生效。
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    // 相對路徑：GitHub Pages 個 app 喺 /<repo>/ 之下，scope 要跟住
    void navigator.serviceWorker.register('./sw.js').catch((err: unknown) => {
      // 註冊唔到唔係致命 —— 得唔到離線能力，但 app 照用。
      // 但一定要出聲：靜靜雞吞咗嘅話，「點解離線用唔到」就變成
      // 一個完全冇線索嘅問題
      console.warn('[qrtrans] service worker 註冊失敗，離線功能用唔到：', err);
    });
  });
}
