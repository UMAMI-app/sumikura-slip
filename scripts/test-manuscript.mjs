import { parseGrid, extractManuscriptItems } from '../src/lib/manuscript.js';
import assert from 'node:assert';

// ケース: 開発指示書 6章 例1・例2、33章 ケース1・ケース2
const tsv = [
  ['魚種','サイズ','産地','価格'].join('\t'),
  ['白甘鯛','1.5kg','和歌山','k12,000'].join('\t'),
  ['白甘鯛','1.5kg','長崎','k13,000'].join('\t'),
  ['秋刀魚','10本','','900円/本'].join('\t'),
  ['甘鯛','1.8kg','福井','k8,000'].join('\t'),
].join('\n');

const { grid, blocks } = parseGrid(tsv);
const { items, skippedLines } = extractManuscriptItems(grid, blocks);

console.log(JSON.stringify(items, null, 2));
console.log('skipped:', skippedLines);

assert.equal(items.length, 4);
assert.deepEqual(
  { name: items[0].item_name, origin: items[0].origin, spec: items[0].spec, price: items[0].unit_price, unit: items[0].price_unit },
  { name: '白甘鯛', origin: '和歌山', spec: '1.5kg', price: 12000, unit: 'kg' }
);
assert.deepEqual(
  { name: items[1].item_name, origin: items[1].origin, price: items[1].unit_price, unit: items[1].price_unit },
  { name: '白甘鯛', origin: '長崎', price: 13000, unit: 'kg' }
);
assert.deepEqual(
  { name: items[2].item_name, origin: items[2].origin, price: items[2].unit_price, unit: items[2].price_unit },
  { name: '秋刀魚', origin: '', price: 900, unit: '本' }
);
console.log('OK: manuscript extraction matches spec examples');
