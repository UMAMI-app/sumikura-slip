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
//   送料                     … 品目名だけの行。品目としては一切扱わない（2026-09-24 kento指示）。
//   1                       … 「送料」の数量行。これも読み飛ばす（品目には反映しない）。
//
// 「仕入 ¥○○」の後に単位が明記されていない場合、purchase_price_unit は空文字のままにする
// （空欄なら原稿の単価単位を基準に金額計算する。単位が判断できない場合はユーザーに選ばせる。20章）。
// 「㎏」だけの行（数値が無い）は実重量が未入力という意味であり、0にしてはいけない（19章）。
// また「㎏」という文字があることだけを理由に単価単位をkgと決めつけてもいけない（19章）。
// 仕入価格が無い商品があるのは正常であり、エラーにしない（20章）。
// 今後実データでフォーマットのズレが見つかった場合は、このファイルの正規表現を調整すればよい。

import { ORIGIN_NAMES } from './manuscriptKadokura.js';
import { guessPurchasePriceUnit, guessQuantityUnit, forcedUnitForName } from './priceUnitGuess.js';

const CATEGORY_MAP = [
  { re: /航空便/, category: 'air' },
  { re: /宅急便/, category: 'takkyu' },
  { re: /配達|配送/, category: 'ground' },
];

// 2026-09-23 追加変更（kento指示・1回目）: 「仕入 ¥○○」の次に来る行は、基本的に必ず直前の品目の
// 「要望」欄である（新しい品目名にはならない）。ただし数量・規格がその行に書かれている場合は
// それも拾う（例:「800g × 1本　⚠️水洗い」）。
// 一方で、⚠️マークも数量も無い単独行（例:「水洗い」）は、新しい品目名なのか要望メモなのか
// 記号だけでは判別できないため、実際によく出てくる処理メモ用語をリスト化し、これに一致する
// 場合だけ要望として扱う（リストに無い言葉は今まで通り新しい品目名として扱われる＝安全側）。
//
// 2026-09-23 追加変更（kento指示・2回目）: 上記のキーワード一致だけでは「バッチリなものお願い
// します」「肩身(骨なし)」「今回個人伝票になります。金額分かり次第教えてください！！」のような
// 定型キーワードに含まれない自由記述の要望を拾いきれなかった（別途、行の「位置」でも判定する
// ロジックを追加。isNoteLineは今でもキーワード一致の判定として使っている）。
//
// 2026-09-25 追加変更（kento指示・5回目）: 「仕入／売値の直後の1行は備考」という位置ベースの
// ルールだけでは、実際には備考が無くそのまま次の品目名が続くケース（例:「メヒカリ銚子(40g)」
// 「鯵」「生食かき」「ハマグリ」「赤ムツ」等が備考に巻き込まれてしまった）を誤判定してしまう
// ことが実データで見つかった。対策として、位置ベースのみで備考と判定しようとしている行に限り
// 「その次の行」を先読みし、実重量・仕入／売値・数量(+単位)のような「品目に続くデータ」らしい
// 行が来ている場合は、今見ている行こそが新しい品目名だったと判断して備考にはしない
// （looksLikeItemContinuationLine）。⚠️マークやNOTE_KEYWORDSに明示的に一致した行は、この先読みに
// 関わらず常に備考として扱う（キーワード一致のほうが位置ベースの推測より確実なため）。
const NOTE_KEYWORDS = [
  '水洗い', '腹出し', '腹抜き', '鱗とり', '鱗かき', 'すき引き', '内臓処理', '処理なし',
];
function isNoteLine(line) {
  return line.includes('⚠️') || NOTE_KEYWORDS.some((k) => line.includes(k));
}

// 実重量／仕入・売値／数量(+単位)／規格×数量 など、「品目名の直後に続くデータ」らしい行かどうか。
// 備考の先読み判定専用（本来の各解析ロジックとは正規表現を共有せず、判定目的だけに使う）。
function looksLikeItemContinuationLine(line) {
  if (!line) return false;
  if (/^(\d+(?:\.\d+)?)\s*(㎏|kg)\s*$/i.test(line)) return true; // 実重量
  if (/^(㎏|kg)\s*$/i.test(line)) return true; // 実重量（未入力）
  if (/^(仕入|売値)\s*[¥￥]/.test(line)) return true; // 仕入／売値の価格行
  if (/^(\d+(?:\.\d+)?)\s*(本|尾|杯|枚|個|箱|束|ケ|ヶ|パック|腹|匹|pc)\s*$/i.test(line)) return true; // 数量+単位
  if (/^.+?\s*[×x]\s*(\d+(?:\.\d+)?)\s*(本|尾|杯|枚|個|箱|束|ケ|ヶ|パック|腹|匹|pc)\s*$/i.test(line)) return true; // 規格×数量
  return false;
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

// 「送料」の見出し行。カッコ書きの補足（例:「送料(箱代含む)」）は許すが、それ以外の自由文
// （例:「送料別！」のような、送料についての備考コメント）を誤って送料マーカーとして食べて
// しまわないよう、厳密に「送料」＋任意のカッコ書きのみに限定する（2026-09-25 実データレビューで
// 発見。ユーザーからの直接指示ではないが、既存の「送料は品目にしないが情報は失わない」方針に
// 沿った補強。「送料別！」のような自由文は下の通常の備考判定に流れて拾われる）。
const SHIPPING_FEE_LINE_RE = /^送料(?:[（(][^)）]*[)）])?\s*$/;
// 送料マーカー行の後に、その送料自体の数量行（例:「1」）や価格行（例:「仕入 ¥2,200」）が
// 続くことがある。どちらも品目には一切反映せず読み飛ばす対象なので、まとめて判定する
// （2026-09-25 追加変更・実データレビューで発見。「送料(箱代含む)」→「1」→「仕入 ¥2,200」の
// ように価格行まで続くケースで、直前の実品目のpurchase_priceを巻き込んで上書きしてしまう
// 問題への対応）。
function isShippingFeeContinuationLine(line) {
  return /^(\d+(?:\.\d+)?)$/.test(line) || /^(仕入|売値)\s*[¥￥]/.test(line);
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
    // 2026-09-23 追加変更（kento指示・2回目）: 「仕入／売値」の行を読んだ直後だけtrueにする
    // フラグ。「仕入／売値の次に来る1行は備考」という位置ベースのルールをこれで実現する。
    awaitingPostPriceLine: false,
    // 2026-09-25 追加変更（kento指示・5回目）: 「送料」の直後に続く、送料自体の数量行・価格行を
    // 読み飛ばすためのカウンタ（最大2行分＝数量行＋価格行）。品目には一切反映しない。
    shippingFeeLinesToConsume: 0,
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = lines[i + 1];

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

    // 2026-09-25 追加変更（kento指示・5回目）: 「送料」マーカー行そのもの、および
    // それに続く数量行・価格行（最大2行）はここで最優先に読み飛ばす（品目には一切反映しない・
    // 「仕入」「売値」の判定より必ず先に行い、直前の実品目のpurchase_priceを巻き込んで
    // 上書きしてしまわないようにする）。
    if (SHIPPING_FEE_LINE_RE.test(line)) {
      dest.awaitingPostPriceLine = false;
      dest.shippingFeeLinesToConsume = 2;
      continue;
    }
    if (dest.shippingFeeLinesToConsume > 0) {
      if (isShippingFeeContinuationLine(line)) {
        dest.shippingFeeLinesToConsume--;
        // 2026-09-23 追加（kento指示）: 送料の「仕入 ¥○○」の直後の行も、通常の仕入の直後と同じく
        // 直前の実品目（送料は品目にしないので、その前の本当の品目）の備考として扱う。
        // 例:「天然鯛SP(2k)…/送料(箱代含む)/1/仕入 ¥2,000/(明石から)」→「明石から」は天然鯛の備考。
        // （従来は送料の価格行を読み飛ばすだけで「仕入の直後」扱いにしていなかったため、
        //   「(明石から)」が品目名の無い新しい品目として登録されていた）
        if (/^(仕入|売値)\s*[¥￥]/.test(line)) dest.awaitingPostPriceLine = true;
        continue;
      }
      dest.shippingFeeLinesToConsume = 0; // 送料に関係ない行が来たので通常の判定に戻す
    }

    // 「仕入 ¥13,000」「仕入 ¥13,000/kg」
    if ((m = line.match(/^仕入\s*[¥￥]\s*([\d,]+)(?:\s*\/\s*(\S+))?\s*$/))) {
      if (lastItem) {
        lastItem.purchase_price = parseFloat(m[1].replace(/,/g, ''));
        lastItem.purchase_price_unit = m[2] || '';
        dest.awaitingPostPriceLine = true; // 次の1行は原則として備考（2026-09-23 kento指示）
      } else {
        warnings.push(`「${line}」の対象の品目が見つかりませんでした`);
      }
      continue;
    }
    // 「売値 ¥5,200」: 2026-09-25 追加変更（kento指示・5回目）「売値記載あるものは反応して
    // ほしい」に対応し、これまでのように備考テキストへ埋め込むのではなく、lastItem.sell_priceに
    // 数値として保持する（line_actual_items.sell_price → 納品書明細(invoice_line_items.sell_price)
    // まで引き継がれ、履歴画面の利益計算にそのまま使われる。手入力・自動計算のデフォルト値は
    // 従来どおり空欄の場合のみ使われる）。
    if ((m = line.match(/^売値\s*[¥￥]\s*([\d,]+)\s*$/))) {
      if (lastItem) {
        lastItem.sell_price = parseFloat(m[1].replace(/,/g, ''));
        dest.awaitingPostPriceLine = true; // 仕入と同様、次の1行は原則として備考
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
    // 2026-09-24 追加変更（kento指示・3回目）: 「弘茂丸」は配送を担当する船（配送業者）の名前。
    // ブロックのどこに出てきても新しい品目にはせず、そのブロックでこれまでに確定している
    // 「最後の実品目」の備考として追記する（送料は上のチェックでitems自体に入らなくなった
    // ので、除外の絞り込みは不要）。「仕入／売値の直後」ルールでは拾えない位置（末尾等）に
    // 出てくることがあるため、位置に関係なく「弘茂丸」という単語だけに反応する専用ルール。
    const HIROSHIGEMARU_KEYWORD = '弘茂丸';
    if (line.includes(HIROSHIGEMARU_KEYWORD)) {
      const target = dest.items[dest.items.length - 1];
      if (target) {
        target.note = target.note ? `${target.note} / ${line}` : line;
      } else {
        warnings.push(`「${line}」の対象の品目が見つかりませんでした`);
      }
      dest.awaitingPostPriceLine = false;
      continue;
    }

    // 「800g × 1本」のように、規格＋数量が品目名行の次の行に分かれて来ることがある（20章の例）。
    // 2026-09-23 追加変更（kento指示・2回目）: これは備考ではなく構造化データなので、下の
    // 「仕入／売値の直後は備考」判定より必ず先に判定する（判定の優先順位を明確にするため、
    // 以下3つの構造化行チェックを備考チェックより前に移動した）。
    if ((m = line.match(/^(.+?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*(本|尾|杯|枚|個|箱|束|ケ|ヶ|パック|腹|匹|pc)\s*$/i))) {
      if (lastItem) {
        if (!lastItem.spec) lastItem.spec = m[1].trim();
        if (lastItem.quantity == null) {
          lastItem.quantity = parseFloat(m[2]);
          lastItem.quantity_unit = /^pc$/i.test(m[3]) ? 'pc' : m[3].replace('ケ', 'ヶ');
        }
        dest.awaitingPostPriceLine = false;
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
      dest.awaitingPostPriceLine = false;
      continue;
    }
    // 数量だけの行（送料の数量行は上で既に読み飛ばし済み。ここに来るのはそれ以外のケース）
    if ((m = line.match(/^(\d+(?:\.\d+)?)$/))) {
      if (lastItem && lastItem.quantity == null) {
        lastItem.quantity = parseFloat(m[1]);
      } else {
        warnings.push(`数量らしき行「${line}」の対象の品目が見つかりませんでした`);
      }
      dest.awaitingPostPriceLine = false;
      continue;
    }

    // 2026-09-23 追加変更（kento指示・2回目）: 「仕入／売値」の行の直後に来る1行は、原則として
    // 必ず直前の品目の「備考」である（新しい品目名にはしない）。これはキーワード一致
    // （⚠️マークやNOTE_KEYWORDS）に関わらず適用する（例:「バッチリなものお願いします」
    // 「肩身(骨なし)」「今回個人伝票になります。金額分かり次第教えてください！！」等、
    // 定型キーワードではない自由記述の備考も同様に拾う）。「送料」は上のチェックで既に
    // 専用処理されているため、ここでの特別扱いは不要になった（2026-09-24 kento指示）。
    //
    // 2026-09-25 追加変更（kento指示・5回目）: ただし、この判定が⚠️／NOTE_KEYWORDSの
    // 明示的な一致ではなく「位置（仕入／売値の直後）」だけによるものである場合に限り、
    // 「次の行」を先読みして実重量／仕入・売値／数量のような品目継続データらしい行が
    // 来ていれば、今見ている行こそが新しい品目名だったと判断し備考にはしない
    // （＝下の品目作成ロジックに処理を委ねる）。実データで「メヒカリ銚子(40g)」「鯵」
    // 「生食かき」「ハマグリ」「赤ムツ」等が誤って備考に巻き込まれていた問題への対応。
    // 2026-09-23 追加（kento指示）: 行全体がカッコ書きだけの行（例:「(明石から)」）は品目名になり得ない
    // （品目名が空の品目ができてしまう）ため、位置に関係なく直前の実品目の備考として扱う。
    const wholeParen = line.match(/^[（(]([^)）]+)[)）]$/);
    if (wholeParen && lastItem) {
      const t = wholeParen[1].trim();
      if (t) lastItem.note = lastItem.note ? `${lastItem.note} / ${t}` : t;
      dest.awaitingPostPriceLine = false;
      continue;
    }

    if (isNoteLine(line) || dest.awaitingPostPriceLine) {
      const explicitNote = isNoteLine(line);
      const treatAsNote = explicitNote || !looksLikeItemContinuationLine(nextLine);
      if (treatAsNote) {
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
          const pw = noteText.match(/^[（(]([^)）]+)[)）]$/);
          if (pw) noteText = pw[1].trim();
          if (noteText) lastItem.note = lastItem.note ? `${lastItem.note} / ${noteText}` : noteText;
        } else {
          warnings.push(`「${line}」の対象の品目が見つかりませんでした`);
        }
        dest.awaitingPostPriceLine = false;
        continue;
      }
      // 先読みの結果、備考ではなく新しい品目名だと判断した（下の品目作成ロジックに委ねる）。
      dest.awaitingPostPriceLine = false;
    }
    dest.awaitingPostPriceLine = false;

    if (dest.destinationName && dest.methodRaw) {
      // ここまでの見出し情報が揃っていれば、以降は品目行として扱う
      const parsed = parseItemNameLine(line);
      // 仕入価格が無い商品があるのは正常（20章）。purchase_priceはnullのまま保持する。
      lastItem = { ...parsed, actual_weight: null, actual_weight_unit: '', purchase_price: null, purchase_price_unit: '', sell_price: null, note: '', raw: line };
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
// 2026-09-24 追加変更（kento指示・4回目）: 送料はparseLineShipmentText側で品目として
// 一切扱わなくなった（items配列に追加されない）ため、ここでの送料除外フィルタは不要になった。
// 2026-09-25 追加変更（kento指示・5回目）: 原稿にLINE実績データ上の「売値」が明記されていた
// 場合、sell_priceとしてそのまま行データに含める（line_actual_items.sell_price）。
export function buildLineActualRows(destinations, orderDate, defaultUnitMap = {}) {
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
        // 2026-09-23 追加変更（kento指示）: 数量の記載が一切無かった場合は「1」＋品目ごとの
        // 数え方（guessQuantityUnit。既知パターンが無ければ「本」）をデフォルトにする。
        quantity: it.quantity != null ? it.quantity : 1,
        // 廣田丸は原文の明記単位（pc等）より優先して必ず「枚」（forcedUnitForName）。
        // 「塩水ウニ(廣田丸)」のように括弧内（spec/origin）に書かれた場合も対象にする。
        quantity_unit: forcedUnitForName([it.origin, it.item_name, it.spec].filter(Boolean).join(' ')) || it.quantity_unit || guessQuantityUnit(it.item_name),
        actual_weight: it.actual_weight,
        actual_weight_unit: it.actual_weight_unit || (it.actual_weight != null ? 'kg' : ''),
        purchase_price: it.purchase_price,
        purchase_price_unit: forcedUnitForName([it.origin, it.item_name, it.spec].filter(Boolean).join(' ')) || it.purchase_price_unit || guessPurchasePriceUnit(it.item_name, defaultUnitMap[it.item_name]),
        sell_price: it.sell_price != null ? it.sell_price : null,
        note: it.note || '',
        raw_line: it.raw,
      });
    });
  });
  return rows;
}
