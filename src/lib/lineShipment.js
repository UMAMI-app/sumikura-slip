// LINE発注システムからコピーした「出荷実績データ」を読み込む処理。
//
// 発注一覧（src/lib/shippingList.js）が読み込む「発送リスト」形式（発送作業の事前チェックリスト用、
// まだ実際の目方・仕入価格が分からない段階のもの）とは別の、もう一つの入力経路。
// こちらはLINEの発注システム上にすでに表示されている「実際の」出荷データ
// （実重量・仕入価格を含む）を貼り付けて、原稿突合・価格チェック・納品書作成に使う
// （改修指示書「魚屋原稿・LINE注文・納品書・売上管理アプリ 改修指示書」17〜20章参照）。
//
// フォーマットの前提（1件のブロックは👤で始まる。各項目の間に空行が挟まることが多いため、
// 空行は読み飛ばして意味のある行だけを順番に処理する。18章: 単純な「1行=1データ」方式は禁止で、
// 状態を持ってブロック単位で解析する）:
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
//   1.13㎏                   … 実重量
//   仕入 ¥13,000             … 仕入価格（単位が書かれていないことが多い。勝手にkgと決めつけない）
//   送料                     … 品目名だけの行（数量は次の行に来ることがある）
//   1                       … 直前の品目(送料)の数量
//
// 「仕入 ¥○○」の後に単位が明記されていない場合、purchase_price_unit は空文字のままにする
// （空欄なら原稿の単価単位を基準に金額計算する。単位が判断できない場合はユーザーに選ばせる。20章）。
// 「㎏」だけの行（数値が無い）は実重量が未入力という意味であり、0にしてはいけない（19章）。
// また「㎏」という文字があることだけを理由に単価単位をkgと決めつけてもいけない（19章）。
// 仕入価格が無い商品があるのは正常であり、エラーにしない（20章）。
// 今後実データでフォーマットのズレが見つかった場合は、このファイルの正規表現を調整すればよい。

import { ORIGIN_NAMES } from './manuscriptKadokura.js';
import { guessPurchasePriceUnit } from './priceUnitGuess.js';

const CATEGORY_MAP = [
  { re: /航空便/, category: 'air' },
  { re: /宅急便/, category: 'takkyu' },
  { re: /配達|配送/, category: 'ground' },
];

// 2026-09-23 追加変更（kento指示）: 「仕入 ¥○○」の次に来る行は、基本的に必ず直前の品目の
// 「要望」欄である（新しい品目名にはならない）。ただし数量・規格がその行に書かれている場合は
// それも拾う（例:「800g × 1本　⚠️水洗い」）。
// 一方で、⚠️マークも数量も無い単独行（例:「水洗い」）は、新しい品目名なのか要望メモなのか
// 記号だけでは判別できないため、実際によく出てくる処理メモ用語をリスト化し、これに一致する
// 場合だけ要望として扱う（リストに無い言葉は今まで通り新しい品目名として扱われる＝安全側）。
const NOTE_KEYWORDS = [
  '水洗い', '腹出し', '腹抜き', '鱗とり', '鱗かき', 'すき引き', '内臓処理', '処理なし',
];
function isNoteLine(line) {
  return line.includes('⚠️') || NOTE_KEYWORDS.some((k) => line.includes(k));
}

// 2026-09-23 追加変更（kento指示）: 「👤」ブロックの見出し部分（発注者名・ステータス・発注元）を
// 品目として誤登録しないための、位置＋内容の二重チェック。
// 位置ベース: 「👤」の直後に来る行は内容を問わず必ず発注者名なので読み飛ばす（awaitingOrderer）。
// 内容ベース: 発注元（魚屋）名・ステータスは既知の値をリスト化し、念のためどの位置でも
// （destinationNameが確定するまでの間は）該当すれば読み飛ばす、という二段構えにする。
const KNOWN_ORDERER_NAMES = ['浦島一樹', '後藤聖和', '見富剛', '奥秋勝也', '岡本研人', '森岡十夢', '旨味フーズ'];
const KNOWN_SUPPLIER_NAMES = ['角倉商店'];
const KNOWN_STATUS_VALUES = ['未確定'];
function isKnownHeaderLine(line) {
  return KNOWN_ORDERER_NAMES.includes(line) || KNOWN_SUPPLIER_NAMES.includes(line) || KNOWN_STATUS_VALUES.includes(line);
}

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
  const qm = s.match(/^(.*?)\s*[×x]?\s*(\d+(?:\.\d+)?)\s*(本|尾|杯|枚|個|箱|束|ケ|ヶ|パック|腹|匹|pc)\s*$/i);
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

  // 括弧が無く、スペース区切りで末尾のトークンが数字始まり（例:「100gサイズ」）の場合は
  // 規格として切り出す（既に規格が確定している場合は上書きしない）。
  if (!spec && s.includes(' ')) {
    const idx = s.lastIndexOf(' ');
    const last = s.slice(idx + 1).trim();
    const head = s.slice(0, idx).trim();
    if (head && /^[0-9０-９]/.test(last)) {
      spec = last;
      s = head;
    }
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
    awaitingOrderer: false,
    awaitingDestinationLine: false,
    awaitingShipDate: false,
    awaitingDeliveryDate: false,
    awaitingMethod: false,
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
      dest.awaitingOrderer = true; // 「👤」を実際に見たときだけ、次の1行を発注者として読み飛ばす
      continue;
    }
    if (!dest) {
      // 👤で始まっていないテキストが貼られた場合のフォールバック：先頭から1件として扱う
      dest = newDest();
    }

    let m;
    // 「👤」の直後の1行は、内容を問わず必ず発注者名（位置で確定・kento確認済み）。
    if (dest.awaitingOrderer) { dest.awaitingOrderer = false; continue; }
    // 発注元（魚屋）名・ステータスは既知の値なら、まだ納品先が確定していない間は読み飛ばす
    // （内容ベースの二重チェック。位置ベースの読み飛ばしと合わせて、念のため二重に防ぐ）。
    if (!dest.destinationName && isKnownHeaderLine(line)) { continue; }
    if (line === '→') { dest.awaitingDestinationLine = true; continue; }
    if (dest.awaitingDestinationLine) {
      dest.destinationName = line;
      dest.awaitingDestinationLine = false;
      continue;
    }

    // 「📦 納品あ」のように絵文字直後に余計な文字が付くことがあるため、前方一致で判定する。
    if (/^🚚\s*発送/.test(line)) { dest.awaitingShipDate = true; continue; }
    if (dest.awaitingShipDate && (m = line.match(/^(\d{1,2})\/(\d{1,2})$/))) {
      dest.shipDate = resolveDate(parseInt(m[1], 10), parseInt(m[2], 10), referenceDateStr);
      dest.awaitingShipDate = false;
      continue;
    }
    if (/^📦\s*納品/.test(line)) { dest.awaitingDeliveryDate = true; continue; }
    if (dest.awaitingDeliveryDate && (m = line.match(/^(\d{1,2})\/(\d{1,2})(.*)$/))) {
      dest.deliveryDate = resolveDate(parseInt(m[1], 10), parseInt(m[2], 10), referenceDateStr);
      dest.deliveryNote = (m[3] || '').trim();
      dest.awaitingDeliveryDate = false;
      dest.awaitingMethod = true;
      continue;
    }
    // 配送方法は「航空便」「宅急便」等の決め打ちキーワードに頼らず、納品日の次に来る行を
    // そのまま配送方法として受け取る（「その他」「自社配送🚚」等、未知の表記でも取りこぼさない）。
    if (dest.awaitingMethod) {
      dest.methodRaw = line;
      dest.category = classifyCategory(line);
      dest.awaitingMethod = false;
      continue;
    }

    // 「仕入 ¥13,000」「仕入 ¥13,000/kg」
    if ((m = line.match(/^仕入\s*[¥￥]\s*([\d,]+)(?:\s*\/\s*(\S+))?\s*$/))) {
      if (lastItem) {
        lastItem.purchase_price = parseFloat(m[1].replace(/,/g, ''));
        lastItem.purchase_price_unit = m[2] || '';
      } else {
        warnings.push(`「${line}」の対象の品目が見つかりませんでした`);
      }
      continue;
    }
    // 「売値 ¥5,200」: LINE実績データ側には基本的に登場しない想定だが、貼り付けられた場合に
    // 新しい品目として誤認識されないよう、備考として保持するだけにする（納品書には使わない）。
    if ((m = line.match(/^売値\s*[¥￥]\s*([\d,]+)\s*$/))) {
      if (lastItem) {
        lastItem.note = lastItem.note ? `${lastItem.note} / ${line}` : line;
      } else {
        warnings.push(`「${line}」の対象の品目が見つかりませんでした`);
      }
      continue;
    }
    // 「1.13㎏」「0.58kg」
    if ((m = line.match(/^(\d+(?:\.\d+)?)\s*(㎏|kg)\s*$/i))) {
      if (lastItem) {
        lastItem.actual_weight = parseFloat(m[1]);
        lastItem.actual_weight_unit = 'kg';
      } else {
        warnings.push(`「${line}」の対象の品目が見つかりませんでした`);
      }
      continue;
    }
    // 「㎏」だけの行（数値なし）＝実重量が未入力という意味。0にはせず、nullのまま何もしない（19章）。
    if (/^(㎏|kg)\s*$/i.test(line)) {
      if (!lastItem) warnings.push(`「${line}」の対象の品目が見つかりませんでした`);
      continue;
    }
    // 2026-09-23 追加変更（kento指示）: ⚠️マーク付き、または処理メモ用語（NOTE_KEYWORDS）に
    // 一致する行は、新しい品目名にはせず直前の品目の「要望」として扱う。
    // 「800g × 1本　⚠️水洗い」のように数量・規格が同じ行に混じっていることもあるため、
    // 先に数量+規格部分だけ抜き出し、残りのテキスト（⚠️マークを除く）を要望として保持する。
    if (isNoteLine(line)) {
      if (lastItem) {
        const qm = line.match(/^(.+?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*(本|尾|杯|枚|個|箱|束|ケ|ヶ|パック|腹|匹|pc)/i);
        let noteText = line;
        if (qm) {
          if (!lastItem.spec) lastItem.spec = qm[1].trim();
          if (lastItem.quantity == null) {
            lastItem.quantity = parseFloat(qm[2]);
            lastItem.quantity_unit = /^pc$/i.test(qm[3]) ? 'pc' : qm[3].replace('ケ', 'ヶ');
          }
          noteText = line.slice(qm[0].length).trim();
        }
        noteText = noteText.replace(/⚠️/g, '').trim();
        if (noteText) lastItem.note = lastItem.note ? `${lastItem.note} / ${noteText}` : noteText;
      } else {
        warnings.push(`「${line}」の対象の品目が見つかりませんでした`);
      }
      continue;
    }
    // 「800g × 1本」のように、規格＋数量が品目名行の次の行に分かれて来ることがある（20章の例）。
    if ((m = line.match(/^(.+?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*(本|尾|杯|枚|個|箱|束|ケ|ヶ|パック|腹|匹|pc)\s*$/i))) {
      if (lastItem) {
        if (!lastItem.spec) lastItem.spec = m[1].trim();
        if (lastItem.quantity == null) {
          lastItem.quantity = parseFloat(m[2]);
          lastItem.quantity_unit = /^pc$/i.test(m[3]) ? 'pc' : m[3].replace('ケ', 'ヶ');
        }
      } else {
        warnings.push(`「${line}」の対象の品目が見つかりませんでした`);
      }
      continue;
    }
    // 数量+単位だけの行（品目名行に数量が付いていなかった場合の継続行）
    if ((m = line.match(/^(\d+(?:\.\d+)?)\s*(本|尾|杯|枚|個|箱|束|ケ|ヶ|パック|腹|匹|pc)$/i))) {
      if (lastItem && lastItem.quantity == null) {
        lastItem.quantity = parseFloat(m[1]);
        lastItem.quantity_unit = /^pc$/i.test(m[2]) ? 'pc' : m[2].replace('ケ', 'ヶ');
      } else if (!lastItem) {
        warnings.push(`「${line}」の対象の品目が見つかりませんでした`);
      }
      continue;
    }
    // 数量だけの行（例:「送料」の次に来る「1」）
    if ((m = line.match(/^(\d+(?:\.\d+)?)$/))) {
      if (lastItem && lastItem.quantity == null) {
        lastItem.quantity = parseFloat(m[1]);
      } else {
        warnings.push(`数量らしき行「${line}」の対象の品目が見つかりませんでした`);
      }
      continue;
    }

    if (dest.destinationName && dest.methodRaw) {
      // ここまでの見出し情報が揃っていれば、以降は品目行として扱う
      const parsed = parseItemNameLine(line);
      // 仕入価格が無い商品があるのは正常（20章）。purchase_priceはnullのまま保持する。
      lastItem = { ...parsed, actual_weight: null, actual_weight_unit: '', purchase_price: null, purchase_price_unit: '', note: '', raw: line };
      dest.items.push(lastItem);
      continue;
    }
    // それ以外（発注者名・ステータス・発注元名など、まだ見出し情報が揃う前の行）は読み飛ばす
  }
  flushDest();

  return { destinations, warnings };
}

// line_actual_items への insert 用の行データに変換する。
// orderDate: アプリで選択されている日付('YYYY-MM-DD')。line_actual_itemsのorder_dateに使う。
// defaultUnitMap: { [item_name]: default_unit } 商品ごとに学習済みの単価単位（無ければ{}でよい）。
// 仕入価格の単位が原文に明記されていない場合、ここで初期値を埋める
// （ウニ→枚、サンマ→本 等の既知パターン→学習済み単位→それも無ければkgの優先順位。
// priceUnitGuess.js参照。ユーザーが確認画面で修正できることが前提）。
export function buildLineActualRows(destinations, orderDate, defaultUnitMap = {}) {
  const rows = [];
  destinations.forEach((d) => {
    // 送料は納品書には記載しないため、当面は品目としても取り込まない（一旦除外。復活する場合はここを外す）。
    d.items.filter((it) => !/^送料/.test(it.item_name || '')).forEach((it) => {
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
        actual_weight_unit: it.actual_weight_unit || (it.actual_weight != null ? 'kg' : ''),
        purchase_price: it.purchase_price,
        purchase_price_unit: it.purchase_price_unit || (/^送料/.test(it.item_name || '') ? '' : guessPurchasePriceUnit(it.item_name, defaultUnitMap[it.item_name])),
        note: it.note || '',
        raw_line: it.raw,
      });
    });
  });
  return rows;
}
