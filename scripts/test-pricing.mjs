import { calcLineAmount, comparePrice, calcTax, buildInvoiceTotals, computeSellPrice, buildProfitTotals } from '../src/lib/pricing.js';
import assert from 'node:assert';

// ケース4: kg単価 1.5kg × ¥12,000/kg = ¥18,000
assert.equal(calcLineAmount({ priceUnit: 'kg', unitPrice: 12000, actualWeight: 1.5 }).amount, 18000);

// ケース5: 本単価 10本 × ¥900/本 = ¥9,000
assert.equal(calcLineAmount({ priceUnit: '本', unitPrice: 900, actualQuantity: 10 }).amount, 9000);

// comparePriceはオブジェクト引数の形に変わっていたため、テスト側を合わせた（2026-09-23）
// ケース6: 原稿より高い → warning
assert.equal(comparePrice({ manuscriptPrice: 12000, actualPrice: 12500, manuscriptUnit: 'kg', actualUnit: 'kg' }).status, 'up');
assert.equal(comparePrice({ manuscriptPrice: 12000, actualPrice: 12500, manuscriptUnit: 'kg', actualUnit: 'kg' }).diff, 500);

// ケース7: 原稿より安い → 警告しない（downだが強調はUI側で行わない）
assert.equal(comparePrice({ manuscriptPrice: 12000, actualPrice: 11500, manuscriptUnit: 'kg', actualUnit: 'kg' }).status, 'down');

// 同額
assert.equal(comparePrice({ manuscriptPrice: 12000, actualPrice: 12000, manuscriptUnit: 'kg', actualUnit: 'kg' }).status, 'same');

// 原稿価格なし
assert.equal(comparePrice({ manuscriptPrice: null, actualPrice: 12000, manuscriptUnit: 'kg', actualUnit: 'kg' }).status, 'no_manuscript_price');

// ケース8: 消費税端数
assert.equal(calcTax(50007), 4001); // 50007*0.08=4000.56 -> 4001
assert.equal(calcTax(50006), 4000); // 50006*0.08=4000.48 -> 4000

const totals = buildInvoiceTotals([{ amount: 18000 }, { amount: 9000 }, { amount: 23007 }]);
assert.equal(totals.subtotal, 50007);
assert.equal(totals.tax, 4001);
assert.equal(totals.total, 54008);

// ケース9: 利益計算。1万円以上は1.1倍、未満は1.15倍。売値入力済みならそちらを優先。
assert.equal(computeSellPrice({ amount: 10000 }), 11000); // 10000 * 1.1
assert.equal(computeSellPrice({ amount: 4200 }), 4900); // 4200 * 1.15 = 4830 -> 十の位切り上げ 4900
assert.equal(computeSellPrice({ amount: 4000 }), 4600); // 4000 * 1.15 = 4600（ちょうどなら据え置き）
assert.equal(computeSellPrice({ amount: 12000 }), 13200); // 12000 * 1.1 = 13200.000000000002 でも13300にしない
assert.equal(computeSellPrice({ amount: 9999 }), 11500); // 9999 * 1.15 = 11498.85 -> 11500
assert.equal(computeSellPrice({ amount: 10000, sell_price: 12000 }), 12000); // 入力済みを優先

const profit = buildProfitTotals([{ amount: 10000 }, { amount: 5000 }]);
assert.equal(profit.cost, 15000);
assert.equal(profit.sell, 16800); // 11000 + 5800（5750を十の位切り上げ）
assert.equal(profit.profit, 1800);

console.log('OK: pricing/tax logic matches spec test cases (4,5,6,7,8,9)');
