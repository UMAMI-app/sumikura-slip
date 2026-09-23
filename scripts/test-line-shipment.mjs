import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert';
import { parseLineShipmentText, buildLineActualRows } from '../src/lib/lineShipment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.join(__dirname, 'sample_line_shipment.txt'), 'utf-8');

// 2026-09-23 追加（kento指示）: 実際にLINE実績データを貼り付けた際、店名・発注者・要望
// （⚠️水洗い等）が誤って品目として取り込まれてしまう不具合の再現・回帰テスト。
const { destinations, warnings } = parseLineShipmentText(raw, '2026-09-20');
assert.equal(warnings.length, 0);
assert.equal(destinations.length, 2);

const miyamoto = destinations[0];
assert.equal(miyamoto.destinationName, 'お料理宮本');
// 韓国ハモ・氷じめアジ・筋子・淡路コチ・カマス・サンマ・送料 の7件のみ（要望行が誤って
// 品目化していた「800g × 1本 ⚠️水洗い」「水洗い」「2腹」「⚠️水洗い」の4件は含まれない）。
assert.equal(miyamoto.items.length, 7);
assert.deepEqual(
  miyamoto.items.map((it) => it.item_name),
  ['韓国ハモ', '氷じめアジ', '筋子', '淡路コチ', 'カマス', 'サンマ', '送料']
);

const kankokuHamo = miyamoto.items.find((it) => it.item_name === '韓国ハモ');
assert.deepEqual(
  { spec: kankokuHamo.spec, qty: kankokuHamo.quantity, unit: kankokuHamo.quantity_unit, weight: kankokuHamo.actual_weight, price: kankokuHamo.purchase_price, note: kankokuHamo.note },
  { spec: '800g', qty: 1, unit: '本', weight: 0.85, price: 11000, note: '水洗い' }
);

const koori = miyamoto.items.find((it) => it.item_name === '氷じめアジ');
assert.equal(koori.note, '水洗い'); // ⚠️マーク無しの単独メモ行（NOTE_KEYWORDSでの検出）

const sujiko = miyamoto.items.find((it) => it.item_name === '筋子');
assert.deepEqual({ qty: sujiko.quantity, unit: sujiko.quantity_unit }, { qty: 2, unit: '腹' }); // 「腹」単位

const awajiKochi = miyamoto.items.find((it) => it.item_name === '淡路コチ');
assert.equal(awajiKochi.note, '水洗い'); // ⚠️水洗い（マーク＋キーワード）

const kamasu = miyamoto.items.find((it) => it.item_name === 'カマス');
assert.deepEqual({ spec: kamasu.spec, qty: kamasu.quantity, unit: kamasu.quantity_unit }, { spec: '200g', qty: 3, unit: '本' });

const yokoi = destinations[1];
assert.equal(yokoi.destinationName, 'よこい');
assert.deepEqual(yokoi.items.map((it) => it.item_name), ['極上 選り抜きハモ', 'カツオ', '送料']);

const rows = buildLineActualRows(destinations, '2026-09-20', {});
// 送料は納品書に載せないため除外される（既存仕様）。
assert.equal(rows.length, 8);

console.log('OK: line shipment parser correctly skips store/orderer/request-note lines (real sample)');
