// LINE発注システムからコピーした「出荷実績データ」を読み込む処理。
//
// 発注一覧（src/lib/shippingList.js）が読み込む「発送リスト」形式（発送作業の事前チェックリスト用、
// まだ実際の目方・仕入価格が分からない段階のもの）とは別の、もう一つの入力経路。
// こちらはLINEの発注システム上にすでに表示されている「実際の」出荷データ
// （実目方・仕入価格を含む）を貼り付けて、原稿突合・価格チェック・納品書作成に使う
// （追加仕様書「LINE出荷実績データを利用した照合・納品書作成」参照）。
//
// フォーマットの前提（提示された1例から組み立てたもの。LINEアプリの仕様上、
// 各項目の間に空行が挟まることが多いため、空行は読み飛ばして意味のある行だけを
// 順番に処理する）:
//
//   👤                      … 1件のブロックの開始マーカー
//   見富剛                  … 発注者（使わない）
//   未確定                  … ステータス等（使わない。無い場合もある）
//   角倉商店                … 発注元（使わない）
//   →                       … 発注元→納品先の矢印
//   わたなべ                … 納品先（店舗名として使う）
//   🚚 発送
//   9/19                    … 発送日
//   📦 納品
//   9/19午前中               … 納品日＋納品時間帯の自由記述
//   航空便✈️                 … 配送方法
//   赤ムツ(600g) 2本         … 品目名(規格) 数量+単位
//   1.13㎏                   … 実目方
//   仕入 ¥13,000             … 仕入価格（単位が書かれていないことが多い。勝手にkgと決めつけない）
//   送料                     … 品目名だけの行（数量は次の行に来ることがある）
//   1                       … 直前の品目(送料)の数量
//
// 「仕入 ¥○○」の後に単位が明記されていない場合、actual_unit_price_unit は空文字のままにする
// （空欄なら原稿の単価単位を基準に金額計算する。単位が判断できない場合はユーザーに選ばせる）。
// 今後実データでフォーマットのズレが見つかった場合は、このファイルの正規表現を調整すればよい。

import { ORIGIN_NAMES } from './manuscriptKadokura.js';

const CATEGORY_MAP = [
  { re: /航空便/, category: 'air' },
  { re: /宅急便/, category: 'takkyu' },
  { re: /配達|配送/, category: 'ground' },
];

function classifyCategory(text) {
  const found = CATEGORY_MAP.find((c) => c.re.test(text));
  return found ? found.category : 'ground';
}

// M/D を、基準日(referenceDateStr: 'YYYY-MM-DD')の年を使ってYYYY-MM-DDにする。
// 年またぎ（12月に基準日があり1月の日付が出てくる場合など）は翌年として扱う。
function resolveDate(month, day, referenceDateStr) {
  const [refYear, refMonth] = referenceDateStr.split('-').map(Number);
  let year = refYear;
  if (refMonth === 12 && month === 1) year += 1;
  else if (refMonth === 1 && month === 12) year -= 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// 「赤ムツ(600g) 2本」のような品目行を、品目名／規格 or 産地／数量／単位に分解する。
// 括弧の中身がORIGIN_NAMES（都道府県等）に含まれていれば産地、そうでなければ規格（サイズ）として扱う
// （shippingList.jsのsplitOriginFromNameと同じ考え方）。
function parseItemNameLine(rawLine) {
  let s = rawLine.replace(/[　]/g, ' ').trim();

  let quantity = null;
  let quantity_unit = '';
  const qm = s.match(/^(.*?)\s*[×x]?\s*(\d+(?:\.\d+)?)\s*(本|尾|杯|枚|個|箱|束|ケ|ヶ|pc)\s*$/i);
  if (qm) {
    s = qm[1].trim();
    quantity = parseFloat(qm[2]);
    quantity_unit = /^pc$/i.test(qm[3]) ? 'pc' : qm[3].replace('ケ', 'ヶ');
  }

  let origin = '';
  let spec = '';
  const pm = s.match(/[（(]([^)）]+)[)）]/);
  if (pm) {
    const inside = pm[1].trim();
    const cleaned = (s.slice(0, pm.index) + s.slice(pm.index + pm[0].length)).replace(/\s+/g, ' ').trim();
    if (ORIGIN_NAMES.some((p) => inside.includes(p))) origin = inside;
    else spec = inside;
    s = cleaned;
  }

  return { item_name: s.trim(), origin, spec, quantity, quantity_unit };
}

// rawText: LINEからコピーした出荷実績データの生テキスト（複数件貼り付け可）
// referenceDateStr: アプリで選択されている日付('YYYY-MM-DD')。M/D表記の年を補うのに使う。
export function parseLineShipmentText(rawText, referenceDateStr) {
  const lines = rawText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const destinations = [];
  const warnings = [];
  let dest = null;
  let lastItem = null;

  const newDest = () => ({
    destinationName: '',
    awaitingDestinationLine: false,
    awaitingShipDate: false,
    awaitingDeliveryDate: false,
    shipDate: null,
    deliveryDate: null,
    deliveryNote: '',
    category: 'ground',
    methodRaw: '',
    items: [],
  });

  const flushDest = () => {
    if (dest) {
      if (!dest.destinationName) warnings.push('納品先（「→」の次の行）が見つからないブロックがありました（スキップ）');
      else if (dest.items.length === 0) warnings.push(`${dest.destinationName}: 品目が見つかりませんでした`);
      else destinations.push(dest);
    }
    dest = null;
    lastItem = null;
  };

  for (const line of lines) {
    if (line === '👤') {
      flushDest();
      dest = newDest();
      continue;
    }
    if (!dest) {
      dest = newDest();
    }

    let m;
    if (line === '→') { dest.awaitingDestinationLine = true; continue; }
    if (dest.awaitingDestinationLine) {
      dest.destinationName = line;
      dest.awaitingDestinationLine = false;
      continue;
    }

    if (/^🚚\s*発送$/.test(line)) { dest.awaitingShipDate = true; continue; }
    if (dest.awaitingShipDate && (m = line.match(/^(\d{1,2})\/(\d{1,2})$/))) {
      dest.shipDate = resolveDate(parseInt(m[1], 10), parseInt(m[2], 10), referenceDateStr);
      dest.awaitingShipDate = false;
      continue;
    }
    if (/^📦\s*納品$/.test(line)) { dest.awaitingDeliveryDate = true; continue; }
    if (dest.awaitingDeliveryDate && (m = line.match(/^(\d{1,2})\/(\d{1,2})(.*)$/))) {
      dest.deliveryDate = resolveDate(parseInt(m[1], 10), parseInt(m[2], 10), referenceDateStr);
      dest.deliveryNote = (m[3] || '').trim();
      dest.awaitingDeliveryDate = false;
      continue;
    }
    if (!dest.methodRaw && /^(航空便|宅急便|配達|配送)/.test(line)) {
      dest.methodRaw = line;
      dest.category = classifyCategory(line);
      continue;
    }

    if ((m = line.match(/^仕入\s*¥\s*([\d,]+)(?:\s*\/\s*(\S+))?\s*$/))) {
      if (lastItem) {
        lastItem.actual_unit_price = parseFloat(m[1].replace(/,/g, ''));
        lastItem.actual_unit_price_unit = m[2] || '';
      } else {
        warnings.push(`「${line}」の対象の品目が見つかりませんでした`);
      }
      continue;
    }
    if ((m = line.match(/^(\d+(?:\.\d+)?)\s*(㎏|kg)\s*$/i))) {
      if (lastItem) {
        lastItem.actual_weight = parseFloat(m[1]);
        lastItem.actual_weight_unit = 'kg';
      } else {
        warnings.push(`「${line}」の対象の品目が見つかりませんでした`);
      }
      continue;
    }
    if ((m = line.match(/^(\d+(?:\.\d+)?)$/))) {
      if (lastItem && lastItem.quantity == null) {
        lastItem.quantity = parseFloat(m[1]);
      } else {
        warnings.push(`数量らしき行「${line}」の対象の品目が見つかりませんでした`);
      }
      continue;
    }

    if (dest.destinationName && dest.methodRaw) {
      const parsed = parseItemNameLine(line);
      lastItem = { ...parsed, actual_weight: null, actual_weight_unit: 'kg', actual_unit_price: null, actual_unit_price_unit: '', raw: line };
      dest.items.push(lastItem);
      continue;
    }
  }
  flushDest();

  return { destinations, warnings };
}

// order_lines への insert 用の行データに変換する。
// orderDate: アプリで選択されている日付('YYYY-MM-DD')。order_linesのorder_dateに使う
//   （このアプリは常に「今日」を対象にする運用のため）。
export function buildOrderLineRows(destinations, orderDate) {
  const rows = [];
  destinations.forEach((d) => {
    d.items.forEach((it) => {
      rows.push({
        order_date: orderDate,
        destination: d.destinationName,
        delivery_category: d.category,
        delivery_date: d.deliveryDate,
        delivery_time_note: d.deliveryNote,
        ship_date: d.shipDate,
        item_name: it.item_name,
        origin: it.origin || '',
        spec: it.spec || '',
        quantity: it.quantity,
        quantity_unit: it.quantity_unit || '',
        actual_weight: it.actual_weight,
        actual_weight_unit: it.actual_weight_unit || 'kg',
        actual_unit_price: it.actual_unit_price,
        actual_unit_price_unit: it.actual_unit_price_unit || '',
        raw_line: it.raw,
      });
    });
  });
  return rows;
}
