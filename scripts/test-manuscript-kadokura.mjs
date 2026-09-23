import { extractKadokuraManuscriptItems } from '../src/lib/manuscriptKadokura.js';
import assert from 'node:assert';

const raw = [
  '・メックリアジ兵庫(二見)',
  '1.5kg k1,200',
  '',
  '・白甘鯛',
  '和歌山',
  '1.5kg k12,000',
  '2kg k13,000',
  '',
  '・イサキ',
  '1尾1,250',
  '',
  '宮津とり貝',
  '◎SP-大',
  '・玉/代金3500',
].join('\n');

const { items, skippedLines } = extractKadokuraManuscriptItems(raw);
console.log(JSON.stringify(items, null, 2));
console.log('skipped:', skippedLines);

assert.equal(items.length, 4); // メックリアジ, 白甘鯛x2, イサキ
assert.deepEqual(
  { name: items[0].item_name, origin: items[0].origin, spec: items[0].spec, price: items[0].unit_price, unit: items[0].price_unit },
  { name: 'メックリアジ', origin: '兵庫', spec: '1.5kg', price: 1200, unit: 'kg' }
);
assert.deepEqual(
  { name: items[1].item_name, origin: items[1].origin, spec: items[1].spec, price: items[1].unit_price, unit: items[1].price_unit },
  { name: '白甘鯛', origin: '和歌山', spec: '1.5kg', price: 12000, unit: 'kg' }
);
assert.equal(items[2].unit_price, 13000);
assert.deepEqual(
  { name: items[3].item_name, price: items[3].unit_price, unit: items[3].price_unit },
  { name: 'イサキ', price: 1250, unit: '尾' }
);
assert.ok(skippedLines.some((s) => s.includes('宮津')));
console.log('OK: kadokura extraction basic cases pass');

// 2026-09-23 追加（kento指示）: 由良ウニの船名（廣田丸・与助・与助丸・山由丸）を品目名に残す
{
  const { extractKadokuraManuscriptItems: ex } = await import('../src/lib/manuscriptKadokura.js');
  const raw = '・由良ウニ兵庫(廣田丸)\nSP)70g-80g 1枚 15,800\n特上)70g-80g 1枚 14,800\n\n・由良ウニ兵庫(与助)\nSP)70g-80g 1枚 15,000\n\n・由良ウニ兵庫(与助丸)\nSP)70g-80g 1枚 15,000\n\n・由良ウニ\n兵庫(山由丸)\nSP)70g 1枚 13,000\n';
  const { items } = ex(raw);
  const assert2 = (await import('node:assert')).default;
  assert2.deepEqual(items.map((i) => [i.item_name, i.origin, i.unit_price, i.price_unit]), [
    ['由良ウニ(廣田丸)', '兵庫', 15800, '枚'],
    ['由良ウニ(廣田丸)', '兵庫', 14800, '枚'],
    ['由良ウニ(与助)', '兵庫', 15000, '枚'],
    ['由良ウニ(与助丸)', '兵庫', 15000, '枚'],
    ['由良ウニ(山由丸)', '兵庫', 13000, '枚'],
  ]);
  console.log('OK: 由良ウニの船名（廣田丸・与助・与助丸・山由丸）を品目名に残す');
}
