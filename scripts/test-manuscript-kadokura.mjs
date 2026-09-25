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

// 2026-09-25 追加（kento指示）: ◎丸ウニブロック・等級見出し（極大粒/大粒）・品目名行に価格まで書かれた行・鮎は無視
{
  const { extractKadokuraManuscriptItems: ex } = await import('../src/lib/manuscriptKadokura.js');
  const assert2 = (await import('node:assert')).default;
  const raw = '◎八幡浜のウニ\n愛媛,八幡浜赤雲丹　\n50g前後　\n   ・＠8,400\n\n◎北ウニNo.①\n（養殖）\nカネキ木村250ｇ\n【浜中養殖バフン】\n   ・＠25,500\n\n◎塩水ウニNo.①\n福士塩水雲丹【利尻島白】100g　\n   ・＠6,200\n\n・仙鳳趾ムキ牡蠣\n北海道,仙鳳趾\n（極大粒）\n500g入 1P 4,900  1P〜\n(大粒)\n500g入 1P 4,400  1P〜\n\n・活稚鮎 琵琶湖\n6g/230\n8g/250\n\n兵庫淡路島\n・ちりめん山椒1k×1P ×3,000  1P〜\n・上乾ちりめん5kgBOX k5,900  500g〜 極小\n・釜揚げしらす1k×1P k3,600  500g〜\n';
  const { items, skippedLines } = ex(raw);
  assert2.deepEqual(skippedLines, []);
  assert2.deepEqual(items.map((i) => [i.item_name, i.origin, i.spec, i.unit_price, i.price_unit]), [
    ['八幡浜のウニ 愛媛,八幡浜赤雲丹 50g前後', '愛媛', '', 8400, '枚'],
    ['北ウニNo.① （養殖） カネキ木村250ｇ 【浜中養殖バフン】', '', '', 25500, '枚'],
    ['塩水ウニNo.① 福士塩水雲丹【利尻島白】100g', '', '', 6200, 'pc'],
    ['仙鳳趾ムキ牡蠣', '北海道', '極大粒 500g入', 4900, 'P'],
    ['仙鳳趾ムキ牡蠣', '北海道', '大粒 500g入', 4400, 'P'],
    ['ちりめん山椒', '兵庫', '1k×1P', 3000, 'P'],
    ['上乾ちりめん', '兵庫', '5kgBOX', 5900, 'kg'],
    ['釜揚げしらす', '兵庫', '1k×1P', 3600, 'kg'],
  ]);
  console.log('OK: ◎丸ウニ・等級見出し・1行に価格まで書かれた品目・鮎は無視');
}
