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

// 2026-09-23 追加（kento指示）: 発注者名・発注元（角倉商店）・ステータス（未確定）が
// 品目として誤登録される不具合の回帰テスト。「👤」直後の行は内容によらず発注者として
// 読み飛ばす（位置ベース）＋既知の発注元・ステータス値も読み飛ばす（内容ベース）の二重チェック。
{
  const raw = `👤\n \n浦島一樹\n未確定\n角倉商店\n→\nよこい\n🚚 発送\n9/22\n📦 納品\n9/22午前中\n配達🚛\n真鯛\n1.2 ㎏\n仕入 ¥6,000\n送料\n1\n`;
  const { destinations, warnings } = parseLineShipmentText(raw, '2026-09-22');
  assert.equal(warnings.length, 0);
  assert.equal(destinations.length, 1);
  assert.equal(destinations[0].destinationName, 'よこい');
  assert.deepEqual(destinations[0].items.map((it) => it.item_name), ['真鯛', '送料']);
  console.log('OK: orderer/supplier/status header lines are never captured as items');
}

// 2026-09-23 追加（kento指示）: 数量の記載が無い場合は「1」＋品目ごとの数え方（ウニ→枚、
// それ以外は「本」）をデフォルトで補うようにした機能の回帰テスト。
{
  const raw = `👤\n \n浦島一樹\n未確定\n角倉商店\n→\nよこい\n🚚 発送\n9/23\n📦 納品\n9/23午前中\n配達🚛\n由良ウニ\n仕入 ¥8,000\nカツオ\n3.3 ㎏\n仕入 ¥1,600\n極上　選り抜きハモ\n2.2 ㎏\n仕入 ¥4,500\n500g × 4本\n送料\n1\n`;
  const { destinations, warnings } = parseLineShipmentText(raw, '2026-09-23');
  assert.equal(warnings.length, 0);
  const rows = buildLineActualRows(destinations, '2026-09-23', {});
  const uni = rows.find((r) => r.item_name === '由良ウニ');
  assert.deepEqual({ qty: uni.quantity, unit: uni.quantity_unit }, { qty: 1, unit: '枚' }); // 数量記載なし＋「ウニ」既知パターン
  const katsuo = rows.find((r) => r.item_name === 'カツオ');
  assert.deepEqual({ qty: katsuo.quantity, unit: katsuo.quantity_unit }, { qty: 1, unit: '本' }); // 数量記載なし→デフォルト1本
  const hamo = rows.find((r) => r.item_name === '極上 選り抜きハモ');
  assert.deepEqual({ qty: hamo.quantity, unit: hamo.quantity_unit }, { qty: 4, unit: '本' }); // 記載済みの数量は上書きしない
  console.log('OK: missing quantity defaults to 1 + item-specific counting unit (uni=枚, default=本)');
}
