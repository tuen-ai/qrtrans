import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
// Vite 會將呢個 wasm 抄入 build 產物，並且畀返一條**同源**嘅 URL。
// 好緊要：zxing-wasm 預設會去 jsDelivr CDN 攞 wasm，喺呢個專案入面
// 絕對唔可以有外部請求（CSP 都會擋住）。
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

/**
 * 解碼 worker：一張圖入 → QR 內容 bytes 出。
 *
 * 開一個 pool（見 receiver.ts）：解一張 1080p 圖係幾毫秒到十幾毫秒，
 * 單一 worker 追唔到 60fps 嘅相機。主線程完全唔掂 QR 解碼。
 */

prepareZXingModule({
  overrides: { locateFile: () => wasmUrl },
});

export interface DecodeRequest {
  type: 'decode';
  /** 對應返請求，用嚟丟棄過期結果 */
  id: number;
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface DecodeResponse {
  type: 'result';
  id: number;
  /** 解到嘅原始 bytes；解唔到就 null */
  bytes: Uint8Array | null;
  /** QR 喺送入嚟嗰張圖入面嘅範圍（像素），用嚟做 ROI 鎖定 */
  box: { x: number; y: number; w: number; h: number } | null;
}

function post(msg: DecodeResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const msg = event.data;
  if (msg.type !== 'decode') return;

  try {
    const results = await readBarcodes(
      // zxing-wasm 係用 width/height/data 去認 ImageData 嘅，
      // 所以呢個普通物件就夠，唔使真係起一個 ImageData
      { data: msg.data, width: msg.width, height: msg.height } as unknown as ImageData,
      {
        formats: ['QRCode'],
        // 以下全部都係為咗**速度**：追唔到相機幀率就等於資料流失
        tryHarder: false,
        tryRotate: false,
        tryInvert: false,
        tryDownscale: false,
        maxNumberOfSymbols: 1,
        binarizer: 'LocalAverage',
      },
    );

    const hit = results.find((r) => r.isValid);
    if (!hit) {
      post({ type: 'result', id: msg.id, bytes: null, box: null });
      return;
    }

    const p = hit.position;
    const xs = [p.topLeft.x, p.topRight.x, p.bottomLeft.x, p.bottomRight.x];
    const ys = [p.topLeft.y, p.topRight.y, p.bottomLeft.y, p.bottomRight.y];
    const x = Math.min(...xs);
    const y = Math.min(...ys);

    // hit.bytes 係**原始** bytes，冇經任何字集轉換 —— 我哋傳緊二進位，
    // 用 hit.text 會被當 UTF-8 解讀直接搞爛資料
    const bytes = hit.bytes;
    post({ type: 'result', id: msg.id, bytes, box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } }, [
      bytes.buffer,
    ]);
  } catch {
    // 解碼失敗係常態（相機影到一半、太矇、冇 QR），唔使嘈
    post({ type: 'result', id: msg.id, bytes: null, box: null });
  }
};
