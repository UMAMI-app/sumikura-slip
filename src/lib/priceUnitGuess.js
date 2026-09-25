// 単価単位（purchase_price_unit）の初期値を推測する共通ロジック。
// 原稿パーサー(manuscriptPurchase.js)・LINE実績データパーサー(lineShipment.js)の両方から使う。
//
// 優先順位:
//   1. 原文に単位が明記されていれば、呼び出し側でそれをそのまま使う（このファイルは呼ばれない）
//   2. 品目名による既知パターン（ウニ・雲丹は「枚」、サンマ・秋刀魚は「本」等）
//      → 実重量の有無より優先する（例: 由良ウニ・廣田丸の由良ウニ 等、名前に「ウニ」を
//        含む商品は実重量の記載があっても枚単価として扱う）
//   3. 商品ごとに学習済みの単位（product_price_units、原稿確定時に自動で覚える）があればそれを使う
//   4. どれにも当てはまらなければ「kg」をデフォルトにする（ユーザーの運用に合わせて変更可）
//
// 2026-09-23 追加変更（kento指示）: 廣田丸・由良ウニ・与助丸（うにの船名）は「枚」、
// 塩水ウニのみ「pc」、鮮魚セットは「式」。「塩水ウニ」は「ウニ」という文字を含むため、
// 広い「ウニ|雲丹」パターンより必ず先に判定しないと「枚」に負けてしまう点に注意
// （ルールは配列の先頭から順に判定し、最初に一致したものを使う）。
// ウニ系（塩水ウニ以外）の判定。船名（廣田丸・与助丸・山由丸）も含む。
const UNI_RE = /ウニ|うに|雲丹|廣田丸|広田丸|与助丸|山由丸/;

const NAME_UNIT_RULES = [
  { re: /塩水(?:ウニ|うに|雲丹)/, unit: 'pc' }, // 2026-09-25: 塩水雲丹・塩水うにも対象（kento指示）
  { re: /鮮魚セット/, unit: '式' },
  { re: UNI_RE, unit: '枚' },
  { re: /サンマ|秋刀魚/, unit: '本' },
];

export function guessPurchasePriceUnit(itemName, learnedUnit) {
  const name = itemName || '';
  for (const rule of NAME_UNIT_RULES) {
    if (rule.re.test(name)) return rule.unit;
  }
  if (learnedUnit) return learnedUnit;
  return 'kg';
}

// 2026-09-23 追加変更（kento指示）: 数量(quantity/quantity_unit)側の初期値推測。
// LINE実績データに数量の記載が一切無かった場合、quantityは1、quantity_unitは
// 品目名による既知パターン（NAME_UNIT_RULESを共用。ウニ・雲丹・廣田丸・与助丸は「枚」、
// 塩水ウニは「pc」、鮮魚セットは「式」等）で推測し、どれにも当てはまらなければ「本」を
// デフォルトにする（purchase_price_unitのkgデフォルトとは別）。
// 学習済み単位(product_price_units)は単価単位の学習用データであり、数量の数え方とは
// 意味が異なるため、ここでは使わない。
export function guessQuantityUnit(itemName) {
  const name = itemName || '';
  for (const rule of NAME_UNIT_RULES) {
    if (rule.re.test(name)) return rule.unit;
  }
  return '本';
}

// 2026-09-23 追加変更（kento指示・7〜8回目）: 塩水ウニ以外のウニ系（ウニ・うに・雲丹・廣田丸・
// 与助丸・山由丸）は、LINE実績データの原文に「2 pc」のように別の単位が明記されていても、
// 数量単位・単価単位とも「なにがなんでも」必ず「枚」にする。
// （従来は原文の明記単位が最優先で、名前ルールは単位未記載時にしか効かなかったため、
//   「廣田丸ウニ / 2 pc」が pc のまま残っていた。）
// 「塩水ウニ」を含む品目だけは対象外（従来どおり、原文の単位 → 無ければ「pc」）。
export function forcedUnitForName(itemName) {
  const name = itemName || '';
  // 2026-09-25 変更（kento指示）: 塩水ウニ・塩水雲丹・塩水うには、原文の単位に関係なく必ず「pc」
  if (/塩水(?:ウニ|うに|雲丹)/.test(name)) return 'pc';
  if (UNI_RE.test(name)) return '枚';
  return null;
}

// 2026-09-25 追加（kento指示）: タコ・イカ類は数量の単位を必ず「杯」にする（原文に別の単位が
// 書かれていても）。対象: マダコ・タコ・蛸・たこ・真蛸・まだこ・真ダコ・真だこ・イカ・剣先イカ・
// ヤリイカ・コウイカ・新イカ・ハリイカ・アオリイカ・いか（それぞれを含む品目名）。
// 「イカナゴ」「いかなご」は魚（イカではない）なので対象外。
// 単価の単位（kg単価など）は変えない（数量の数え方だけ）。
const TAKO_IKA_RE = /タコ|蛸|たこ|ダコ|だこ|イカ|いか/;
const NOT_IKA_RE = /イカナゴ|いかなご/;
export function forcedQuantityUnitForName(itemName) {
  const name = itemName || '';
  const uni = forcedUnitForName(name);
  if (uni) return uni;
  if (TAKO_IKA_RE.test(name.replace(NOT_IKA_RE, ''))) return '杯';
  return null;
}
