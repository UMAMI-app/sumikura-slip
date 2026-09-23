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

// 原稿単価と実納品単価を比較する（開発指示書15章、LINE実績データ追加仕様12〜13章）。
// 「高くなった場合だけ警告」「安くなった場合は通常表示（強調しない）」。
// 単位が異なる場合は数値としての単純比較をせず、必ず'unit_mismatch'を返す
// （例: 原稿¥6,000/kg vs 実績¥3,700/本 は比較不能。ユーザーが比較単位を指定する）。
// 単位が片方でも空（未入力）の場合は比較を保留し'unit_unknown'を返す
// （LINEの「仕入 ¥○○」に単位が書かれていないケースを想定。勝手にkgと決めつけない）。
export function comparePrice({ manuscriptPrice, manuscriptUnit, actualPrice, actualUnit } = {}) {
  if (manuscriptPrice == null || actualPrice == null) {
    return { status: 'no_manuscript_price', diff: null };
  }
  if (!manuscriptUnit || !actualUnit) {
    return { status: 'unit_unknown', diff: null, manuscriptUnit, actualUnit };
  }
  if (manuscriptUnit !== actualUnit) {
    return { status: 'unit_mismatch', diff: null, manuscriptUnit, actualUnit };
  }
  const diff = actualPrice - manuscriptPrice;
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
  air: '航空便✈️',
  ground: '配送便🚛',
  takkyu: '宅急便📦',
};

// 利益計算（2026-09-21 追加, kento指示）。
// 納品書明細の金額(amount)がそのまま仕入れ値。売値を明細ごとに入力・保存できるようにし
// （invoice_line_items.sell_price）、入力済みならその金額を使う。未入力なら仕入れ値から
// 自動計算する: 1万円以上は1.1倍、1万円未満は1.15倍（消費税は考慮しない＝税抜のまま計算）、
// 十の位を切り上げて100円単位にする。
export function computeSellPrice(item) {
  const cost = item.amount || 0;
  if (item.sell_price != null && item.sell_price !== '') {
    return Math.round(Number(item.sell_price));
  }
  const rate = cost >= 10000 ? 1.1 : 1.15;
  // 2026-09-23 変更（kento指示）: 自動計算した売値は十の位を切り上げて100円単位にする
  // （例: 4,200×1.15=4,830 → 4,900）。浮動小数の誤差（4000×1.1=4400.0000000000005 等）で
  // 1つ上に切り上がらないよう、先に小数第2位で丸めてから切り上げる。
  const raw = Math.round(cost * rate * 100) / 100;
  return Math.ceil(raw / 100) * 100;
}

export function buildProfitTotals(lineItems) {
  let cost = 0;
  let sell = 0;
  lineItems.forEach((li) => {
    cost += li.amount || 0;
    sell += computeSellPrice(li);
  });
  return { cost, sell, profit: sell - cost };
}
