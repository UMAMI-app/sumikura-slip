// Supabase REST APIクライアント（UMAMI stockと同じ「素のfetchでPostgRESTを叩く」方式に合わせている）。
//
// TODO: Supabaseプロジェクト作成後、Project Settings → API から
//       Project URL と anon public key を取得してここに設定してください。
export const SUPABASE_URL = "__SUPABASE_URL__"; // 例: https://xxxxxxxx.supabase.co
export const SUPABASE_KEY = "__SUPABASE_ANON_KEY__";

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
  remove: (table, id) => sbFetch(table, { method: "DELETE", params: `?id=eq.${id}` }),
};
