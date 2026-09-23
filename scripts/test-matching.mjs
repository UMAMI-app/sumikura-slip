// matching.js（LINE実績データ ↔ 原稿の紐付け候補）の回帰テスト。
import assert from 'node:assert';
import { rankManuscriptCandidates, pickCertainCandidate, searchManuscriptItems } from '../src/lib/matching.js';

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
for (const n of ['天然鯛', 'タイ', '天タイ', '鯛']) assert.equal(certain(n), 'tai-sp', n);
// 完全一致で1件だけ → 確実
assert.equal(certain('マアジ'), 'aji');
// 表記揺れ・部分一致だけ → 確実ではない（デフォルト設定しない）
assert.equal(certain('アジ'), null);
assert.equal(certain('ハモ'), null);
// 同名で産地違いが複数 → 産地の指定が無ければ確実ではない、あれば確実
assert.equal(certain('極上ハモ'), null);
assert.equal(certain('極上ハモ', { origin: '徳島' }), 'hamo1');
// 廣田丸（船名）→ 由良ウニ(廣田丸) が候補に出る（規格違い2件なので確実ではない）
assert.deepEqual(rankManuscriptCandidates({ item_name: '廣田丸' }, ms).map((c) => c.item.id).sort(), ['uni-sp', 'uni-toku']);
assert.equal(certain('廣田丸'), null);
// 検索: ひらがな・大文字小文字・複数語
assert.deepEqual(searchManuscriptItems('たい sp', ms).map((m) => m.id), ['tai-sp']);
assert.deepEqual(searchManuscriptItems('廣田丸 特上', ms).map((m) => m.id), ['uni-toku']);
assert.deepEqual(searchManuscriptItems('  ', ms), []);
console.log('OK: 確実な候補のみデフォルト紐付け／天然鯛系→活天然タイSP／船名一致／原稿検索');
