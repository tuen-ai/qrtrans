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

/** 一畫面最多搵幾多個 QR（對應發送端最大嘅 3×3 grid）。 */
const MAX_SYMBOLS = 9;

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
  /** 解到嘅每個符號嘅原始 bytes（一畫面可以有多個 QR） */
  symbols: Uint8Array[];
  /** 所有符號嘅**聯集**範圍（像素），用嚟做 ROI 鎖定 */
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
        // 一畫面可以排住幾個獨立 QR。實測多符號解碼幾乎唔使額外時間
        // （2×2 同 1×1 一樣快），所以呢度直接開到 grid 上限
        maxNumberOfSymbols: MAX_SYMBOLS,
        binarizer: 'LocalAverage',
      },
    );

    const hits = results.filter((r) => r.isValid && r.bytes.length > 0);
    if (hits.length === 0) {
      post({ type: 'result', id: msg.id, symbols: [], box: null });
      return;
    }

    // 所有符號嘅聯集 —— ROI 要框住成個 grid，唔係其中一格
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const hit of hits) {
      const p = hit.position;
      for (const corner of [p.topLeft, p.topRight, p.bottomLeft, p.bottomRight]) {
        if (corner.x < minX) minX = corner.x;
        if (corner.x > maxX) maxX = corner.x;
        if (corner.y < minY) minY = corner.y;
        if (corner.y > maxY) maxY = corner.y;
      }
    }

    // hit.bytes 係**原始** bytes，冇經任何字集轉換 —— 我哋傳緊二進位，
    // 用 hit.text 會被當 UTF-8 解讀直接搞爛資料
    const symbols = hits.map((h) => h.bytes);
    post(
      {
        type: 'result',
        id: msg.id,
        symbols,
        box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      },
      symbols.map((s) => s.buffer),
    );
  } catch {
    // 解碼失敗係常態（相機影到一半、太矇、冇 QR），唔使嘈
    post({ type: 'result', id: msg.id, symbols: [], box: null });
  }
};
