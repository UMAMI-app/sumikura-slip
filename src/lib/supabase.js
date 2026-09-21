// Supabase REST APIクライアント（UMAMI stockと同じ「素のfetchでPostgRESTを叩く」方式に合わせている）。
//
// 注意: テーブルがまだ無い場合は、Supabase の SQL Editor で supabase/schema.sql を
//       実行してください（anon keyだけではテーブル作成はできません）。
export const SUPABASE_URL = "https://eorizndfnvgikuzewwfs.supabase.co";
export const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvcml6bmRmbnZnaWt1emV3d2ZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2NDQ3MjUsImV4cCI6MjEwNTIyMDcyNX0.cf4-IcCeGO4syO_0yiCV5n6Aa-OpuoQorelLbFTOYZ0";

export function isSupabaseConfigured() {
  return !SUPABASE_URL.includes("__") && !SUPABASE_KEY.includes("__");
}

export async function sbFetch(table, options = {}) {
  const { method = "GET", body, params = "" } = options;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };
  if (method === "POST" || method === "PATCH") headers["Prefer"] = "return=representation";

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`[${table}] ${res.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

export const db = {
  list: (table, params = "") => sbFetch(table, { params }),
  insert: (table, row) => sbFetch(table, { method: "POST", body: row }),
  insertMany: (table, rows) => sbFetch(table, { method: "POST", body: rows }),
  update: (table, id, data) => sbFetch(table, { method: "PATCH", params: `?id=eq.${id}`, body: data }),
  // 2026-09-21 追加変更（kento指示）: 納品書履歴の削除機能用。invoice_idなど
  // 条件に一致する複数行をまとめてPATCHする（1件ずつupdateする手間を省く）。
  updateWhere: (table, query, data) => sbFetch(table, { method: "PATCH", params: query, body: data }),
  remove: (table, id) => sbFetch(table, { method: "DELETE", params: `?id=eq.${id}` }),
  removeWhere: (table, query) => sbFetch(table, { method: "DELETE", params: query }),
  // keyColの値がすでに存在すればPATCH、無ければPOSTする（商品ごとの単価単位の学習等に使う）。
  upsertByKey: async (table, keyCol, keyVal, data) => {
    const existing = await sbFetch(table, { params: `?${keyCol}=eq.${encodeURIComponent(keyVal)}` });
    if (existing.length > 0) {
      return sbFetch(table, { method: "PATCH", params: `?${keyCol}=eq.${encodeURIComponent(keyVal)}`, body: data });
    }
    return sbFetch(table, { method: "POST", body: { [keyCol]: keyVal, ...data } });
  },
};
