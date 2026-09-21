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

function hasSynonymMatch(a, b) {
  return NAME_SYNONYM_GROUPS.some(
    (group) => group.some((term) => a.includes(term)) && group.some((term) => b.includes(term))
  );
}

// lineItem: { item_name, spec, origin } （LINE実績データから抽出した1品目）
// manuscriptItems: [{ id, item_name, origin, spec, unit_price, price_unit, ... }]
// 戻り値: [{ item: manuscriptItem, tier, score }] をscore降順で返す（tier=0のものは含めない）。
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
    if (mName === qName) tier = 3;
    else if (mName.includes(qName) || qName.includes(mName)) tier = 2;
    else if (hasSynonymMatch(mName, qName)) tier = 2;
    if (tier === 0) continue;

    let bonus = 0;
    if (qSpec && mSpec && qSpec === mSpec) bonus += 2;
    if (qOrigin && mOrigin && qOrigin === mOrigin) bonus += 1;

    scored.push({ item: mi, tier, score: tier * 10 + bonus });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}
