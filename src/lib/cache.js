// 画面を切り替えたときに「前回取得したデータをすぐ表示 → 裏で最新を取り直して差し替える」ための
// 簡単なメモリキャッシュ（2026-10-31 高速化）。ページを再読み込みすれば消える。
// 最新データは必ず取り直すので、古い情報が残り続けることはない。
const store = new Map();
export const cachePeek = (key) => store.get(key);
export const cacheSet = (key, value) => { store.set(key, value); return value; };
