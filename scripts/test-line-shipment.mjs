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
// 韓国ハモ・氷じめアジ・筋子・淡路コチ・カマス・サンマ の6件のみ（要望行が誤って品目化していた
// 「800g × 1本 ⚠️水洗い」「水洗い」「2腹」「⚠️水洗い」の4件、および送料は含まれない。
// 送料は2026-09-24（kento指示・4回目）以降、品目として一切扱わない）。
assert.equal(miyamoto.items.length, 6);
assert.deepEqual(
  miyamoto.items.map((it) => it.item_name),
  ['韓国ハモ', '氷じめアジ', '筋子', '淡路コチ', 'カマス', 'サンマ']
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
assert.deepEqual(yokoi.items.map((it) => it.item_name), ['極上 選り抜きハモ', 'カツオ']); // 送料は品目に含まれない

const rows = buildLineActualRows(destinations, '2026-09-20', {});
// 送料は品目として一切扱われないため、もともと納品書向けの行数とも一致する。
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
  assert.deepEqual(destinations[0].items.map((it) => it.item_name), ['真鯛']); // 送料は品目に含まれない
  console.log('OK: orderer/supplier/status header lines are never captured as items');
}

// 2026-09-23 追加（kento指示）: 数量の記載が無い場合は「1」＋品目ごとの数え方（ウニ→枚、
// 塩水ウニ→pc、鮮魚セット→式、廣田丸・与助丸→枚、それ以外は「本」）をデフォルトで補う
// ようにした機能の回帰テスト。
// 「了解」は仕入直後の備考として拾わせるためのダミー行（各品目の後に本当の備考が無い場合、
// 次の品目名がそのまま備考として吸われてしまわないようにするための区切り）。由良ウニのみ、
// ブロック最後（送料の直前）に置くことで、備考もダミー行も無いケースも合わせて確認する。
{
  const raw = `👤\n \n浦島一樹\n未確定\n角倉商店\n→\nよこい\n🚚 発送\n9/23\n📦 納品\n9/23午前中\n配達🚛\nカツオ\n3.3 ㎏\n仕入 ¥1,600\n了解\n塩水ウニ\n仕入 ¥2,000\n了解\n鮮魚セット\n仕入 ¥5,000\n了解\n廣田丸\n仕入 ¥12,000\n了解\n与助丸\n仕入 ¥11,000\n了解\n極上　選り抜きハモ\n2.2 ㎏\n仕入 ¥4,500\n500g × 4本\n由良ウニ\n仕入 ¥8,000\n送料\n1\n`;
  const { destinations, warnings } = parseLineShipmentText(raw, '2026-09-23');
  assert.equal(warnings.length, 0);
  const rows = buildLineActualRows(destinations, '2026-09-23', {});
  const katsuo = rows.find((r) => r.item_name === 'カツオ');
  assert.deepEqual({ qty: katsuo.quantity, unit: katsuo.quantity_unit }, { qty: 1, unit: '本' }); // 数量記載なし→デフォルト1本
  const shiomizuUni = rows.find((r) => r.item_name === '塩水ウニ');
  assert.deepEqual({ qty: shiomizuUni.quantity, unit: shiomizuUni.quantity_unit }, { qty: 1, unit: 'pc' }); // 塩水ウニのみpc
  const senmiSet = rows.find((r) => r.item_name === '鮮魚セット');
  assert.deepEqual({ qty: senmiSet.quantity, unit: senmiSet.quantity_unit }, { qty: 1, unit: '式' });
  const hirotamaru = rows.find((r) => r.item_name === '廣田丸');
  assert.deepEqual({ qty: hirotamaru.quantity, unit: hirotamaru.quantity_unit }, { qty: 1, unit: '枚' });
  const yosukemaru = rows.find((r) => r.item_name === '与助丸');
  assert.deepEqual({ qty: yosukemaru.quantity, unit: yosukemaru.quantity_unit }, { qty: 1, unit: '枚' });
  const hamo = rows.find((r) => r.item_name === '極上 選り抜きハモ');
  assert.deepEqual({ qty: hamo.quantity, unit: hamo.quantity_unit }, { qty: 4, unit: '本' }); // 記載済みの数量は上書きしない
  const yuraUni = rows.find((r) => r.item_name === '由良ウニ');
  assert.deepEqual({ qty: yuraUni.quantity, unit: yuraUni.quantity_unit }, { qty: 1, unit: '枚' }); // 数量記載なし＋「ウニ」既知パターン
  console.log('OK: missing quantity defaults to 1 + item-specific counting unit (uni/廣田丸/与助丸=枚, 塩水ウニ=pc, 鮮魚セット=式, default=本)');
}

// 2026-09-23 追加（kento指示・2回目）: 「仕入／売値」の直後に来る行は、NOTE_KEYWORDSに
// 一致しない自由記述であっても、新しい品目名にはせず直前の品目の「備考」として扱う不具合修正の
// 回帰テスト（実際に貼り付けて品目化してしまったという報告があった5ブロックそのまま）。
// 送料は品目として一切扱われないため、各ブロックの品目一覧にも含まれない
// （2026-09-24 kento指示・4回目）。
{
  const raw = readFileSync(path.join(__dirname, 'sample_line_shipment_request_notes.txt'), 'utf-8');
  const { destinations, warnings } = parseLineShipmentText(raw, '2026-09-19');
  assert.equal(warnings.length, 0);
  assert.equal(destinations.length, 5);

  const nishioka = destinations[0];
  assert.equal(nishioka.destinationName, '鮨にし岡');
  assert.deepEqual(nishioka.items.map((it) => it.item_name), ['迷いガツオ 腹1/4']);
  assert.equal(nishioka.items[0].note, 'バッチリなものお願いします');

  const hanhan = destinations[1];
  assert.equal(hanhan.destinationName, '半々（ｶ)ｼﾞｭｳｲﾁ）');
  assert.deepEqual(hanhan.items.map((it) => it.item_name), ['サワラ3.5kg', '極上ハモ']);
  assert.equal(hanhan.items[0].note, '肩身(骨なし)'); // 「肩身(骨なし)」が品目化されていた不具合
  assert.deepEqual(
    { spec: hanhan.items[1].spec, qty: hanhan.items[1].quantity, unit: hanhan.items[1].quantity_unit },
    { spec: '400g', qty: 1, unit: '本' }
  );

  const nonohara = destinations[2];
  assert.equal(nonohara.destinationName, '御料理野々原');
  assert.deepEqual(nonohara.items.map((it) => it.item_name), ['廣田丸ウニ']);
  assert.deepEqual(
    { qty: nonohara.items[0].quantity, unit: nonohara.items[0].quantity_unit, price: nonohara.items[0].purchase_price },
    { qty: 2, unit: 'pc', price: 14800 }
  );

  const wanoshoku = destinations[3];
  assert.equal(wanoshoku.destinationName, '和の食いがらし');
  assert.deepEqual(wanoshoku.items.map((it) => it.item_name), ['天然鯛', 'スマカツオ 半身']);
  assert.equal(wanoshoku.items[0].note, '2kg以下の場合は2枚‼️'); // ⚠️マーク付きの備考は従来通り拾える

  const shinozaki = destinations[4];
  assert.equal(shinozaki.destinationName, '篠崎　政考様');
  assert.deepEqual(shinozaki.items.map((it) => it.item_name), ['カツオ 半身']);
  assert.equal(shinozaki.items[0].note, '‼️今回個人伝票になります。金額分かり次第教えてください！！'); // 「今回個人伝票」が品目化されていた不具合

  console.log('OK: free-text request lines right after 仕入／売値 are captured as notes, not new items (real reported blocks)');
}

// 2026-09-24 追加（kento指示・3回目）: 送料の数量よりさらに後ろ（ブロックの末尾）に出てくる
// 「弘茂丸配送」が品目化されていた不具合の回帰テスト。「弘茂丸」というワードにだけ反応し、
// そのブロックの最後の実品目の備考として追記する（位置は問わない）。
{
  const raw = `👤\n \n浦島一樹\n未確定\n角倉商店\n→\nよこい\n🚚 発送\n9/19\n📦 納品\n9/19午前中\n配達🚛\n極上　選り抜きハモ\n1.2 ㎏\n仕入 ¥4,900\n500g × 2本\n送料\n1 \n弘茂丸配送\n`;
  const { destinations, warnings } = parseLineShipmentText(raw, '2026-09-19');
  assert.equal(warnings.length, 0);
  assert.equal(destinations.length, 1);
  const yokoi = destinations[0];
  assert.deepEqual(yokoi.items.map((it) => it.item_name), ['極上 選り抜きハモ']); // 「送料」も「弘茂丸配送」も品目化されていない
  assert.equal(yokoi.items[0].note, '弘茂丸配送'); // 最後の実品目（極上 選り抜きハモ）の備考に入る
  console.log('OK: "弘茂丸" anywhere in a block is attached as a note to the last real item, and 送料 is never treated as an item or a note');
}

// 2026-09-24 追加（kento指示・4回目）: 「送料は品目として認識しない・備考にも入れない」の
// 直接的な回帰テスト。仕入の直後に備考なしで送料が来るケース（カツオ）と、備考を挟んで
// 送料が来るケース（極上ハモ）の両方を確認する。
{
  const raw = `👤\n \n浦島一樹\n未確定\n角倉商店\n→\nよこい\n🚚 発送\n9/24\n📦 納品\n9/24午前中\n配達🚛\nカツオ\n3.3 ㎏\n仕入 ¥1,600\n送料\n1\n極上ハモ\n0.48 ㎏\n仕入 ¥3,700\n肩身\n送料\n1\n`;
  const { destinations, warnings } = parseLineShipmentText(raw, '2026-09-24');
  assert.equal(warnings.length, 0);
  const yokoi = destinations[0];
  // 「送料」という品目名自体がどの品目にも含まれない・備考にも現れないことを確認する。
  assert.deepEqual(yokoi.items.map((it) => it.item_name), ['カツオ', '極上ハモ']);
  assert.equal(yokoi.items.some((it) => (it.note || '').includes('送料')), false);
  const katsuo = yokoi.items.find((it) => it.item_name === 'カツオ');
  assert.equal(katsuo.note, ''); // 仕入の直後に備考なしで送料が来ても、送料自体は備考に入らない
  const hamo = yokoi.items.find((it) => it.item_name === '極上ハモ');
  assert.equal(hamo.note, '肩身'); // 送料の手前にある本当の備考は従来通り拾う
  console.log('OK: 送料 is never registered as an item and never leaks into any note text');
}

// 2026-09-25 追加（kento指示・5回目）: 「備考に巻き込まれて品目が備考に入ってしまってるわ」の
// 回帰テスト。「仕入／売値の直後の1行は備考」という位置ベースの判定だけでは、本当は次の品目名
// である行（メヒカリ銚子(40g)・鯵・生食かき・ハマグリ・赤ムツ等）まで備考に吸われてしまって
// いた。次の行が実重量／仕入・売値／数量のような「品目継続データ」らしければ、今見ている行は
// 備考ではなく新しい品目名だったと判断する先読みロジックの確認（実際に報告された4パターンを
// それぞれ再現する）。
{
  // 嘉多妻: 仕入の直後に「売値」が来て、さらにその直後に本当は新しい品目（メヒカリ銚子）が
  // 続くケース。旧ロジックでは売値が備考を再度アーム(rearm)し、メヒカリ銚子まで備考に
  // 巻き込まれていた。
  const raw = `👤\n \n浦島一樹\n未確定\n角倉商店\n→\n嘉多妻\n🚚 発送\n9/25\n📦 納品\n9/25午前中\n配達🚛\nサワラ半身\n1.8 ㎏\n仕入 ¥3,200\n売値 ¥4,500\nメヒカリ銚子(40g)\n0.3 ㎏\n仕入 ¥1,200\n送料\n1\n`;
  const { destinations, warnings } = parseLineShipmentText(raw, '2026-09-25');
  assert.equal(warnings.length, 0);
  const kataduma = destinations[0];
  assert.deepEqual(kataduma.items.map((it) => it.item_name), ['サワラ半身', 'メヒカリ銚子']); // メヒカリ銚子が備考に巻き込まれない
  const sawara = kataduma.items.find((it) => it.item_name === 'サワラ半身');
  assert.equal(sawara.note, ''); // 売値の内容はテキストの備考ではなく、下のsell_priceで確認する
  assert.equal(sawara.sell_price, 4500); // 「売値記載あるものは反応してほしい」: 数値として保持する
  const mehikari = kataduma.items.find((it) => it.item_name === 'メヒカリ銚子');
  assert.deepEqual({ spec: mehikari.spec, weight: mehikari.actual_weight, price: mehikari.purchase_price }, { spec: '40g', weight: 0.3, price: 1200 });
  console.log('OK: 仕入→売値のすぐ後に続く本当の次の品目（メヒカリ銚子）が備考に巻き込まれない（嘉多妻ブロック再現）');
}
{
  // お料理宮本: 仕入の直後、備考を挟まずそのまま次の品目（鯵）が続くケース。
  const raw = `👤\n \n後藤聖和\n未確定\n角倉商店\n→\nお料理宮本\n🚚 発送\n9/25\n📦 納品\n9/25午前中\n航空便✈️\n淡路ハモ\n1.5 ㎏\n仕入 ¥3,800\n鯵\n0.6 ㎏\n仕入 ¥1,900\n送料\n1\n`;
  const { destinations, warnings } = parseLineShipmentText(raw, '2026-09-25');
  assert.equal(warnings.length, 0);
  assert.deepEqual(destinations[0].items.map((it) => it.item_name), ['淡路ハモ', '鯵']); // 鯵が備考に巻き込まれない
  const hamo = destinations[0].items.find((it) => it.item_name === '淡路ハモ');
  assert.equal(hamo.note, '');
  console.log('OK: 仕入のすぐ後に続く本当の次の品目（鯵）が備考に巻き込まれない（お料理宮本ブロック再現）');
}
{
  // 白林荘: 仕入の直後に品目が2連続で続くケース（サンマ→生食かき→ハマグリ）。
  const raw = `👤\n \n見富剛\n未確定\n角倉商店\n→\n白林荘（神田陽介）\n🚚 発送\n9/25\n📦 納品\n9/25午前中\n配達🚛\nサンマ\n0.4 ㎏\n仕入 ¥900\n生食かき\n1.0 ㎏\n仕入 ¥2,600\nハマグリ\n0.8 ㎏\n仕入 ¥1,500\n送料\n1\n`;
  const { destinations, warnings } = parseLineShipmentText(raw, '2026-09-25');
  assert.equal(warnings.length, 0);
  assert.deepEqual(destinations[0].items.map((it) => it.item_name), ['サンマ', '生食かき', 'ハマグリ']); // 2連続とも備考に巻き込まれない
  destinations[0].items.forEach((it) => assert.equal(it.note, ''));
  console.log('OK: 仕入のすぐ後に品目が2連続で続いても両方とも備考に巻き込まれない（白林荘ブロック再現）');
}
{
  // 鮨陸: 由良ウニ（うに＝枚単価の既知パターン）の直後に本当の次の品目（赤ムツ）が続くケース。
  const raw = `👤\n \n奥秋勝也\n未確定\n角倉商店\n→\n鮨陸\n🚚 発送\n9/25\n📦 納品\n9/25午前中\n配達🚛\n由良ウニ\n仕入 ¥7,500\n赤ムツ(600g)\n1.1 ㎏\n仕入 ¥5,200\n送料\n1\n`;
  const { destinations, warnings } = parseLineShipmentText(raw, '2026-09-25');
  assert.equal(warnings.length, 0);
  assert.deepEqual(destinations[0].items.map((it) => it.item_name), ['由良ウニ', '赤ムツ']); // 赤ムツが備考に巻き込まれない
  const yuraUni = destinations[0].items.find((it) => it.item_name === '由良ウニ');
  assert.equal(yuraUni.note, '');
  console.log('OK: 由良ウニの直後に続く本当の次の品目（赤ムツ）が備考に巻き込まれない（鮨陸ブロック再現）');
}

// 2026-09-25 追加（kento指示・5回目）: 「送料別！」のような、送料についての自由記述の備考
// （送料マーカー行そのものではない）が、誤って送料マーカーとして食べられて情報が失われないこと
// の確認。SHIPPING_FEE_LINE_RE は「送料」＋任意のカッコ書きのみに厳密化してあるため、
// 「送料別！」は通常の備考判定に流れて拾われる。
{
  const raw = `👤\n \n岡本研人\n未確定\n角倉商店\n→\n楽只\n🚚 発送\n9/25\n📦 納品\n9/25午前中\n配達🚛\nスズキ\n1.4 ㎏\n仕入 ¥3,100\n送料別！\n`;
  const { destinations, warnings } = parseLineShipmentText(raw, '2026-09-25');
  assert.equal(warnings.length, 0);
  assert.deepEqual(destinations[0].items.map((it) => it.item_name), ['スズキ']); // 新しい品目として誤登録されない
  assert.equal(destinations[0].items[0].note, '送料別！'); // 送料マーカーとして食べられず、備考として保持される
  console.log('OK: 「送料別！」のような送料についての自由記述の備考は、送料マーカーとして食べられず備考として保持される');
}

// 2026-09-25 追加（kento指示・5回目）: 「送料(箱代含む)」のように送料マーカー行の後に、
// その送料自体の数量行だけでなく価格行（仕入 ¥○○）まで続くケースで、直前の実品目の
// purchase_priceが上書きされてしまわないことの確認（白林荘・鮨陸ブロックで発見）。
{
  const raw = `👤\n \n見富剛\n未確定\n角倉商店\n→\n鮨陸\n🚚 発送\n9/25\n📦 納品\n9/25午前中\n配達🚛\n赤ムツ(600g)\n1.1 ㎏\n仕入 ¥5,200\n送料(箱代含む)\n1\n仕入 ¥2,200\n`;
  const { destinations, warnings } = parseLineShipmentText(raw, '2026-09-25');
  assert.equal(warnings.length, 0);
  assert.deepEqual(destinations[0].items.map((it) => it.item_name), ['赤ムツ']); // 品目は1件のみ（送料は品目化されない）
  const akamutsu = destinations[0].items.find((it) => it.item_name === '赤ムツ');
  assert.equal(akamutsu.purchase_price, 5200); // 送料の「仕入 ¥2,200」に上書きされていないこと
  console.log('OK: 送料マーカー行の後に続く価格行（仕入 ¥○○）も読み飛ばされ、直前の実品目のpurchase_priceを上書きしない');
}
