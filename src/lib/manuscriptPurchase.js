// 魚屋原稿（ブロック形式）パーサー。
//
// 「価格チェック」タブに直接貼り付ける原稿専用の新しい入力経路。
// 既存の「原稿読み込み」タブ（manuscriptKadokura.js / 角倉タブ形式・「・品目名」の箇条書き）
// とはフォーマットが全く別物のため、あちらのロジックには一切手を入れず、
// 完全に独立した新しいパーサーとして実装する
// （改修指示書「魚屋原稿・LINE注文・納品書・売上管理アプリ 改修指示書」1〜16章参照）。
//
// 前提フォーマット（1商品 = 1ブロック。空行で区切られるが、「送料」行は空行が無くても
// 常に新しいブロックの開始として扱う。改修指示書3章・15〜16章）:
//
//   サワラ半身
//   1.45㎏
//   仕入 ¥3,600
//   売値 ¥5,200
//
//   淡路ハモ(600g) 1本
//   0.58㎏
//   仕入 ¥3,700
//
//   送料(箱代含む)
//   1
//   仕入 ¥2,200
//
// 単価単位（purchase_price_unit）は原稿に明記されていないことが多いため、
// 「実重量があればkg単価、無ければ数量単位（本/個/枚 等）」を原則としつつ
// （改修指示書4〜5章）、それでも判断できない場合は商品ごとに学習済みの単位
// （product_price_units、6章）があればそれを使う。いずれにせよユーザーが
// 確認画面で修正できることが前提（28章）。

import { ORIGIN_NAMES } from './manuscriptKadokura.js';

const QTY_UNIT_RE = '本|尾|杯|枚|個|箱|束|ケ|ヶ|パック|pc';

function normalizeUnit(u) {
  if (!u) return '';
  if (/^pc$/i.test(u)) return 'pc';
  return u.replace(/ケ/g, 'ヶ');
}

// 品目名の行を、品目名／産地or規格／数量／数量単位に分解する。
// 例:「淡路ハモ(600g) 1本」「ビワマス　3本」「ハマグリ 100gサイズ　16個」「サワラ半身」
export function parseItemNameLine(rawLine) {
  let s = rawLine.replace(/[　]/g, ' ').trim();

  let quantity = null;
  let quantity_unit = '';
  const qm = s.match(new RegExp('^(.*?)\\s*[×x]?\\s*(\\d+(?:\\.\\d+)?)\\s*(' + QTY_UNIT_RE + ')\\s*$', 'i'));
  if (qm) {
    s = qm[1].trim();
    quantity = parseFloat(qm[2]);
    quantity_unit = normalizeUnit(qm[3]);
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

function isShippingLine(line) {
  return line === '送料' || /^送料/.test(line);
}

// rawText: 貼り付けられた原稿の生テキスト
// defaultUnitMap: { [item_name]: default_unit } 商品ごとに学習済みの単価単位（無ければ{}でよい）
export function parseManuscriptPurchaseText(rawText, defaultUnitMap = {}) {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());

  const blocks = [];
  let current = null;
  const flush = () => {
    if (current && current.lines.length > 0) blocks.push(current);
    current = null;
  };

  for (const line of lines) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (isShippingLine(line)) {
      flush();
      current = { isShipping: true, lines: [line] };
      continue;
    }
    if (!current) {
      current = { isShipping: false, lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  flush();

  const items = [];
  const warnings = [];

  blocks.forEach((block) => {
    if (block.isShipping) {
      items.push(parseShippingBlock(block.lines));
      return;
    }
    const item = parseItemBlock(block.lines, defaultUnitMap);
    if (!item) {
      warnings.push(`解析できないブロックがありました: ${block.lines.join(' / ')}`);
      return;
    }
    items.push(item);
  });

  return { items, warnings };
}

function parseShippingBlock(lines) {
  const nameLine = lines[0];
  const noteMatch = nameLine.match(/[（(]([^)）]+)[)）]/);
  const shipping_note = noteMatch ? noteMatch[1].trim() : '';
  let shipping_fee = null;
  for (const line of lines.slice(1)) {
    const m = line.match(/^仕入\s*[¥￥]\s*([\d,]+)/);
    if (m) shipping_fee = parseFloat(m[1].replace(/,/g, ''));
  }
  return {
    kind: 'shipping',
    shipping_note,
    shipping_fee, // 金額が書かれていないブロックもあるため、無ければnullのまま保持する（16章）
    raw_line: lines.join(' / '),
  };
}

function parseItemBlock(lines, defaultUnitMap) {
  const nameInfo = parseItemNameLine(lines[0]);
  let quantity = nameInfo.quantity;
  let quantity_unit = nameInfo.quantity_unit;
  let actual_weight = null;
  let purchase_price = null;
  let purchase_price_unit = '';
  let selling_price = null;
  let selling_price_source = null;

  for (const line of lines.slice(1)) {
    let m;
    if ((m = line.match(/^(\d+(?:\.\d+)?)\s*(㎏|kg)$/i))) {
      actual_weight = parseFloat(m[1]);
      continue;
    }
    if (/^(㎏|kg)$/i.test(line)) {
      // 実重量欄はあるが数値が入っていない → nullのまま（0にしない。19章と同じ考え方）
      continue;
    }
    if ((m = line.match(/^仕入\s*[¥￥]\s*([\d,]+)(?:\s*\/\s*(\S+))?$/))) {
      purchase_price = parseFloat(m[1].replace(/,/g, ''));
      if (m[2]) purchase_price_unit = normalizeUnit(m[2]);
      continue;
    }
    if ((m = line.match(/^売値\s*[¥￥]\s*([\d,]+)$/))) {
      selling_price = parseFloat(m[1].replace(/,/g, ''));
      selling_price_source = 'original'; // 原稿に売値の記載あり → 自動計算せず原稿値を優先（11〜12章）
      continue;
    }
    if ((m = line.match(new RegExp('^(\\d+(?:\\.\\d+)?)\\s*(' + QTY_UNIT_RE + ')$', 'i')))) {
      if (quantity == null) {
        quantity = parseFloat(m[1]);
        quantity_unit = normalizeUnit(m[2]);
      }
      continue;
    }
    // それ以外の行（想定外の備考等）は解析対象外として無視する
  }

  // 単価単位が原稿に明記されていない場合の推測（4〜6章）。
  // 実重量があれば原則kg単価。実重量が無ければ数量単位（本/個/枚 等）を単価単位とみなす。
  // それも無ければ、商品ごとに学習済みの単位があればそれを使う（勝手な決め打きはしない）。
  if (!purchase_price_unit) {
    if (actual_weight != null) purchase_price_unit = 'kg';
    else if (quantity_unit) purchase_price_unit = quantity_unit;
    else if (defaultUnitMap[nameInfo.item_name]) purchase_price_unit = defaultUnitMap[nameInfo.item_name];
  }

  // 仕入金額（9〜10章）: kg単価なら単価×実重量、それ以外は単価×数量。
  let purchase_amount = null;
  if (purchase_price != null) {
    if (purchase_price_unit === 'kg' && actual_weight != null) purchase_amount = round2(purchase_price * actual_weight);
    else if (purchase_price_unit && purchase_price_unit !== 'kg' && quantity != null) purchase_amount = round2(purchase_price * quantity);
  }

  // 売値が原稿に無い場合のみ自動計算する（8章・11章）。
  if (selling_price == null && purchase_amount != null) {
    selling_price = calcAutoSellingPrice(purchase_amount);
    selling_price_source = 'calculated';
  }

  return {
    kind: 'item',
    item_name: nameInfo.item_name,
    origin: nameInfo.origin,
    spec: nameInfo.spec,
    quantity,
    quantity_unit,
    actual_weight,
    actual_weight_unit: actual_weight != null ? 'kg' : '',
    purchase_price,
    purchase_price_unit,
    purchase_amount,
    selling_price,
    selling_price_unit: purchase_price_unit,
    selling_price_source,
    note: '',
    raw_line: lines.join(' / '),
  };
}

// 売値自動計算（8〜10章）: 仕入金額が1万円未満なら1.15倍、1万円以上なら1.10倍。
// 端数処理のルールは未確定のため、円単位で四捨五入するに留める（画面上で必ず編集可能にすること）。
function round2(n) {
  return Math.round(n * 100) / 100;
}

export function calcAutoSellingPrice(purchaseAmount) {
  if (purchaseAmount == null || Number.isNaN(purchaseAmount)) return null;
  const rate = purchaseAmount < 10000 ? 1.15 : 1.10;
  return Math.round(purchaseAmount * rate);
}
