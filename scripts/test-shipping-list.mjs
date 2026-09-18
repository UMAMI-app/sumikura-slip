import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert';
import { parseShippingList } from '../src/lib/shippingList.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.join(__dirname, 'sample_shipping.txt'), 'utf-8');

const { rows, warnings } = parseShippingList(raw, '2026-09-17');
assert.equal(warnings.length, 0);
assert.equal(rows.length, 13); // 15件中、航空便2件分の送料行を除外して13件

const destinations = [...new Set(rows.map((r) => r.destination))];
assert.equal(destinations.length, 6);

const moko = rows.find((r) => r.destination === 'MOKO（ﾓｺ）様' && r.item_name === 'ビワマス');
assert.deepEqual(
  { category: moko.delivery_category, date: moko.delivery_date, note: moko.delivery_time_note, qty: moko.quantity },
  { category: 'ground', date: '2026-09-18', note: '午前中', qty: 3 }
);

const kinme = rows.find((r) => r.item_name === 'キンメ');
assert.equal(kinme.delivery_category, 'air');
assert.equal(kinme.quantity, 3);
assert.equal(kinme.quantity_unit, '枚');
assert.ok(kinme.request_note.includes('k3,500以内'));

const perteTakkyu = rows.find((r) => r.destination === 'PERTE(ペルテ)様' && r.delivery_category === 'takkyu');
assert.deepEqual(
  { ship: perteTakkyu.takkyu_ship_date, arrival: perteTakkyu.takkyu_arrival_date },
  { ship: '2026-09-17', arrival: '2026-09-18' }
);

const ebi = rows.find((r) => r.item_name.includes('足赤エビ'));
assert.equal(ebi.origin, '兵庫・淡路');
assert.equal(ebi.item_name, '足赤エビ 80g前後');

const kegani = rows.find((r) => r.item_name.includes('毛蟹'));
assert.equal(kegani.quantity, 10);
assert.equal(kegani.quantity_unit, '杯');

const shirokintai = rows.find((r) => r.item_name.includes('白甘鯛'));
assert.equal(shirokintai.quantity, 5);
assert.equal(shirokintai.quantity_unit, '本');

const sengyoSet = rows.find((r) => r.item_name === '鮮魚セット');
assert.equal(sengyoSet.quantity, 18000);
assert.equal(sengyoSet.quantity_unit, '円分');
assert.ok(sengyoSet.request_note.includes('真鯛以外'));

// 航空便・自社配送の送料行は読み込まない仕様のため、7ブロック中2件（航空便）を除いた5件になる
const souryouCount = rows.filter((r) => r.item_name.startsWith('送料')).length;
assert.equal(souryouCount, 5);

console.log('OK: shipping list parser matches the real sample (13 rows, 6 destinations)');
