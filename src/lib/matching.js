// LINE実績データの品目と、原稿(manuscript_items)の候補を突合するロジック。
// AIは使わず、単純な文字列一致・部分一致・正規化一致 + 規格/産地ボーナスで
// 候補を自動で絞り込み、最終的な確定はユーザーが行う
// （追加仕様書「LINE出荷実績データを利用した照合・納品書作成」6〜11章参照）。

// 全角/半角の括弧やスペースの違いを吸収する正規化（8〜10章）。
// 「白甘鯛（和歌山）」と「白甘鯛(和歌山)」を同じ候補として扱えるようにする。
export function normalizeName(s) {
  return (s || '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/\s+/g, '')
    .trim();
}

// 表記揺れ（同義語）グループ。原稿とLINE実績データとで、同じ魚でも
// 漢字/カナ/ひらがな表記が異なり文字として重ならないことがある
// （例:「鯵」（LINE実績データ側）と「マアジ」（原稿側）は部分一致では拾えない）。
// 同じグループに含まれる語同士は、通常の部分一致（tier2）と同じ強さの候補として扱う。
// kento指示（2026-09-21）: 「鯵」→「マアジ」が候補に出るようにしてほしい。
// 今後similarな表記揺れが見つかったら、ここにグループを追記していけば対応できる。
const NAME_SYNONYM_GROUPS = [
  ['鯵', 'あじ', 'アジ', 'まあじ', 'マアジ'],
];

// 2026-09-23 追加（kento指示）: LINE実績データ側の品目名が下記のいずれかと「完全に一致」する
// 場合は、原稿の「活天然タイSP」に確実に当てはまる（tier 4 = 確実）。
// 「鯛」は白甘鯛・真鯛などにも含まれるため、部分一致ではなく品目名の完全一致でのみ反応させる。
// 今後同じような「この呼び方は確実にこの原稿品目」という対応が増えたら、ここに追記する。
const CERTAIN_ALIASES = [
  {
    lineNames: ['天然鯛', 'タイ', '天タイ', '鯛'],
    // 原稿側: 品目名に「活天然タイ」を含み、品目名＋規格に「SP」を含むもの
    matchManuscript: (mName, mSpec) => mName.includes('活天然タイ') && /SP/i.test(mName + mSpec),
  },
];

// 由良ウニの船名。LINE側・原稿側の両方に同じ船名があれば候補にする（tier 2）。
// 「与助丸」は「与助」より先に判定する。
const UNI_BOAT_RE = /廣田丸|広田丸|与助丸|与助|山由丸/;
function boatOf(s) {
  const m = (s || '').match(UNI_BOAT_RE);
  if (!m) return '';
  return m[0].replace('広田丸', '廣田丸').replace(/^与助$/, '与助丸');
}

// ひらがな→カタカナ（検索用）
function toKatakana(s) {
  return (s || '').replace(/[\u3041-\u3096]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

// 候補が無いときの検索欄用。品目名・産地・規格のどこかに検索語（空白区切りで全て）を含む原稿商品を返す。
export function searchManuscriptItems(query, manuscriptItems) {
  const terms = toKatakana((query || '').toUpperCase()).split(/\s+/).map(normalizeName).filter(Boolean);
  if (terms.length === 0) return [];
  return manuscriptItems.filter((mi) => {
    const hay = toKatakana(normalizeName(`${mi.item_name || ''}${mi.origin || ''}${mi.spec || ''}`).toUpperCase());
    return terms.every((t) => hay.includes(t));
  });
}

// 「確実なもの」だけを返す（無ければnull）。LINE実績データ確定時のデフォルト紐付けに使う。
//   確実 = 最上位候補が tier 3（品目名の完全一致）以上で、かつ同点の候補が他に無いこと。
//   同じ品目名で産地違い・規格違いの原稿が複数あって絞り切れない場合は、確実とはみなさない。
export function pickCertainCandidate(lineItem, manuscriptItems) {
  const ranked = rankManuscriptCandidates(lineItem, manuscriptItems);
  if (ranked.length === 0) return null;
  const top = ranked[0];
  if (top.tier < 3) return null;
  if (ranked.length > 1 && ranked[1].score === top.score) return null;
  return top.item;
}

function hasSynonymMatch(a, b) {
  return NAME_SYNONYM_GROUPS.some(
    (group) => group.some((term) => a.includes(term)) && group.some((term) => b.includes(term))
  );
}

// lineItem: { item_name, spec, origin } （LINE実績データから抽出した1品目）
// manuscriptItems: [{ id, item_name, origin, spec, unit_price, price_unit, ... }]
// 戻り値: [{ item: manuscriptItem, tier, score }] をscore降順で返す（tier=0のものは含めない）。
//   tier 4 = CERTAIN_ALIASES による確実な対応（例: 天然鯛→活天然タイSP）
//   tier 3 = 品目名が正規化後に完全一致
//   tier 2 = 品目名が正規化後に部分一致（どちらかがどちらかを含む）、
//            または NAME_SYNONYM_GROUPS による表記揺れ一致
//   score にはさらに規格一致・産地一致のボーナスを加算する。
//   産地未指定（lineItem.origin が空）の場合は産地ボーナスを付けないため、
//   同じ品目名で産地違いの原稿が複数あるときは全て同点で候補に残る（9章）。
export function rankManuscriptCandidates(lineItem, manuscriptItems) {
  const qName = normalizeName(lineItem.item_name);
  const qSpec = normalizeName(lineItem.spec);
  const qOrigin = normalizeName(lineItem.origin);
  if (!qName) return [];

  const scored = [];
  for (const mi of manuscriptItems) {
    const mName = normalizeName(mi.item_name);
    const mSpec = normalizeName(mi.spec);
    const mOrigin = normalizeName(mi.origin);
    if (!mName) continue;

    let tier = 0;
    const alias = CERTAIN_ALIASES.find((a) => a.lineNames.includes(qName));
    if (alias) {
      // 対応表に載っている呼び方は、対応先の原稿品目だけを「確実」とし、
      // それ以外は通常の部分一致判定に任せる
      if (alias.matchManuscript(mName, mSpec)) tier = 4;
    }
    if (tier === 0 && mName === qName) tier = 3;
    else if (tier === 0 && (mName.includes(qName) || qName.includes(mName))) tier = 2;
    else if (tier === 0 && hasSynonymMatch(mName, qName)) tier = 2;
    else if (tier === 0 && boatOf(qName) && boatOf(qName) === boatOf(mName)) tier = 2;
    if (tier === 0) continue;

    let bonus = 0;
    if (qSpec && mSpec && qSpec === mSpec) bonus += 2;
    if (qOrigin && mOrigin && qOrigin === mOrigin) bonus += 1;

    scored.push({ item: mi, tier, score: tier * 10 + bonus });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}
