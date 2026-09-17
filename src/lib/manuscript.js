// 原稿読み込み処理
//
// 既存アプリ「案内生成アプリ」(UMAMI-app/info-generate, upload.html) の原稿読み込み処理を
// 調査のうえ移植したモジュール。既存アプリのファイルは一切変更していない。
//
// 移植（ほぼそのまま再利用）した部分:
//   - Pyodide + numbers-parser による .numbers ファイル→TSVグリッド変換の一連の流れ
//     （pure_snappy.py によるsnappy差し替え、micropipでのインストール手順を含む）
//   - parseGrid / detectBlocksFromHeader（TSVテキストを「魚種/サイズ/産地/価格」の
//     4列ブロックに分解する処理）
//   - parsePrice（"k12,000" "¥900" "ASK" "?" 等の価格表記の解析）
//   - stripEmoji / normalizeOrigin(国旗絵文字→産地名) / splitNameTag / splitSizeComment
//     などのテキスト整形ヘルパー
//
// 新規に書いた部分:
//   - 今回の発注・納品管理アプリ向けに、案内文生成（カテゴリー分類・絵文字装飾・
//     取引先ごとの独自フォーマット等）のロジックは持ち込まず、
//     「品目・産地・規格・単価・単価単位」を抽出するだけのシンプルな
//     extractManuscriptItems() を新規実装した。
//   - 単価単位（kg/本/尾/個/箱/束/枚/杯 等）を価格欄・サイズ欄の記載から推測する
//     inferPriceUnit() を新規実装した（既存アプリは単位を明示的に持たず、
//     案内文の文脈判断で処理していたため）。

// ---- 価格解析（既存アプリ upload.html より移植） ----
const PRICE_RE = {
  k: /^k\s?([\d,]+)$/i,
  yen: /^[¥￥]\s?([\d,]+)$/,
  ask: /^(ASK|問合せ|お問合せ|お問い合わせ)$/i,
  unknown: /^\?+$/,
};

export function parsePrice(raw) {
  const original = (raw || '').trim();
  const s = original.replace(/[\p{Extended_Pictographic}️‍！!‼‽]+$/gu, '').trim();
  if (PRICE_RE.k.test(s)) return { type: 'k', value: parseInt(s.match(PRICE_RE.k)[1].replace(/,/g, ''), 10), raw: original };
  if (PRICE_RE.yen.test(s)) return { type: 'yen', value: parseInt(s.match(PRICE_RE.yen)[1].replace(/,/g, ''), 10), raw: original };
  if (PRICE_RE.ask.test(s)) return { type: 'ask', value: null, raw: original };
  if (PRICE_RE.unknown.test(s)) return { type: 'unknown', value: null, raw: original };
  if (s === '') return { type: 'empty', value: null, raw: original };
  if (/^[\d,]+(\.\d+)?$/.test(s)) return { type: 'yen', value: Math.round(parseFloat(s.replace(/,/g, ''))), raw: original };
  let m = s.match(/^(.*?)[¥￥]\s?([\d,]+)$/);
  if (m) return { type: 'yen', value: parseInt(m[2].replace(/,/g, ''), 10), raw: original, prefixNote: m[1].trim() };
  m = s.match(/^(.*?)k\s?([\d,]+)$/i);
  if (m) return { type: 'k', value: parseInt(m[2].replace(/,/g, ''), 10), raw: original, prefixNote: m[1].trim() };
  return { type: 'other', value: null, raw: original };
}

// ---- グリッド解析（既存アプリ upload.html より移植） ----
export function detectBlocksFromHeader(grid) {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    const starts = [];
    for (let c = 0; c <= row.length - 4; c++) {
      if (row[c] === '魚種' && row[c + 1] === 'サイズ' && row[c + 2] === '産地' && row[c + 3] === '価格') {
        starts.push(c);
      }
    }
    if (starts.length >= 1) return starts.map((s) => [s, s + 4]);
  }
  return null;
}

export function parseGrid(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  const rows = lines.map((l) => l.split('\t'));
  const maxCols = Math.max(...rows.map((r) => r.length), 1);
  const grid = rows.map((r) => {
    const row = r.slice();
    while (row.length < maxCols) row.push('');
    return row.map((c) => (c || '').trim());
  });

  const headerBlocks = detectBlocksFromHeader(grid);
  if (headerBlocks) return { grid, blocks: headerBlocks };

  const blankCols = [];
  for (let c = 0; c < maxCols; c++) {
    if (grid.every((r) => r[c] === '')) blankCols.push(c);
  }
  let blocks = [];
  let start = 0;
  for (let c = 0; c <= maxCols; c++) {
    if (blankCols.includes(c) || c === maxCols) {
      if (c > start) blocks.push([start, c]);
      start = c + 1;
    }
  }
  if (blocks.length === 0 && maxCols > 0) blocks.push([0, maxCols]);

  if (blocks.length === 1) {
    const width = blocks[0][1] - blocks[0][0];
    if (width > 4 && width % 4 === 0) {
      const s0 = blocks[0][0];
      blocks = [];
      for (let c = s0; c < s0 + width; c += 4) blocks.push([c, c + 4]);
    }
  }

  return { grid, blocks };
}

// ---- テキスト整形ヘルパー（既存アプリ upload.html より移植） ----
export function stripEmoji(s) {
  return (s || '')
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|️|‍/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const FLAG_TO_ORIGIN = {
  '🇳🇴': 'ノルウェー', '🇯🇵': '日本', '🇰🇷': '韓国', '🇨🇳': '中国', '🇺🇸': 'アメリカ',
  '🇷🇺': 'ロシア', '🇨🇱': 'チリ', '🇦🇺': 'オーストラリア', '🇻🇳': 'ベトナム', '🇮🇩': 'インドネシア',
};
export function normalizeOrigin(raw) {
  const s = (raw || '').trim();
  return FLAG_TO_ORIGIN[s] || s;
}

export function splitNameTag(raw) {
  let s = (raw || '').trim().replace(/^[\p{Extended_Pictographic}\p{Regional_Indicator}️‍\s]+/u, '');
  let m = s.match(/^【(.*?)】\s*(.*)$/);
  if (m) return { tag: stripEmoji(m[1]), name: m[2].trim() };
  m = s.match(/^(\S+)\s+(.+)$/);
  if (m) return { tag: stripEmoji(m[1]), name: m[2].trim() };
  return { tag: '', name: s };
}

const OK_EMOJI_RE = /[🉑🙆✅👍]/u;
export function splitSizeComment(raw) {
  const s = (raw || '').trim();
  if (!s) return { sizeMain: '', comment: '' };
  const tokens = s.split(/\s+/);
  if (tokens.length > 1) {
    const lastIdx = tokens.length - 1;
    if (OK_EMOJI_RE.test(tokens[lastIdx])) {
      return { sizeMain: tokens.slice(0, lastIdx).join(' '), comment: tokens[lastIdx] };
    }
    return { sizeMain: s, comment: '' };
  }
  if (OK_EMOJI_RE.test(s) && !/^[\d0-9０-９.]/.test(s)) {
    return { sizeMain: '', comment: s };
  }
  return { sizeMain: s, comment: '' };
}

// ---- ここから新規実装 ----

// 単価単位（kg/本/尾/個/箱/束/枚/杯 等）を、価格欄・サイズ欄の記載から推測する。
// 判別できない場合は空文字を返す（呼び出し側でユーザーに編集させる）。
const COUNTER_WORDS = ['kg', '本', '尾', '個', '箱', '束', '枚', '杯'];
export function inferPriceUnit(priceRawText, specText, priceType) {
  const price = (priceRawText || '');
  for (const w of COUNTER_WORDS) {
    const re = new RegExp('[/／]\\s*' + w + '\\b');
    if (re.test(price)) return w;
  }
  const spec = (specText || '');
  for (const w of COUNTER_WORDS) {
    const re = new RegExp('[0-9０-９.]+\\s*' + w + '(?!\\S)');
    if (re.test(spec)) return w;
  }
  if (priceType === 'k') return 'kg';
  return '';
}

// 価格欄に単位が直接書かれているケース（例:"900円/本" "500/kg"）に対応するため、
// 末尾の単位表記を切り出してからparsePrice()に渡す。
function stripUnitSuffix(raw) {
  const s = (raw || '').trim();
  const m = s.match(/^(.*?)[/／]\s*(kg|本|尾|個|箱|束|枚|杯)\s*$/);
  if (m) return { rest: m[1].trim(), unit: m[2] };
  return { rest: s, unit: null };
}

// parsePrice()（既存アプリからの移植）に加えて、「900円」のような円サフィックスや
// 単位付き価格表記もカバーする、この新アプリ向けの価格解析。
function parsePriceForManuscript(priceRawOriginal) {
  const { rest, unit: explicitUnit } = stripUnitSuffix(priceRawOriginal);
  let price = parsePrice(rest);
  if (price.type === 'other' || price.type === 'empty') {
    const m = rest.match(/^(.*?)([\d,]+)\s?円$/);
    if (m) {
      price = { type: 'yen', value: parseInt(m[2].replace(/,/g, ''), 10), raw: priceRawOriginal, prefixNote: m[1].trim() || undefined };
    }
  }
  return { price, explicitUnit };
}

// TSVグリッド（parseGridの出力）から、原稿商品（品目/産地/規格/単価/単価単位）を抽出する。
// 既存アプリのextractItemsFromGridと違い、案内文向けのカテゴリー分類・絵文字装飾は行わない。
export function extractManuscriptItems(grid, blocks) {
  const items = [];
  const skippedLines = [];

  blocks.forEach((range) => {
    const [s, e] = range;
    for (let r = 0; r < grid.length; r++) {
      const cells = grid[r].slice(s, e);
      const rawName = cells[0] || '', rawSize = cells[1] || '', origin = cells[2] || '', priceRaw = cells[3] || '';
      if (!rawName && !rawSize && !origin && !priceRaw) continue; // blank row
      if (rawName === '魚種' && rawSize === 'サイズ') continue; // header row

      const { price, explicitUnit } = parsePriceForManuscript(priceRaw);
      if (!(price.type === 'k' || price.type === 'yen')) {
        // ASK/未定/空欄/解析不能な行は原稿商品としては取り込まない（要確認としてログに残す）
        if (rawName) skippedLines.push([rawName, rawSize, origin, priceRaw].filter(Boolean).join(' / '));
        continue;
      }

      const { name } = splitNameTag(rawName);
      const { sizeMain } = splitSizeComment(rawSize);
      const priceUnit = explicitUnit || inferPriceUnit(priceRaw, sizeMain, price.type);

      items.push({
        item_name: name,
        origin: normalizeOrigin(origin),
        spec: sizeMain,
        unit_price: price.value,
        price_unit: priceUnit,
        raw_line: [rawName, rawSize, origin, priceRaw].filter(Boolean).join(' / '),
      });
    }
  });

  return { items, skippedLines };
}

// ---- Pyodideによる.numbersファイル解析（既存アプリ upload.html initPyodide() より移植） ----
let pyodideReadyPromise = null;

export function getPyodideReady(onStatus) {
  if (!pyodideReadyPromise) {
    pyodideReadyPromise = initPyodide(onStatus);
  }
  return pyodideReadyPromise;
}

async function initPyodide(onStatus) {
  const setStatus = (s) => { if (onStatus) onStatus(s); };
  setStatus('解析エンジンを読み込み中…（初回は数秒〜20秒程度かかります）');
  // eslint-disable-next-line no-undef
  const pyodide = await loadPyodide();

  setStatus('必要な部品を準備中…');
  await pyodide.loadPackage(['protobuf']);
  await pyodide.loadPackage('micropip');

  const snappyResp = await fetch('/pure_snappy.py');
  if (!snappyResp.ok) throw new Error(`pure_snappy.py の取得に失敗 (HTTP ${snappyResp.status})`);
  const snappyCode = await snappyResp.text();
  pyodide.FS.writeFile('/tmp/pure_snappy.py', snappyCode);
  await pyodide.runPythonAsync(`
import sys, types
sys.path.insert(0, '/tmp')
import pure_snappy
_fake_snappy = types.ModuleType('snappy')
_fake_snappy.uncompress = pure_snappy.uncompress
_fake_snappy.decompress = pure_snappy.decompress
sys.modules['snappy'] = _fake_snappy
`);

  setStatus('numbers-parserをインストール中…');
  await pyodide.runPythonAsync(`
import micropip
await micropip.install(['numbers-parser'], deps=False)
await micropip.install([
    'compact-json',
    'sigfig',
    'enum-tools',
    'importlib-resources',
    'python-dateutil',
])
`);

  const converterResp = await fetch('/numbers_to_tsv.py');
  if (!converterResp.ok) throw new Error(`numbers_to_tsv.py の取得に失敗 (HTTP ${converterResp.status})`);
  const converterCode = await converterResp.text();
  pyodide.FS.writeFile('/tmp/numbers_to_tsv.py', converterCode);
  await pyodide.runPythonAsync(`
import sys
sys.path.insert(0, '/tmp')
import importlib
import numbers_to_tsv
importlib.reload(numbers_to_tsv)
`);

  setStatus(null);
  return pyodide;
}

export async function numbersFileToGridText(file, onStatus) {
  const pyodide = await getPyodideReady(onStatus);
  const bytes = new Uint8Array(await file.arrayBuffer());
  pyodide.FS.writeFile('/tmp/uploaded.numbers', bytes);
  const tsv = await pyodide.runPythonAsync(`
numbers_to_tsv.build_tsv_from_numbers('/tmp/uploaded.numbers')
`);
  return tsv;
}
