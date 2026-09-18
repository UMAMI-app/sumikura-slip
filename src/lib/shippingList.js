// 発注リスト（発送リスト）読み込み処理
//
// LINE等で共有される「🚚 発送リスト」形式のテキストから、発注行
// （納品日・納品先・品目・産地・数量・要望・配送区分）を抽出する。
// 目方（実際の目方）はこの時点ではまだ分からないことが多いため空欄のままにし、
// 納品段階でユーザーが入力する（開発指示書どおり）。
//
// フォーマットの前提（実データから確認したもの。今後フォーマットが変わった場合は
// このファイルの正規表現を調整すればよい）:
//   【当日分】 / 【宅急便分】 のセクション見出し
//   🚚 9/18（金） 発送リスト  … そのセクションの発送日
//   ━━━━━━━━━━━━ … 区切り線
//   発送先
//   【店名】
//   〒郵便番号
//   住所
//   電話番号
//   発送方法: 配達🚛 / 航空便✈️ / 宅急便
//   納品日: 9/18（金） 午前中
//   注文内容:
//     ◾️品目名 数量単位  ㎏（要望: ...）
//     ◾️送料 1
//
// 「◾️品目 数量単位  ㎏」の末尾の「㎏」は、実重量が未記入のときの
// プレースホルダーであることが多い（実重量は納品時に入力するため）。
// 産地は「足赤エビ(兵庫・淡路)」のように品目名にカッコ書きで含まれることがあるため、
// カッコの中身が都道府県名を含む場合だけ産地として分離する
// （「白甘鯛(1.3kg)」のようなサイズ表記のカッコと区別するため）。

import { ORIGIN_NAMES } from './manuscriptKadokura.js';

// 発送先名から「様」「株式会社」を取り除く（発注一覧・価格チェックの見出し表示用に整形する）
export function cleanDestinationName(name) {
  return (name || '')
    .replace(/株式会社/g, '')
    .replace(/様\s*$/, '')
    .trim();
}

const CATEGORY_MAP = [
  { re: /航空便/, category: 'air' },
  { re: /宅急便/, category: 'takkyu' },
  { re: /配達|配送/, category: 'ground' },
];

function classifyCategory(text) {
  const found = CATEGORY_MAP.find((c) => c.re.test(text));
  return found ? found.category : 'ground';
}

// 「白甘鯛(1.3kg)」のようなサイズ表記と、「足赤エビ(兵庫・淡路)」のような産地表記を区別し、
// 産地の場合だけ品目名から分離する。
function splitOriginFromName(name) {
  const m = name.match(/[（(]([^)）]+)[)）]/);
  if (m && ORIGIN_NAMES.some((p) => m[1].includes(p))) {
    const cleaned = (name.slice(0, m.index) + name.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
    return { name: cleaned, origin: m[1].trim() };
  }
  return { name, origin: '' };
}

function parseItemBody(rawBody) {
  const body = rawBody.replace(/[　]/g, ' ').trim();

  // 「18,000円分」のような予算指定
  let m = body.match(/^(.*?)\s+([\d,]+)\s*円分\s*$/);
  if (m) {
    const { name, origin } = splitOriginFromName(m[1].trim());
    return { item_name: name, origin, quantity: parseInt(m[2].replace(/,/g, ''), 10), quantity_unit: '円分' };
  }

  // 末尾の "㎏"/"kg" ラベル（実重量が空欄のプレースホルダーであることが多い）を除く
  let s = body.replace(/\s*(㎏|kg)\s*$/i, '').trim();

  // 数量+単位（本/尾/杯/枚/個/箱/束/ケ/ヶ）。「キンメ×3枚」のように×が挟まることがある
  m = s.match(/^(.*?)[×x]?\s*(\d+(?:\.\d+)?)\s*(本|尾|杯|枚|個|箱|束|ケ|ヶ)\s*$/);
  if (m) {
    const { name, origin } = splitOriginFromName(m[1].trim());
    return { item_name: name, origin, quantity: parseFloat(m[2]), quantity_unit: m[3].replace('ケ', 'ヶ') };
  }

  // 単位語のない裸の数量（例:「送料 1」「足赤エビ(兵庫・淡路) 80g前後 1」）
  m = s.match(/^(.*?)\s+(\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const { name, origin } = splitOriginFromName(m[1].trim());
    return { item_name: name, origin, quantity: parseFloat(m[2]), quantity_unit: '' };
  }

  const { name, origin } = splitOriginFromName(s);
  return { item_name: name, origin, quantity: null, quantity_unit: '' };
}

// M/D を、基準日(referenceDateStr: 'YYYY-MM-DD')の年を使ってYYYY-MM-DDにする。
// 年またぎ（例: 12月に基準日があり、1月の日付が出てくる場合）は翌年として扱う。
function resolveDate(month, day, referenceDateStr) {
  const [refYear, refMonth] = referenceDateStr.split('-').map(Number);
  let year = refYear;
  if (refMonth === 12 && month === 1) year += 1;
  else if (refMonth === 1 && month === 12) year -= 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// rawText: 発送リストの生テキスト
// referenceDateStr: 現在アプリで選択されている日付('YYYY-MM-DD')。M/D表記の年を補うのに使う。
export function parseShippingList(rawText, referenceDateStr) {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const results = [];
  const warnings = [];
  let sectionShipDate = null; // 宅急便分セクションの発送日('YYYY-MM-DD')
  let dest = null;

  const flushDest = () => {
    if (dest && dest.items.length > 0) results.push(dest);
    else if (dest && dest.name) warnings.push(`${dest.name}: 注文内容が見つかりませんでした`);
    dest = null;
  };

  for (const line of lines) {
    if (!line) continue;
    let m;

    if ((m = line.match(/^【(当日分|宅急便分)】$/))) {
      flushDest();
      continue;
    }
    if ((m = line.match(/^🚚\s*(\d{1,2})\/(\d{1,2})[（(].+?[)）]\s*発送リスト$/))) {
      sectionShipDate = resolveDate(parseInt(m[1], 10), parseInt(m[2], 10), referenceDateStr);
      continue;
    }
    if (line.startsWith('━')) continue;
    if (line === '発送先') {
      flushDest();
      dest = { name: '', category: 'ground', methodRaw: '', deliveryDate: null, deliveryNote: '', shipDate: null, items: [] };
      continue;
    }
    if (!dest) continue;

    if (!dest.name && (m = line.match(/^【(.+)】$/))) { dest.name = cleanDestinationName(m[1]); continue; }
    if (/^〒[\d０-９-]+$/.test(line)) continue; // 郵便番号
    if (/^[\d０-９-]{9,}$/.test(line.replace(/[\s-]/g, '')) && /\d{2,4}-\d{2,4}-\d{3,4}/.test(line)) continue; // 電話番号

    if ((m = line.match(/^発送方法[:：]\s*(.+)$/))) {
      dest.category = classifyCategory(m[1]);
      dest.methodRaw = m[1];
      continue;
    }
    if ((m = line.match(/^納品日[:：]\s*(\d{1,2})\/(\d{1,2})[（(].+?[)）]\s*(.*)$/))) {
      dest.deliveryDate = resolveDate(parseInt(m[1], 10), parseInt(m[2], 10), referenceDateStr);
      dest.deliveryNote = (m[3] || '').trim();
      dest.shipDate = dest.category === 'takkyu' ? sectionShipDate : null;
      continue;
    }
    if (/^注文内容[:：]?$/.test(line)) continue;

    if (line.startsWith('◾️') || line.startsWith('■') || line.startsWith('◾')) {
      const body = line.replace(/^[◾■]️?\s*/, '');
      const noteMatch = body.match(/^(.*?)[（(]要望[:：]\s*(.*?)[)）]\s*$/);
      const mainText = (noteMatch ? noteMatch[1] : body).trim();
      const requestNote = noteMatch ? noteMatch[2].trim() : '';
      const parsed = parseItemBody(mainText);
      dest.items.push({ ...parsed, request_note: requestNote, raw: line });
      continue;
    }
    // 住所など、上記のどれにも当てはまらない行は無視する
  }
  flushDest();

  // order_lines用の行データに変換
  const rows = [];
  results.forEach((d) => {
    if (!d.name) { warnings.push('納品先が空の発送先ブロックがありました（スキップ）'); return; }
    const skipShippingFee = /航空便|自社配送/.test(d.methodRaw || '');
    d.items.forEach((it) => {
      if (skipShippingFee && /^送料/.test(it.item_name || '')) return;
      rows.push({
        destination: d.name,
        delivery_category: d.category,
        delivery_date: d.deliveryDate,
        delivery_time_note: d.deliveryNote,
        takkyu_ship_date: d.category === 'takkyu' ? d.shipDate : null,
        takkyu_arrival_date: d.category === 'takkyu' ? d.deliveryDate : null,
        item_name: it.item_name,
        origin: it.origin || '',
        quantity: it.quantity,
        quantity_unit: it.quantity_unit || '',
        weight: '',
        request_note: it.request_note || '',
        raw_line: it.raw,
      });
    });
  });

  return { rows, warnings };
}
