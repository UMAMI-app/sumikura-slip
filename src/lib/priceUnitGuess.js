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

const NAME_UNIT_RULES = [
  { re: /ウニ|雲丹/, unit: '枚' },
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
