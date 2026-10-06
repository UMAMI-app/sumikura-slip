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
    ['（養殖） カネキ木村250ｇ 【浜中養殖バフン】', '', '', 25500, '枚'],
    ['福士塩水雲丹【利尻島白】100g', '', '', 6200, 'pc'],
    ['仙鳳趾ムキ牡蠣', '北海道', '極大粒 500g入', 4900, 'P'],
    ['仙鳳趾ムキ牡蠣', '北海道', '大粒 500g入', 4400, 'P'],
    ['ちりめん山椒', '兵庫', '1k×1P', 3000, 'P'],
    ['上乾ちりめん', '兵庫', '5kgBOX', 5900, 'kg'],
    ['釜揚げしらす', '兵庫', '1k×1P', 3600, 'kg'],
  ]);
  console.log('OK: ◎丸ウニ・等級見出し・1行に価格まで書かれた品目・鮎は無視');
}

// 2026-09-25 追加（kento指示）: 空行の後の「・」なし1行（由良廣田丸）がハモの規格に混ざらない
{
  const { extractKadokuraManuscriptItems: ex } = await import('../src/lib/manuscriptKadokura.js');
  const assert2 = (await import('node:assert')).default;
  const raw = '・ハモ兵庫(淡路)\n800g前後 k6,000  1尾〜\n600g前後 k5,500  1尾〜\n400g前後 k5,000  1尾〜\n↑朝締めます！\n\n由良廣田丸 SP 約70g 1枚15,800\n由良廣田丸 並 約60g 1枚13,000\n';
  const { items, skippedLines } = ex(raw);
  assert2.deepEqual(skippedLines, []);
  assert2.deepEqual(items.map((i) => [i.item_name, i.origin, i.spec, i.unit_price, i.price_unit]), [
    ['ハモ', '兵庫', '800g前後', 6000, 'kg'],
    ['ハモ', '兵庫', '600g前後', 5500, 'kg'],
    ['ハモ', '兵庫', '400g前後', 5000, 'kg'],
    ['由良廣田丸 SP 約70g', '', '', 15800, '枚'],
    ['由良廣田丸 並 約60g', '', '', 13000, '枚'],
  ]);
  console.log('OK: 空行の後の品目名＋価格の1行は新しい品目（由良廣田丸がハモに混ざらない）');
}

// 2026-10-01 追加（kento指示）: 品目の頭が「•」でも区切りとして認識する／「11,000cs」はcs単価
{
  const { extractKadokuraManuscriptItems: ex } = await import('../src/lib/manuscriptKadokura.js');
  const assert2 = (await import('node:assert')).default;
  const raw = '・オオズワイ北海道噴火湾\n5入3k前後 11,000cs  1cs〜\n5入3k前後 1杯2,300  1杯〜\n\n•マサバ和歌山紀州御坊\n800g前後 k4,800  活〆  1尾〜\n•マサバ兵庫垂水\n500g-600g k3,000  1尾〜\n\n•マアジ千葉(黄金アジ)\n400g-500g k3,000  1尾～\n';
  const { items, skippedLines } = ex(raw);
  assert2.deepEqual(skippedLines, []);
  assert2.deepEqual(items.map((i) => [i.item_name, i.origin, i.spec, i.unit_price, i.price_unit]), [
    ['オオズワイ', '北海道', '5入3k前後', 11000, 'cs'],
    ['オオズワイ', '北海道', '5入3k前後', 2300, '杯'],
    ['マサバ', '和歌山', '800g前後', 4800, 'kg'],
    ['マサバ', '兵庫', '500g-600g', 3000, 'kg'],
    ['マアジ', '千葉', '400g-500g', 3000, 'kg'],
  ]);
  console.log('OK: 「•」も品目の区切り／cs単価');
}

// 2026-10-06 追加（kento指示）: 「◎北ウニNo.①」「◎塩水ウニNo.12」等の番号付き見出しは品目名から外す
{
  const { extractKadokuraManuscriptItems: ex } = await import('../src/lib/manuscriptKadokura.js');
  const assert2 = (await import('node:assert')).default;
  const raw = '◎北ウニNo.①\n昆布森100g雲丹\n【黄上】　\n・＠13,800\n◎塩水ウニNo.①\n昆布森塩水雲丹\n【青】100g 　\n・＠12,800\n◎北ウニNo.12\n小川SP250g\n・＠19,500\n◎北ウニ No.３\n小川SP250g\n・＠19,500\n';
  const { items } = ex(raw);
  assert2.deepEqual(items.map((i) => [i.item_name, i.unit_price, i.price_unit]), [
    ['昆布森100g雲丹 【黄上】', 13800, '枚'],
    ['昆布森塩水雲丹 【青】100g', 12800, 'pc'],
    ['小川SP250g', 19500, '枚'],
    ['小川SP250g', 19500, '枚'],
  ]);
  console.log('OK: ◎ウニの番号付き見出しを品目名から外す');
}
