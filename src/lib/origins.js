// 都道府県・国名以外の産地（市町村名・漁港名など）の登録リスト（2026-09-25 kento指示）。
// 地名 → その地名がある都道府県。
//   - LINE実績データ: 品目名にこの地名が含まれていれば、品目名はそのまま残し、産地（origin）
//     としても地名のまま記録する（「明石」を「兵庫」に書き換えたりはしない）。
//   - 原稿との照合: 原稿側の産地は都道府県で書かれていることが多いため、照合するときだけ
//     「明石」を「兵庫」と同じ産地として扱う（表示や保存する値は変えない）。
// kentoさんから届く原稿を見ながら、ここに追記していく。
export const LOCAL_ORIGINS = {
  '明石': '兵庫',
};

export const LOCAL_ORIGIN_NAMES = Object.keys(LOCAL_ORIGINS);

// 照合用: 産地の文字列に含まれる登録地名を都道府県名に置き換えた別名も返す
export function originAliases(origin) {
  const o = origin || '';
  const out = [o];
  LOCAL_ORIGIN_NAMES.forEach((n) => { if (o.includes(n)) out.push(o.replace(n, LOCAL_ORIGINS[n])); });
  return out;
}
