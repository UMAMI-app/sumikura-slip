// matching.js（LINE実績データ ↔ 原稿の紐付け候補）の回帰テスト。
import assert from 'node:assert';
import { rankManuscriptCandidates, pickCertainCandidate, searchManuscriptItems, parseGramsRange } from '../src/lib/matching.js';

const ms = [
  { id: 'tai-sp', item_name: '活天然タイ', origin: '兵庫', spec: 'SP' },
  { id: 'tai-jo', item_name: '活天然タイ', origin: '兵庫', spec: '上' },
  { id: 'amadai', item_name: '白甘鯛', origin: '和歌山', spec: '' },
  { id: 'uni-sp', item_name: '由良ウニ(廣田丸)', origin: '兵庫', spec: 'SP)70g-80g' },
  { id: 'uni-toku', item_name: '由良ウニ(廣田丸)', origin: '兵庫', spec: '特上)70g-80g' },
  { id: 'aji', item_name: 'マアジ', origin: '', spec: '' },
  { id: 'hamo1', item_name: '極上ハモ', origin: '徳島', spec: '' },
  { id: 'hamo2', item_name: '極上ハモ', origin: '兵庫', spec: '' },
];
const certain = (name, extra = {}) => pickCertainCandidate({ item_name: name, ...extra }, ms)?.id ?? null;

// 天然鯛・タイ・天タイ・鯛 → 活天然タイSP（確実）
for (const n of ['天然鯛', 'タイ', '天タイ', '鯛', '天然鯛SP']) assert.equal(certain(n), 'tai-sp', n);
// 完全一致で1件だけ → 確実
assert.equal(certain('マアジ'), 'aji');
// マダイ・真鯛 → 活天然タイ（規格違い2件なので候補に出るが確定はしない／1件なら確定）
for (const n of ['マダイ', '真鯛']) {
  const r = rankManuscriptCandidates({ item_name: n }, ms).filter((c) => c.tier === 4).map((c) => c.item.id).sort();
  assert.deepEqual(r, ['tai-jo', 'tai-sp'], n);
  assert.equal(certain(n), null);
  assert.equal(pickCertainCandidate({ item_name: n }, ms.filter((x) => x.id !== 'tai-jo'))?.id, 'tai-sp');
}
// アジ → マアジ は確定（kento指示）
assert.equal(certain('アジ'), 'aji');
assert.equal(certain('鯵'), 'aji');
// 部分一致で候補が複数（産地違い）→ 確実ではない
assert.equal(certain('ハモ'), null);
// 同名で産地違いが複数 → 産地の指定が無ければ確実ではない、あれば確実
assert.equal(certain('極上ハモ'), null);
assert.equal(certain('極上ハモ', { origin: '徳島' }), 'hamo1');
// 選択肢が1つしかない（部分一致でも）→ 確実
assert.equal(pickCertainCandidate({ item_name: 'サワラ' }, [{ id: 'sawara', item_name: '寒サワラ', origin: '', spec: '' }, ...ms])?.id, 'sawara');
// 廣田丸（船名）→ 由良ウニ(廣田丸) が候補に出る（規格違い2件なので確実ではない）
assert.deepEqual(rankManuscriptCandidates({ item_name: '廣田丸' }, ms).map((c) => c.item.id).sort(), ['uni-sp', 'uni-toku']);
assert.equal(certain('廣田丸'), null);
// 検索: ひらがな・大文字小文字・複数語
assert.deepEqual(searchManuscriptItems('たい sp', ms).map((m) => m.id), ['tai-sp']);
assert.deepEqual(searchManuscriptItems('廣田丸 特上', ms).map((m) => m.id), ['uni-toku']);
assert.deepEqual(searchManuscriptItems('  ', ms), []);
// 目方が近いもの（産地一致が条件）
assert.deepEqual(parseGramsRange('70g-80g'), [70, 80]);
assert.deepEqual(parseGramsRange('500-700g'), [500, 700]);
assert.deepEqual(parseGramsRange('1.2kg'), [1200, 1200]);
assert.deepEqual(parseGramsRange('1kg〜1.5kg'), [1000, 1500]);
assert.equal(parseGramsRange('SP'), null);
const hamo = [
  { id: 'h600', item_name: 'ハモ', origin: '兵庫', spec: '600g' },
  { id: 'h800', item_name: 'ハモ', origin: '兵庫', spec: '800g' },
  { id: 'h1k', item_name: 'ハモ', origin: '兵庫', spec: '1kg' },
];
const pick = (it, list = hamo) => pickCertainCandidate(it, list)?.id ?? null;
assert.equal(pick({ item_name: 'ハモ850g' }), 'h800'); // 産地が全て同じ → 一番近い800g
assert.equal(pick({ item_name: 'ハモ', spec: '850g' }), 'h800');
assert.equal(pick({ item_name: 'ハモ', spec: '850g', origin: '兵庫' }), 'h800');
assert.equal(pick({ item_name: 'ハモ', spec: '850g', origin: '徳島' }), null); // 産地が一致しない
assert.equal(pick({ item_name: 'ハモ', spec: '700g' }), null); // 600gと800gで同着
assert.equal(pick({ item_name: 'ハモ' }), null); // 目方の記載なし
const mixed = [...hamo, { id: 't800', item_name: 'ハモ', origin: '徳島', spec: '800g' }];
assert.equal(pick({ item_name: 'ハモ', spec: '850g' }, mixed), null); // LINEに産地なし＆原稿に産地違い → 確定しない
assert.equal(pick({ item_name: 'ハモ', spec: '850g', origin: '徳島' }, mixed), 't800');
console.log('OK: 確実な候補のみデフォルト紐付け／天然鯛系→活天然タイSP／船名一致／原稿検索');
