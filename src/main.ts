import './style.css';
import { SenderView } from './ui/sender';
import { ReceiverView } from './ui/receiver';
import { setupInstall, registerServiceWorker } from './ui/install';

/**
 * 入口：發送 / 接收兩個 tab 嘅切換。
 *
 * 兩邊共用同一份 protocol/ 同 codec/ —— 所以「雙向」唔使寫兩套邏輯，
 * 每部機都可以做發送端或者接收端。
 */

type Mode = 'send' | 'receive';

const sendView = document.querySelector<HTMLElement>('#view-send');
const receiveView = document.querySelector<HTMLElement>('#view-receive');
if (!sendView || !receiveView) throw new Error('搵唔到主要 view 元素');

const sender = new SenderView(sendView);
const receiver = new ReceiverView(receiveView);

function setMode(mode: Mode): void {
  // 離開一個模式一定要收皮：唔可以留住相機開住、或者 QR 繼續閃
  if (mode === 'send') receiver.stop();
  else sender.stop();

  sendView!.hidden = mode !== 'send';
  receiveView!.hidden = mode !== 'receive';

  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
  }
  if (location.hash !== `#${mode}`) location.hash = mode;
}

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  tab.addEventListener('click', () => setMode(tab.dataset.mode as Mode));
}

window.addEventListener('hashchange', () => {
  const mode = location.hash.slice(1);
  if (mode === 'send' || mode === 'receive') setMode(mode);
});

// 分享 URL 嗰陣可以直接指定模式：`…/#receive`
const initial = location.hash.slice(1);
setMode(initial === 'receive' ? 'receive' : 'send');

// 頁面收起或者關閉都要即刻放開相機 —— 唔好留住個綠燈著住
window.addEventListener('pagehide', () => {
  sender.stop();
  receiver.stop();
});

// 裝落主畫面 + 離線能力
setupInstall();
registerServiceWorker();
