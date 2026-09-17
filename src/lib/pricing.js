// 単価計算・消費税計算・原稿単価との照合ロジック（開発指示書 15〜20章）
// 副作用のない純粋関数のみを置き、Node上でもテストできるようにしている
// （scripts/test-pricing.mjs 参照）。

// 目方・数量と単価から金額を計算する（開発指示書16章）。
// price_unit が 'kg' なら「目方 × 単価」、それ以外（本/尾/個/箱/束/枚/杯/自由入力）なら
// 「数量 × 単価」。対応していない単位が来た場合は、呼び出し側でユーザーに
// 計算方法（重量ベースか数量ベースか）を選ばせられるよう、判定不能な単位は
// isWeightBased=false（数量ベース）として扱いつつ warning を返す。
export function calcLineAmount({ priceUnit, unitPrice, actualWeight, actualQuantity }) {
  if (unitPrice == null || Number.isNaN(unitPrice)) return { amount: null, basis: null };
  const isWeightBased = priceUnit === 'kg';
  if (isWeightBased) {
    if (actualWeight == null || Number.isNaN(actualWeight)) return { amount: null, basis: 'weight' };
    return { amount: round2(actualWeight * unitPrice), basis: 'weight' };
  }
  if (actualQuantity == null || Number.isNaN(actualQuantity)) return { amount: null, basis: 'quantity' };
  return { amount: round2(actualQuantity * unitPrice), basis: 'quantity' };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 原稿単価と実納品単価を比較する（開発指示書15章）。
// 「高くなった場合だけ警告」「安くなった場合は通常表示（強調しない）」。
export function comparePrice(manuscriptUnitPrice, actualUnitPrice) {
  if (manuscriptUnitPrice == null || actualUnitPrice == null) {
    return { status: 'no_manuscript_price', diff: null };
  }
  const diff = actualUnitPrice - manuscriptUnitPrice;
  if (diff > 0) return { status: 'up', diff };
  if (diff < 0) return { status: 'down', diff };
  return { status: 'same', diff: 0 };
}

// 消費税8%、1円単位四捨五入（開発指示書20章）。
export const TAX_RATE = 0.08;
export function calcTax(subtotal, rate = TAX_RATE) {
  return Math.round(subtotal * rate);
}

export function buildInvoiceTotals(lineItems) {
  const subtotal = lineItems.reduce((sum, li) => sum + (li.amount || 0), 0);
  const tax = calcTax(subtotal);
  const total = subtotal + tax;
  return { subtotal, tax, total };
}

// 配送区分の表示グルーピング（開発指示書8章・18章）。
// 内部的には 'air' | 'ground' | 'takkyu' の3値を保持しつつ、
// 画面・納品書では「当日納品（航空便・配送便）」と「宅急便」の2グループに分ける。
export function isSameDayCategory(deliveryCategory) {
  return deliveryCategory === 'air' || deliveryCategory === 'ground';
}

export const DELIVERY_CATEGORY_LABELS = {
  air: '航空便',
  ground: '配送便',
  takkyu: '宅急便',
};
