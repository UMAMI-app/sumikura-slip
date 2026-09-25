// 原稿読み込み処理（角倉タブ向け）
//
// 既存アプリ「案内生成アプリ」(UMAMI-app/info-generate, upload.html) には
// 磯崎・角倉・イチマル・荒木鮮魚の4つのタブがあり、それぞれ全く別の解析ロジックを持つ。
// このアプリで使う原稿は「角倉」タブのものだけなので、角倉タブの解析ロジック（Kdk IIFE）を
// 調査のうえ移植した。磯崎・イチマル・荒木鮮魚は対象外（既存アプリのファイルは変更していない）。
//
// 移植（ほぼそのまま再利用）した部分:
//   - ORIGIN_NAMES（都道府県+主要輸入国のリスト）/ normalizePref
//   - extractNameAndOrigin（品目名に直接くっついた産地表記を分離する）
//   - parseOriginLine（品目名とは別行になっている産地行を解析する）
//   - normalizeName（表記ゆれの正規化）
//   - groupLines（「・品目名」で始まる行を新しい品目の区切りとして、原稿の生テキストを
//     品目ブロックに分割する）とその内部で使うformatArrowNote
//   - resolveNameOrigin（品目名側の産地情報と、別行の産地情報をマージする）
//
// 新規に実装した部分:
//   - parseVariantLineRaw: 既存アプリのparseVariantLineから「価格ルールによる掛け率計算
//     (calcPrice)」を取り除き、原稿に書かれた生の単価をそのまま返すようにしたもの
//     （このアプリでは案内文向けの掛け率計算ではなく、原稿単価と実納品単価をそのまま
//     比較したいため）。単価単位（kg/枚/尾/個/杯 等）の推測もここで行う。
//   - extractKadokuraManuscriptItems: groupLines+resolveNameOrigin+parseVariantLineRawを
//     組み合わせて、この発注・納品管理アプリ向けの「品目/産地/規格/単価/単価単位」を
//     抽出する。由良ウニ・丸ウニ(◎)・宮津トリ貝など、通常のvariants配列を使わない
//     特殊フォーマットの品目は自動抽出の対象外とし、要確認としてリストに出す
//     （既存アプリ側もこれらは専用の組み立て関数を持つほど特殊な書式のため）。

import { inferPriceUnit } from './manuscript.js';
import { guessPurchasePriceUnit } from './priceUnitGuess.js';

// ---- 産地（既存アプリ Kdk より移植） ----
const PREFS = ['北海道','青森','岩手','宮城','秋田','山形','福島','茨城','栃木','群馬','埼玉','千葉','東京','神奈川',
  '新潟','富山','石川','福井','山梨','長野','岐阜','静岡','愛知','三重','滋賀','京都','大阪','兵庫','奈良','和歌山',
  '鳥取','島根','岡山','広島','山口','徳島','香川','愛媛','高知','福岡','佐賀','長崎','熊本','大分','宮崎','鹿児島','沖縄'];
const FOREIGN = ['韓国','中国','ノルウェー','ロシア','ベトナム','チリ','アメリカ','台湾'];
export const ORIGIN_NAMES = [...PREFS, ...FOREIGN];

function normalizePref(pref) {
  return pref;
}

export function extractNameAndOrigin(rawName) {
  let s = rawName.trim();
  let bestIdx = -1, bestPref = '';
  for (const p of ORIGIN_NAMES) {
    const idx = s.indexOf(p);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) { bestIdx = idx; bestPref = p; }
  }
  if (bestIdx === -1) return { itemName: s, originDisplay: '', trailingNote: '', pref: '' };

  let left = s.slice(0, bestIdx).trim();
  let matchEnd = bestIdx + bestPref.length;
  if (/^[都道府県]/.test(s.slice(matchEnd)) && !bestPref.endsWith(s[matchEnd])) matchEnd += 1;
  let rightFull = s.slice(matchEnd);
  let right = rightFull.trim();
  const hadSpaceBeforeRight = /^\s/.test(rightFull);

  let leftMerge = '';
  const leftParenMatch = left.match(/^(.*?)[（(]([^)）]+)[)）]\s*$/);
  if (leftParenMatch) {
    left = leftParenMatch[1].trim();
    leftMerge = leftParenMatch[2].trim();
  }
  const itemName = leftMerge ? `${left}・${leftMerge}` : left;

  let place = '';
  let trailingNote = '';
  if (!hadSpaceBeforeRight) {
    let m;
    while ((m = right.match(/^[（(]([^)）]+)[)）]/))) {
      place = place ? `${place}・${m[1].trim()}` : m[1].trim();
      right = right.slice(m[0].length).trim();
    }
  }
  if (!place) {
    const noteMatch = right.match(/^[（(]([^)）]+)[)）]$/);
    if (noteMatch) {
      trailingNote = noteMatch[1].trim();
      right = '';
    } else {
      place = right.replace(/[,、]/g, '').trim();
    }
  }
  const pref = normalizePref(bestPref);
  const originDisplay = place ? `(${pref}・${place})` : `(${pref})`;
  return { itemName, originDisplay, trailingNote, pref };
}

export function parseOriginLine(originLine) {
  let s = (originLine || '').trim();
  const wholeWrap = s.match(/^[（(](.+)[)）]$/);
  if (wholeWrap) s = wholeWrap[1].trim();

  let bestIdx = -1, bestPref = '';
  for (const p of ORIGIN_NAMES) {
    const idx = s.indexOf(p);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) { bestIdx = idx; bestPref = p; }
  }
  if (bestIdx === -1) return { originDisplay: '', trailingNote: '', pref: '' };

  const pref = normalizePref(bestPref);
  let matchEnd = bestIdx + bestPref.length;
  if (/^[都道府県]/.test(s.slice(matchEnd)) && !bestPref.endsWith(s[matchEnd])) matchEnd += 1;
  let rest = s.slice(matchEnd).trim();
  rest = rest.replace(/^[,、]\s*/, '');

  let place = '', trailingNote = '';
  const trailParen = rest.match(/^(.*?)[（(]([^)）]+)[)）]\s*$/);
  if (trailParen && trailParen[1].trim()) {
    place = trailParen[1].trim();
    trailingNote = trailParen[2].trim();
  } else if (rest.includes(' ')) {
    const idx = rest.indexOf(' ');
    place = rest.slice(0, idx).trim();
    trailingNote = rest.slice(idx + 1).trim();
  } else {
    place = rest;
  }
  const originDisplay = place ? `(${pref}・${place})` : `(${pref})`;
  return { originDisplay, trailingNote, pref };
}

export function normalizeName(name) {
  return name
    .replace(/活天タイ/g, '活天然タイ')
    .replace(/天ヒラメ/g, '天然ヒラメ');
}

function formatArrowNote(text) {
  let t = text.replace(/有り/g, 'あり');
  if (/釣/.test(t) && !/🎣/.test(t)) {
    t = t.replace(/釣物?/, (m) => `${m}🎣`);
  }
  if (/脂/.test(t) && !/👌/.test(t)) {
    t = t.replace(/[！!]+$/, '').trimEnd() + '👌';
  }
  return t;
}

// ---- 行のグルーピング（既存アプリ Kdk.groupLines より移植） ----
export function groupLines(rawText) {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const groups = [];
  let current = null;
  let inKakouhin = false;

  function startGroup(name) {
    if (current) groups.push(current);
    current = { name, originLine: null, variants: [], notes: [], asaJimeMarker: false, subVariants: null, forcedCategory: inKakouhin ? '加工品' : null };
  }

  function pushLine(line) {
    if (line === '兵庫淡路島') { inKakouhin = true; return; }

    if (current && current.subVariants && /^[・･]?玉\/代金/.test(line)) {
      const mm = line.match(/([\d,]+)\s*$/);
      if (mm) current.subVariants[current.subVariants.length - 1].price = parseInt(mm[1].replace(/,/g, ''), 10);
      return;
    }

    if (current && current.variants.length > 0 && /^[・･]?㌔/.test(line)) {
      current.variants[current.variants.length - 1].priceLine = line.replace(/^[・･]/, '');
      return;
    }

    if (current && current.isMaruUni && /^[・･][＠@]/.test(line)) {
      const pm = line.match(/([\d,]+)/);
      if (pm) current.maruUniPrice = parseInt(pm[1].replace(/,/g, ''), 10);
      current.maruUniHasYen = /円/.test(line);
      return;
    }

    if (line.startsWith('・') || line.startsWith('･')) {
      startGroup(line.slice(1));
      return;
    }
    if (line.startsWith('宮津')) {
      startGroup(line);
      current.isMiyazu = true;
      return;
    }
    if (line.startsWith('🌟')) {
      startGroup(line);
      return;
    }
    if (line.startsWith('◎')) {
      const svm = line.match(/^◎(\S+?)-(.+)$/);
      if (current && current.isMiyazu && svm) {
        if (!current.subVariants) current.subVariants = [];
        current.subVariants.push({ label: svm[1], size: svm[2], price: null });
        return;
      }
      startGroup(line.slice(1));
      current.isMaruUni = true;
      return;
    }
    if (!current) return;

    if (line.startsWith('↑')) {
      if (line.includes('朝締め') || line.includes('朝〆')) {
        current.asaJimeMarker = true;
      } else if (current.variants.length > 0) {
        current.variants[current.variants.length - 1].arrowNote = formatArrowNote('→' + line.slice(1));
      }
      return;
    }
    if (line.startsWith('※')) { current.notes.push(line); return; }

    if (line.startsWith('→') && current.variants.length > 0) {
      current.variants[current.variants.length - 1].arrowNote = formatArrowNote(line);
      return;
    }

    // 2026-09-25 追加（kento指示）: 「（極大粒）」「(大粒)」のような等級の見出し行は、直前の規格の
    // 補足ではなく「次に来る規格行」の見出しなので、次の規格行にくっつける。
    const gradeM = line.match(/^[（(]([^)）]*)[)）]$/);
    if (gradeM && /粒|極大|特大|^大$|^中$|^小$/.test(gradeM[1].trim())) {
      current.pendingLabel = gradeM[1].trim();
      return;
    }

    if (/^[（(][^)）]*[)）]$/.test(line) && !/^\(SP\)$|^\(上\)$/.test(line) && current.variants.length > 0) {
      current.variants[current.variants.length - 1].extraNote = line.replace(/[()（）]/g, '');
      return;
    }

    if (/^\d+枚(入荷|あり)?$/.test(line) && current.variants.length > 0) {
      current.variants[current.variants.length - 1].qtyNote = line;
      return;
    }

    if (!current.isMaruUni && current.variants.length === 0 && current.originLine === null && current.subVariants === null && !/\d/.test(line)) {
      current.originLine = line;
      return;
    }

    current.variants.push({ raw: line, qty: null, extraNote: null, label: current.pendingLabel || null });
    current.pendingLabel = null;
  }

  let prevBlank = false;
  for (const line of lines) {
    if (line.length === 0) {
      if (current && current.variants.length > 0) {
        current.variants[current.variants.length - 1].blankAfter = true;
      }
      inKakouhin = false;
      prevBlank = true;
      continue;
    }
    // 2026-09-25 追加（kento指示）: 空行の後に「・」なしで「由良廣田丸 SP 約70g 1枚15,800」のような
    // 品目名＋価格の1行が来た場合は、直前の品目（例: ハモ）の規格ではなく新しい品目として扱う。
    // 判定: 空行の直後／かな・漢字3文字以上で始まる／数字（価格）を含む。
    // 続けて同じ形の1行（「由良廣田丸 並 約60g 1枚13,000」）が来た場合も、それぞれ別の品目にする。
    const looksOneLineItem = /^[\u3040-\u30ff\u4e00-\u9fff々]{3,}/.test(line) && /\d/.test(line);
    if (looksOneLineItem && current && !inKakouhin
      && ((prevBlank && current.variants.length > 0) || current.oneLine)) {
      prevBlank = false;
      startGroup(line);
      current.oneLine = true;
      continue;
    }
    prevBlank = false;
    pushLine(line);
  }
  if (current) groups.push(current);
  return groups;
}

// ---- 品目名側/産地行側の情報をマージする（既存アプリ KdkBuild.resolveNameOrigin より移植） ----
export function resolveNameOrigin(group) {
  if (group.originLine) {
    const fromName = extractNameAndOrigin(group.name);
    const fromOriginLine = parseOriginLine(group.originLine);
    if (fromOriginLine.originDisplay) {
      return { itemName: fromName.itemName, originDisplay: fromOriginLine.originDisplay, trailingNote: fromOriginLine.trailingNote, pref: fromOriginLine.pref, extraLine: null };
    }
    return { itemName: fromName.itemName, originDisplay: fromName.originDisplay, trailingNote: '', pref: fromName.pref, extraLine: group.originLine };
  }
  return { ...extractNameAndOrigin(group.name), extraLine: null };
}

// ---- ここから新規実装 ----

// 既存アプリのparseVariantLineから掛け率計算(calcPrice)を除き、
// 原稿に書かれた生の単価と単価単位をそのまま返すようにしたもの。
export function parseVariantLineRaw(raw) {
  const s = raw.trim();

  // 背/腹の2価格パターン（例:「背k700 腹k800」）→ 2品目として扱う
  let m = s.match(/^(.*?)\s*背k([\d,]+)\s*腹k([\d,]+)\s*(.*)$/);
  if (m) {
    return {
      kind: 'dual',
      sizeText: m[1].trim(),
      parts: [
        { suffix: '(背)', value: parseInt(m[2].replace(/,/g, ''), 10), unit: 'kg' },
        { suffix: '(腹)', value: parseInt(m[3].replace(/,/g, ''), 10), unit: 'kg' },
      ],
      priceOk: true,
    };
  }

  // k/¥プレフィックス価格（例:「1.5kg k12,000」「A ¥900」）
  m = s.match(/^(.*?)\s*([¥￥]|k)\s?([\d,]+)\s*(.*)$/i);
  if (m) {
    const before = m[1].trim();
    const isK = /k/i.test(m[2]);
    const value = parseInt(m[3].replace(/,/g, ''), 10);
    const unit = isK ? 'kg' : (inferPriceUnit('', before, 'yen') || '');
    return { kind: 'single', sizeText: before, value, unit, priceOk: true };
  }

  // ×プレフィックス（既に「1枚×13,500」のように×表記になっている場合）
  m = s.match(/^(.*×\s*)([\d,]+)(.*)$/);
  if (m) {
    const before = m[1].replace(/×\s*$/, '').trim();
    const value = parseInt(m[2].replace(/,/g, ''), 10);
    let unit = inferPriceUnit('', before, 'yen') || '';
    // 「1k×1P ×3,000」のように「×」の手前が「1P」「2枚」等で終わっていれば、それを単価の単位とみなす
    if (!unit) {
      const um = before.match(/\d*\s*(P|パック|枚|個|尾|本|杯)$/i);
      if (um) unit = /^p$/i.test(um[1]) ? 'P' : um[1];
    }
    return { kind: 'single', sizeText: before, value, unit, priceOk: true };
  }

  // 数量単位に数字が直接くっついた価格（例:「1枚14,000」「1尾1,250」）
  m = s.match(/^(.*?)(\d*(?:枚|ケ|ヶ|玉|尾|(?<!S)P|個|杯))\s*([\d,]+)\s*(.*)$/);
  if (m) {
    const before = m[1].trim();
    const unit = m[2].replace(/ケ/, 'ヶ').replace(/^\d+/, '');
    const value = parseInt(m[3].replace(/,/g, ''), 10);
    return { kind: 'single', sizeText: before, value, unit, priceOk: true };
  }

  // プレフィックス無しの裸の数字は、既存アプリと同じ前提でkg単価として扱う
  m = s.match(/^(.*?)\s+([\d,]+)\s*(.*)$/);
  if (m && /\d/.test(m[2])) {
    const before = m[1].trim();
    const value = parseInt(m[2].replace(/,/g, ''), 10);
    return { kind: 'single', sizeText: before, value, unit: 'kg', priceOk: true };
  }

  return { kind: 'none', sizeText: s, priceOk: false };
}

// 由良ウニの船名（「与助丸」を「与助」より先に判定する）
const UNI_BOAT_RE = /廣田丸|広田丸|与助丸|与助|山由丸/;

// 角倉タブの原稿テキストから、この発注・納品管理アプリ向けの原稿商品を抽出する。
export function extractKadokuraManuscriptItems(rawText) {
  const groups = groupLines(rawText);
  const items = [];
  const skippedLines = [];

  groups.forEach((group) => {
    // 2026-09-25 追加（kento指示）: 鮎（稚鮎・活鮎など）は読み込まない（エラー一覧にも出さない）
    if (/鮎/.test(group.name || '')) return;

    // 2026-09-25 追加（kento指示）: 「◎北ウニNo.①」のような丸ウニ（◎）ブロックを読み込む。
    //   ウニは書き方が特殊なので、価格（「・＠25,500」）の手前までに書かれていることを全部品目名にする
    //   （例: 北ウニNo.① （養殖） カネキ木村250ｇ 【浜中養殖バフン】。規格は空欄）。kento指示 2026-09-25。
    //   単位 = ウニは枚（塩水ウニはpc）、産地 = 行の中の都道府県・国名（データとして記録）。
    if (group.isMaruUni && group.maruUniPrice != null) {
      const detail = group.variants.map((v) => v.raw.trim()).filter(Boolean).join(' ');
      const all = `${group.name} ${detail}`;
      const pref = ORIGIN_NAMES.find((p) => all.includes(p)) || '';
      items.push({
        item_name: normalizeName(all.replace(/[\s　]+/g, ' ').trim()),
        origin: pref,
        spec: '',
        unit_price: group.maruUniPrice,
        price_unit: guessPurchasePriceUnit(all),
        raw_line: `◎${group.name} / ${detail} / ＠${group.maruUniPrice}`,
      });
      return;
    }

    // 由良ウニ・丸ウニ(◎)・宮津トリ貝は既存アプリ側も専用の組み立て関数を持つほど
    // 特殊な書式のため、自動抽出はせず要確認として一覧に出す（原稿価格なしで手動対応）
    if (group.isMaruUni || group.isMiyazu || (group.subVariants && group.subVariants.length > 0)) {
      skippedLines.push(`${group.name}（特殊フォーマットのため要手動確認）`);
      return;
    }
    // 2026-09-25 追加（kento指示）: 「・ちりめん山椒1k×1P ×3,000  1P〜」のように、品目名の行に
    // 規格と価格まで1行で書かれている場合は、最初の数字の手前で品目名と規格・価格に分けて読む。
    if (group.variants.length === 0) {
      const one = (group.name || '').match(/^([^\d]+?)\s*((?:約)?\d.*)$/);
      const parsedOne = one ? parseVariantLineRaw(one[2]) : null;
      if (parsedOne && parsedOne.priceOk && parsedOne.kind === 'single') {
        const r = resolveNameOrigin({ ...group, name: one[1] });
        // ウニ（由良廣田丸など）は書き方が特殊なので、価格の手前までを全部品目名にする（規格は空欄）
        const isUni = /ウニ|うに|雲丹|廣田丸|広田丸|与助|山由丸/.test(group.name);
        items.push({
          item_name: isUni
            ? normalizeName([one[1].trim(), parsedOne.sizeText].filter(Boolean).join(' '))
            : normalizeName(r.itemName),
          origin: r.pref || (group.forcedCategory === '加工品' ? '兵庫' : ''),
          spec: isUni ? '' : parsedOne.sizeText,
          unit_price: parsedOne.value,
          price_unit: parsedOne.unit,
          raw_line: group.name,
        });
        return;
      }
      if (group.name) skippedLines.push(`${group.name}（価格行なし）`);
      return;
    }

    const resolved = resolveNameOrigin(group);
    let itemName = normalizeName(resolved.itemName);
    // 2026-09-23 追加（kento指示）: 由良ウニの船名（廣田丸・与助・与助丸・山由丸）は
    // 「・由良ウニ兵庫(廣田丸)」のように産地の後ろの括弧に書かれることが多く、従来は産地の
    // 付属情報として捨てられていた（結果が「由良ウニ(兵庫)」になっていた）。
    // 品目名・産地行のどこかに船名があれば、品目名に「由良ウニ(廣田丸)」の形で残す。
    const boatMatch = `${group.name || ''} ${group.originLine || ''}`.match(UNI_BOAT_RE);
    if (boatMatch && !itemName.includes(boatMatch[0])) {
      itemName = `${itemName}(${boatMatch[0]})`;
    }
    const origin = resolved.pref || '';

    group.variants.forEach((v) => {
      const parsed = parseVariantLineRaw(v.raw);
      if (!parsed.priceOk) {
        skippedLines.push(`${itemName} / ${v.raw}`);
        return;
      }
      const rawLine = `${group.name} / ${v.label ? `(${v.label}) ` : ''}${v.raw}`;
      if (v.label) parsed.sizeText = [v.label, parsed.sizeText].filter(Boolean).join(' ');
      if (parsed.kind === 'dual') {
        parsed.parts.forEach((part) => {
          items.push({
            item_name: `${itemName}${part.suffix}`,
            origin,
            spec: parsed.sizeText,
            unit_price: part.value,
            price_unit: part.unit,
            raw_line: rawLine,
          });
        });
      } else {
        items.push({
          item_name: itemName,
          origin,
          spec: parsed.sizeText,
          unit_price: parsed.value,
          price_unit: parsed.unit,
          raw_line: rawLine,
        });
      }
    });
  });

  return { items, skippedLines };
}
