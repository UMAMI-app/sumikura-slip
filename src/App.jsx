import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { db, isSupabaseConfigured } from "./lib/supabase";
import { extractKadokuraManuscriptItems } from "./lib/manuscriptKadokura";
import { parseShippingList } from "./lib/shippingList";
import {
  calcLineAmount,
  comparePrice,
  buildInvoiceTotals,
  isSameDayCategory,
  DELIVERY_CATEGORY_LABELS,
} from "./lib/pricing";

// ---- テーマ（UMAMI stockと近い配色に合わせた最小限のインラインスタイル） ----
const T = {
  green: "#1a1a1a",
  bg: "#ffffff",
  panel: "#f2f2f2",
  border: "rgba(0,0,0,0.22)",
  softBorder: "rgba(0,0,0,0.1)",
  textMain: "#1a1a1a",
  textSub: "#666666",
  warn: "#000000",
  warnBg: "#e2e2e2",
  ok: "#1a1a1a",
};

// ---- 日付ユーティリティ ----
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];
function weekdayJa(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "";
  return WEEKDAY_JA[d.getDay()];
}
function formatMD(dateStr) {
  if (!dateStr) return "";
  const [, m, day] = dateStr.split("-");
  return `${parseInt(m, 10)}/${parseInt(day, 10)}`;
}
function fmtYen(n) {
  if (n == null || Number.isNaN(n)) return "";
  return "¥" + Math.round(n).toLocaleString("ja-JP");
}

// ---- 発注行ID採番 ----
function nextLineCode(dateStr, existingCodesForDate) {
  const prefix = dateStr.replace(/-/g, "");
  let max = 0;
  existingCodesForDate.forEach((c) => {
    const m = c && c.match(/^(\d{8})-(\d{3})$/);
    if (m && m[1] === prefix) max = Math.max(max, parseInt(m[2], 10));
  });
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

const BLANK_NEW_LINE = {
  delivery_date: "",
  delivery_time_note: "",
  destination: "",
  item_name: "",
  origin: "",
  quantity: "",
  quantity_unit: "本",
  weight: "",
  request_note: "",
  delivery_category: "ground",
  takkyu_ship_date: "",
  takkyu_arrival_date: "",
};

export default function App() {
  const [tab, setTab] = useState("orders");
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [manuscriptBatches, setManuscriptBatches] = useState([]);
  const [manuscriptItems, setManuscriptItems] = useState([]);
  const [orderLines, setOrderLines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [globalError, setGlobalError] = useState("");

  const loadManuscript = useCallback(async (date) => {
    if (!isSupabaseConfigured()) return;
    const batches = await db.list("manuscript_batches", `?manuscript_date=eq.${date}&order=created_at.desc`);
    setManuscriptBatches(batches);
    if (batches.length === 0) {
      setManuscriptItems([]);
      return;
    }
    const ids = batches.map((b) => `"${b.id}"`).join(",");
    const items = await db.list("manuscript_items", `?batch_id=in.(${ids})&order=item_name.asc`);
    setManuscriptItems(items);
  }, []);

  const loadOrderLines = useCallback(async (date) => {
    if (!isSupabaseConfigured()) return;
    const lines = await db.list("order_lines", `?order_date=eq.${date}&order=created_at.asc`);
    setOrderLines(lines);
  }, []);

  const reloadAll = useCallback(
    async (date = selectedDate) => {
      setLoading(true);
      setGlobalError("");
      try {
        await Promise.all([loadManuscript(date), loadOrderLines(date)]);
      } catch (e) {
        setGlobalError(e.message || String(e));
      } finally {
        setLoading(false);
      }
    },
    [selectedDate, loadManuscript, loadOrderLines]
  );

  useEffect(() => {
    reloadAll(selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  const manuscriptItemById = useMemo(() => {
    const m = new Map();
    manuscriptItems.forEach((it) => m.set(it.id, it));
    return m;
  }, [manuscriptItems]);

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, 'Hiragino Sans', sans-serif", background: T.bg, minHeight: "100vh", color: T.textMain }}>
      <header style={{ padding: "14px 16px", borderBottom: `1px solid ${T.border}`, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} style={inputStyle()} />
        <span style={{ fontSize: 12, color: T.textSub }}>
          {selectedDate}（{weekdayJa(selectedDate)}）{" "}
          {manuscriptBatches.length > 0 && `原稿${manuscriptBatches.length}件読込済`}
        </span>
        <nav style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          {[
            ["manuscript", "原稿読み込み"],
            ["orders", "発注一覧"],
            ["invoice", "納品書作成"],
            ["history", "納品書履歴"],
          ].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={tabBtnStyle(tab === key)}>
              {label}
            </button>
          ))}
        </nav>
      </header>

      {!isSupabaseConfigured() && (
        <div style={{ margin: 16, padding: 12, background: T.warnBg, color: T.warn, borderRadius: 8, fontSize: 13 }}>
          Supabaseが未設定です。src/lib/supabase.js の SUPABASE_URL / SUPABASE_KEY を設定してください（データの保存・読み込みができません）。
        </div>
      )}
      {globalError && (
        <div style={{ margin: 16, padding: 12, background: T.warnBg, color: T.warn, borderRadius: 8, fontSize: 13 }}>
          エラー: {globalError}
        </div>
      )}

      <main style={{ padding: 16, maxWidth: 1100, margin: "0 auto" }}>
        {tab === "manuscript" && (
          <ManuscriptPanel
            date={selectedDate}
            items={manuscriptItems}
            loading={loading}
            onSaved={() => reloadAll(selectedDate)}
          />
        )}
        {tab === "orders" && (
          <OrdersPanel
            date={selectedDate}
            orderLines={orderLines}
            manuscriptItems={manuscriptItems}
            manuscriptItemById={manuscriptItemById}
            onChanged={() => loadOrderLines(selectedDate)}
          />
        )}
        {tab === "invoice" && (
          <InvoicePanel
            date={selectedDate}
            orderLines={orderLines}
            manuscriptItemById={manuscriptItemById}
            onSaved={() => reloadAll(selectedDate)}
          />
        )}
        {tab === "history" && <HistoryPanel />}
      </main>
    </div>
  );
}

function inputStyle() {
  return { padding: "6px 8px", border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 16 };
}
function tabBtnStyle(active) {
  return {
    padding: "8px 12px",
    borderRadius: 6,
    border: `1px solid ${active ? T.green : T.border}`,
    background: active ? T.green : "#fff",
    color: active ? "#fff" : T.textMain,
    fontSize: 13,
    cursor: "pointer",
  };
}

/* ============================= 原稿読み込み ============================= */
function ManuscriptPanel({ date, items, loading, onSaved }) {
  const [pasteText, setPasteText] = useState("");
  const [preview, setPreview] = useState(null); // { items, skippedLines }
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const handleExtract = () => {
    if (!pasteText.trim()) return;
    const result = extractKadokuraManuscriptItems(pasteText);
    setPreview({ ...result, rawText: pasteText });
  };

  const updatePreviewItem = (idx, patch) => {
    setPreview((prev) => {
      const items = prev.items.slice();
      items[idx] = { ...items[idx], ...patch };
      return { ...prev, items };
    });
  };

  const removePreviewItem = (idx) => {
    setPreview((prev) => {
      const items = prev.items.slice();
      items.splice(idx, 1);
      return { ...prev, items };
    });
  };

  const saveManuscript = async () => {
    if (!preview || preview.items.length === 0) return;
    setSaving(true);
    setErr("");
    try {
      const [batch] = await db.insert("manuscript_batches", {
        manuscript_date: date,
        source_type: "kadokura_paste",
        source_filename: "角倉原稿(貼り付け)",
        raw_grid_text: preview.rawText,
      });
      const rows = preview.items.map((it) => ({ ...it, batch_id: batch.id }));
      await db.insertMany("manuscript_items", rows);
      setPreview(null);
      setPasteText("");
      onSaved();
    } catch (e2) {
      setErr("保存に失敗しました: " + (e2.message || e2));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 style={h2()}>原稿読み込み（{date}）</h2>
      <p style={{ fontSize: 12, color: T.textSub, marginTop: -6, marginBottom: 12 }}>
        角倉の原稿テキストを貼り付けてください（案内生成アプリの「角倉」タブと同じ入力形式。磯崎・イチマル・荒木鮮魚は対象外です）。
      </p>

      <section style={card()}>
        <h3 style={h3()}>原稿テキストを貼り付け</h3>
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={"・白甘鯛\n和歌山\n1.5kg k12,000\n\n・メックリアジ兵庫(二見)\n1.5kg k1,200"}
          rows={10}
          style={{ width: "100%", fontFamily: "monospace", fontSize: 16, padding: 8, border: `1px solid ${T.border}`, borderRadius: 6 }}
        />
        <div style={{ marginTop: 8 }}>
          <button style={btn(true)} onClick={handleExtract}>解析する</button>
        </div>
      </section>

      {err && <div style={{ color: T.warn, marginBottom: 12 }}>{err}</div>}

      {preview && (
        <section style={card()}>
          <h3 style={h3()}>抽出結果プレビュー — {preview.items.length}件（内容を確認・修正してから保存してください）</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={table()}>
              <thead>
                <tr>
                  <th style={th()}>品目</th>
                  <th style={th()}>産地</th>
                  <th style={th()}>規格</th>
                  <th style={th()}>単価</th>
                  <th style={th()}>単位</th>
                  <th style={th()}></th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((it, idx) => (
                  <tr key={idx}>
                    <td style={td()}><input style={{ ...inputStyle(), width: 110 }} value={it.item_name} onChange={(e) => updatePreviewItem(idx, { item_name: e.target.value })} /></td>
                    <td style={td()}><input style={{ ...inputStyle(), width: 70 }} value={it.origin} onChange={(e) => updatePreviewItem(idx, { origin: e.target.value })} /></td>
                    <td style={td()}><input style={{ ...inputStyle(), width: 70 }} value={it.spec} onChange={(e) => updatePreviewItem(idx, { spec: e.target.value })} /></td>
                    <td style={td()}><input style={{ ...inputStyle(), width: 80 }} value={it.unit_price ?? ""} onChange={(e) => updatePreviewItem(idx, { unit_price: e.target.value ? parseFloat(e.target.value) : null })} /></td>
                    <td style={td()}>
                      <input
                        value={it.price_unit}
                        onChange={(e) => updatePreviewItem(idx, { price_unit: e.target.value })}
                        placeholder="kg/枚/尾..."
                        style={{ ...inputStyle(), width: 60, background: it.price_unit ? "#fff" : T.warnBg }}
                      />
                    </td>
                    <td style={td()}><button style={{ ...btn(), padding: "4px 8px" }} onClick={() => removePreviewItem(idx)}>削除</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.skippedLines.length > 0 && (
            <details style={{ marginTop: 8, fontSize: 12, color: T.textSub }}>
              <summary>自動抽出できなかった行・特殊フォーマット（{preview.skippedLines.length}件、手動で確認してください）</summary>
              <pre style={{ whiteSpace: "pre-wrap" }}>{preview.skippedLines.join("\n")}</pre>
            </details>
          )}
          <div style={{ marginTop: 12 }}>
            <button style={btn(true)} disabled={saving || preview.items.length === 0} onClick={saveManuscript}>
              {saving ? "保存中..." : `この${preview.items.length}件を原稿として保存`}
            </button>
          </div>
        </section>
      )}

      <section style={card()}>
        <h3 style={h3()}>{date} に保存済みの原稿商品（{items.length}件）</h3>
        {loading ? (
          <p>読み込み中...</p>
        ) : items.length === 0 ? (
          <p style={{ color: T.textSub, fontSize: 13 }}>この日の原稿はまだありません。</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={table()}>
              <thead>
                <tr>
                  <th style={th()}>品目</th>
                  <th style={th()}>産地</th>
                  <th style={th()}>規格</th>
                  <th style={th()}>単価</th>
                  <th style={th()}>単位</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td style={td()}>{it.item_name}</td>
                    <td style={td()}>{it.origin}</td>
                    <td style={td()}>{it.spec}</td>
                    <td style={td()}>{fmtYen(it.unit_price)}</td>
                    <td style={td()}>{it.price_unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function h2() {
  return { fontSize: 16, color: T.green, marginBottom: 12 };
}
function h3() {
  return { fontSize: 14, color: T.green, marginTop: 0 };
}
function card() {
  return { background: T.panel, border: `1px solid ${T.softBorder}`, borderRadius: 10, padding: 14, marginBottom: 16 };
}
function table() {
  return { width: "100%", borderCollapse: "collapse", fontSize: 13 };
}
function th() {
  return { textAlign: "left", padding: "6px 8px", borderBottom: `2px solid ${T.border}`, color: T.textSub, fontWeight: 600 };
}
function td() {
  return { padding: "6px 8px", borderBottom: `1px solid ${T.softBorder}` };
}
function btn(primary) {
  return {
    padding: "8px 14px",
    borderRadius: 6,
    border: `1px solid ${T.green}`,
    background: primary ? T.green : "#fff",
    color: primary ? "#fff" : T.green,
    fontSize: 13,
    cursor: "pointer",
  };
}

/* ============================= 発注一覧 ============================= */
function OrdersPanel({ date, orderLines, manuscriptItems, manuscriptItemById, onChanged }) {
  const [localLines, setLocalLines] = useState(orderLines);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLine, setNewLine] = useState(BLANK_NEW_LINE);
  const [showBulkForm, setShowBulkForm] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkPreview, setBulkPreview] = useState(null); // { rows, warnings }
  const [bulkIncluded, setBulkIncluded] = useState({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => setLocalLines(orderLines), [orderLines]);

  const patchLocal = (id, patch) => {
    setLocalLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };
  const saveField = async (id, patch) => {
    try {
      await db.update("order_lines", id, patch);
      onChanged();
    } catch (e) {
      setErr("保存に失敗しました: " + (e.message || e));
    }
  };

  const addOneLine = async () => {
    if (!newLine.item_name.trim()) {
      setErr("品目を入力してください");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const line_code = nextLineCode(date, orderLines.map((l) => l.line_code));
      await db.insert("order_lines", {
        ...newLine,
        order_date: date,
        line_code,
        quantity: newLine.quantity ? parseFloat(newLine.quantity) : null,
        delivery_date: newLine.delivery_date || null,
        takkyu_ship_date: newLine.takkyu_ship_date || null,
        takkyu_arrival_date: newLine.takkyu_arrival_date || null,
      });
      setNewLine(BLANK_NEW_LINE);
      setShowAddForm(false);
      onChanged();
    } catch (e) {
      setErr("追加に失敗しました: " + (e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const handleBulkParse = () => {
    if (!bulkText.trim()) return;
    const { rows, warnings } = parseShippingList(bulkText, date);
    setBulkPreview({ rows, warnings });
    const inc = {};
    rows.forEach((_, i) => { inc[i] = true; });
    setBulkIncluded(inc);
  };

  const commitBulk = async () => {
    if (!bulkPreview) return;
    const rows = bulkPreview.rows.filter((_, i) => bulkIncluded[i]);
    if (rows.length === 0) return;
    setBusy(true);
    setErr("");
    try {
      const existingCodes = orderLines.map((l) => l.line_code);
      const withCodes = rows.map((r) => {
        const code = nextLineCode(date, existingCodes);
        existingCodes.push(code);
        // order_lines テーブルに存在する列だけを送る（raw_line等の解析用の補助フィールドは含めない）
        return {
          order_date: date,
          line_code: code,
          delivery_date: r.delivery_date || null,
          delivery_time_note: r.delivery_time_note || "",
          destination: r.destination || "",
          item_name: r.item_name,
          origin: r.origin || "",
          quantity: r.quantity,
          quantity_unit: r.quantity_unit || "",
          weight: r.weight || "",
          request_note: r.request_note || "",
          delivery_category: r.delivery_category,
          takkyu_ship_date: r.takkyu_ship_date || null,
          takkyu_arrival_date: r.takkyu_arrival_date || null,
        };
      });
      await db.insertMany("order_lines", withCodes);
      setBulkText("");
      setBulkPreview(null);
      setShowBulkForm(false);
      onChanged();
    } catch (e) {
      setErr("一括追加に失敗しました: " + (e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const deleteLine = async (id) => {
    if (!confirm("この発注行を削除しますか？")) return;
    try {
      await db.remove("order_lines", id);
      onChanged();
    } catch (e) {
      setErr("削除に失敗しました: " + (e.message || e));
    }
  };

  const setManuscriptLink = (line, manuscriptItemId) => {
    patchLocal(line.id, { manuscript_item_id: manuscriptItemId || null, manuscript_price_status: manuscriptItemId ? "linked" : "none" });
    saveField(line.id, { manuscript_item_id: manuscriptItemId || null, manuscript_price_status: manuscriptItemId ? "linked" : "none" });
  };

  const grouped = { air: [], ground: [], takkyu: [] };
  localLines.forEach((l) => {
    (grouped[l.delivery_category] || grouped.ground).push(l);
  });

  const manuscriptOptions = manuscriptItems
    .slice()
    .sort((a, b) => a.item_name.localeCompare(b.item_name, "ja"))
    .map((it) => ({
      value: it.id,
      label: `${it.item_name}（${it.origin || "産地未記載"}）${it.spec ? " " + it.spec : ""} ${fmtYen(it.unit_price)}/${it.price_unit || "?"}`,
    }));

  const renderRow = (line) => {
    const mi = line.manuscript_item_id ? manuscriptItemById.get(line.manuscript_item_id) : null;
    const cmp = comparePrice(mi ? mi.unit_price : null, line.actual_unit_price != null ? Number(line.actual_unit_price) : null);
    const amountInfo = calcLineAmount({
      priceUnit: mi ? mi.price_unit : line.actual_unit_price_unit,
      unitPrice: line.actual_unit_price != null ? Number(line.actual_unit_price) : null,
      actualWeight: line.actual_weight != null ? Number(line.actual_weight) : null,
      actualQuantity: line.actual_quantity != null ? Number(line.actual_quantity) : (line.quantity != null ? Number(line.quantity) : null),
    });

    return (
      <tr key={line.id} style={{ background: cmp.status === "up" ? T.warnBg : "transparent" }}>
        <td style={td()}>
          <input type="checkbox" checked={!!line.shipped_checked} onChange={(e) => { patchLocal(line.id, { shipped_checked: e.target.checked }); saveField(line.id, { shipped_checked: e.target.checked }); }} />
        </td>
        <td style={td()}>
          <div style={{ fontSize: 11, color: T.textSub }}>{line.line_code}</div>
          <input style={{ ...inputStyle(), width: 90 }} value={line.item_name || ""} onChange={(e) => patchLocal(line.id, { item_name: e.target.value })} onBlur={(e) => saveField(line.id, { item_name: e.target.value })} />
        </td>
        <td style={td()}>
          <input style={{ ...inputStyle(), width: 70 }} value={line.origin || ""} onChange={(e) => patchLocal(line.id, { origin: e.target.value })} onBlur={(e) => saveField(line.id, { origin: e.target.value })} />
        </td>
        <td style={td()}>
          <input style={{ ...inputStyle(), width: 55 }} value={line.quantity ?? ""} onChange={(e) => patchLocal(line.id, { quantity: e.target.value })} onBlur={(e) => saveField(line.id, { quantity: e.target.value ? parseFloat(e.target.value) : null })} />
          <input style={{ ...inputStyle(), width: 40, marginLeft: 4 }} value={line.quantity_unit || ""} onChange={(e) => patchLocal(line.id, { quantity_unit: e.target.value })} onBlur={(e) => saveField(line.id, { quantity_unit: e.target.value })} />
        </td>
        <td style={td()}>
          <input style={{ ...inputStyle(), width: 60 }} value={line.weight || ""} onChange={(e) => patchLocal(line.id, { weight: e.target.value })} onBlur={(e) => saveField(line.id, { weight: e.target.value })} />
        </td>
        <td style={td()}>
          <input style={{ ...inputStyle(), width: 90 }} value={line.request_note || ""} onChange={(e) => patchLocal(line.id, { request_note: e.target.value })} onBlur={(e) => saveField(line.id, { request_note: e.target.value })} />
        </td>
        <td style={td()}>
          <select style={{ ...inputStyle(), maxWidth: 170 }} value={line.manuscript_item_id || ""} onChange={(e) => setManuscriptLink(line, e.target.value)}>
            <option value="">―原稿価格なし―</option>
            {manuscriptOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </td>
        <td style={td()}>
          <input style={{ ...inputStyle(), width: 55 }} placeholder="実目方" value={line.actual_weight ?? ""} onChange={(e) => patchLocal(line.id, { actual_weight: e.target.value })} onBlur={(e) => saveField(line.id, { actual_weight: e.target.value ? parseFloat(e.target.value) : null })} />
        </td>
        <td style={td()}>
          <input style={{ ...inputStyle(), width: 55 }} placeholder="実数量" value={line.actual_quantity ?? ""} onChange={(e) => patchLocal(line.id, { actual_quantity: e.target.value })} onBlur={(e) => saveField(line.id, { actual_quantity: e.target.value ? parseFloat(e.target.value) : null })} />
        </td>
        <td style={td()}>
          <input style={{ ...inputStyle(), width: 70 }} placeholder="実単価" value={line.actual_unit_price ?? ""} onChange={(e) => patchLocal(line.id, { actual_unit_price: e.target.value })} onBlur={(e) => saveField(line.id, { actual_unit_price: e.target.value ? parseFloat(e.target.value) : null })} />
        </td>
        <td style={td()}>
          {cmp.status === "up" && <span style={{ color: T.warn, fontWeight: 700 }}>⚠️ +{fmtYen(cmp.diff)}</span>}
          {cmp.status === "down" && <span style={{ color: T.textSub }}>{fmtYen(cmp.diff)}</span>}
          {cmp.status === "same" && <span style={{ color: T.ok }}>±0</span>}
          {cmp.status === "no_manuscript_price" && <span style={{ color: T.textSub }}>―</span>}
        </td>
        <td style={td()}>{amountInfo.amount != null ? fmtYen(amountInfo.amount) : ""}</td>
        <td style={td()}>
          <button style={{ ...btn(), padding: "4px 8px" }} onClick={() => deleteLine(line.id)}>削除</button>
        </td>
      </tr>
    );
  };

  const theadRow = (
    <tr>
      {["✓", "品目", "産地", "数量", "目方", "要望", "原稿単価", "実目方", "実数量", "実単価", "差額", "金額", ""].map((h) => (
        <th style={th()} key={h}>{h}</th>
      ))}
    </tr>
  );

  const renderSection = (label, lines) => (
    <section style={card()} key={label}>
      <h3 style={h3()}>{label}（{lines.length}件）</h3>
      {lines.length === 0 ? (
        <p style={{ color: T.textSub, fontSize: 13 }}>該当する発注はありません。</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={table()}>
            <thead>{theadRow}</thead>
            <tbody>{lines.map(renderRow)}</tbody>
          </table>
        </div>
      )}
    </section>
  );

  return (
    <div>
      <h2 style={h2()}>発注一覧（{date}）</h2>
      {err && <div style={{ color: T.warn, marginBottom: 12 }}>{err}</div>}

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button style={btn()} onClick={() => setShowAddForm((v) => !v)}>{showAddForm ? "閉じる" : "+ 発注行を1件追加"}</button>
        <button style={btn()} onClick={() => setShowBulkForm((v) => !v)}>{showBulkForm ? "閉じる" : "一括貼り付けで追加"}</button>
      </div>

      {showAddForm && (
        <section style={card()}>
          <h3 style={h3()}>発注行を追加</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <input style={inputStyle()} placeholder="品目" value={newLine.item_name} onChange={(e) => setNewLine((n) => ({ ...n, item_name: e.target.value }))} />
            <input style={inputStyle()} placeholder="産地" value={newLine.origin} onChange={(e) => setNewLine((n) => ({ ...n, origin: e.target.value }))} />
            <input style={inputStyle()} placeholder="数量" value={newLine.quantity} onChange={(e) => setNewLine((n) => ({ ...n, quantity: e.target.value }))} />
            <input style={{ ...inputStyle(), width: 60 }} placeholder="単位(本)" value={newLine.quantity_unit} onChange={(e) => setNewLine((n) => ({ ...n, quantity_unit: e.target.value }))} />
            <input style={inputStyle()} placeholder="目方(例:1.5kg)" value={newLine.weight} onChange={(e) => setNewLine((n) => ({ ...n, weight: e.target.value }))} />
            <input style={inputStyle()} placeholder="要望" value={newLine.request_note} onChange={(e) => setNewLine((n) => ({ ...n, request_note: e.target.value }))} />
            <input style={inputStyle()} placeholder="納品先" value={newLine.destination} onChange={(e) => setNewLine((n) => ({ ...n, destination: e.target.value }))} />
            <input type="date" style={inputStyle()} value={newLine.delivery_date} onChange={(e) => setNewLine((n) => ({ ...n, delivery_date: e.target.value }))} />
            <input style={{ ...inputStyle(), width: 90 }} placeholder="時間帯(午前中等)" value={newLine.delivery_time_note} onChange={(e) => setNewLine((n) => ({ ...n, delivery_time_note: e.target.value }))} />
            <select style={inputStyle()} value={newLine.delivery_category} onChange={(e) => setNewLine((n) => ({ ...n, delivery_category: e.target.value }))}>
              <option value="air">当日・航空便</option>
              <option value="ground">当日・配送便</option>
              <option value="takkyu">翌日着・宅急便</option>
            </select>
            {newLine.delivery_category === "takkyu" && (
              <>
                <input type="date" style={inputStyle()} value={newLine.takkyu_ship_date} onChange={(e) => setNewLine((n) => ({ ...n, takkyu_ship_date: e.target.value }))} />
                <input type="date" style={inputStyle()} value={newLine.takkyu_arrival_date} onChange={(e) => setNewLine((n) => ({ ...n, takkyu_arrival_date: e.target.value }))} />
              </>
            )}
          </div>
          <div style={{ marginTop: 8 }}>
            <button style={btn(true)} disabled={busy} onClick={addOneLine}>追加</button>
          </div>
        </section>
      )}

      {showBulkForm && (
        <section style={card()}>
          <h3 style={h3()}>発送リストを貼り付け</h3>
          <textarea style={{ width: "100%", fontFamily: "monospace", fontSize: 16, padding: 8, border: `1px solid ${T.border}`, borderRadius: 6 }} rows={10} value={bulkText} onChange={(e) => setBulkText(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            <button style={btn(true)} onClick={handleBulkParse}>解析する</button>
          </div>

          {bulkPreview && (
            <div style={{ marginTop: 16 }}>
              {bulkPreview.warnings.length > 0 && (
                <div style={{ color: T.warn, fontSize: 12, marginBottom: 8 }}>
                  {bulkPreview.warnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
                </div>
              )}
              <h4 style={{ fontSize: 13, margin: "8px 0" }}>抽出結果プレビュー — {bulkPreview.rows.length}件（内容を確認してから追加してください）</h4>
              <div style={{ overflowX: "auto" }}>
                <table style={table()}>
                  <thead>
                    <tr>
                      <th style={th()}>含める</th>
                      <th style={th()}>納品先</th>
                      <th style={th()}>品目</th>
                      <th style={th()}>産地</th>
                      <th style={th()}>数量</th>
                      <th style={th()}>要望</th>
                      <th style={th()}>区分</th>
                      <th style={th()}>納品日</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkPreview.rows.map((r, i) => (
                      <tr key={i}>
                        <td style={td()}><input type="checkbox" checked={!!bulkIncluded[i]} onChange={(e) => setBulkIncluded((prev) => ({ ...prev, [i]: e.target.checked }))} /></td>
                        <td style={td()}>{r.destination}</td>
                        <td style={td()}>{r.item_name}</td>
                        <td style={td()}>{r.origin}</td>
                        <td style={td()}>{r.quantity ?? ""}{r.quantity_unit}</td>
                        <td style={td()}>{r.request_note}</td>
                        <td style={td()}>{DELIVERY_CATEGORY_LABELS[r.delivery_category]}</td>
                        <td style={td()}>{r.delivery_date}{r.delivery_time_note ? ` ${r.delivery_time_note}` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 8 }}>
                <button style={btn(true)} disabled={busy} onClick={commitBulk}>
                  {busy ? "追加中..." : `選択した${Object.values(bulkIncluded).filter(Boolean).length}件を発注一覧に追加`}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      <h3 style={{ ...h3(), fontSize: 15, marginTop: 20 }}>当日納品</h3>
      {renderSection("航空便", grouped.air)}
      {renderSection("配送便", grouped.ground)}
      <h3 style={{ ...h3(), fontSize: 15, marginTop: 20 }}>翌日着・宅急便</h3>
      {renderSection("宅急便", grouped.takkyu)}
    </div>
  );
}

/* ============================= 納品書プレビュー（共通） ============================= */
function buildLineItemsForInvoice(lines, manuscriptItemById) {
  return lines.map((line) => {
    const mi = line.manuscript_item_id ? manuscriptItemById.get(line.manuscript_item_id) : null;
    const priceUnit = mi ? mi.price_unit : line.actual_unit_price_unit || "";
    const unitPrice = line.actual_unit_price != null ? Number(line.actual_unit_price) : null;
    const actualWeight = line.actual_weight != null ? Number(line.actual_weight) : null;
    const actualQuantity = line.actual_quantity != null ? Number(line.actual_quantity) : (line.quantity != null ? Number(line.quantity) : null);
    const { amount } = calcLineAmount({ priceUnit, unitPrice, actualWeight, actualQuantity });
    return {
      order_line_id: line.id,
      item_name: line.item_name,
      origin: line.origin,
      quantity: actualQuantity,
      quantity_unit: line.quantity_unit,
      weight: actualWeight,
      unit_price: unitPrice,
      price_unit: priceUnit,
      amount: amount || 0,
      delivery_category: line.delivery_category,
      takkyu_ship_date: line.takkyu_ship_date,
      takkyu_arrival_date: line.takkyu_arrival_date,
    };
  });
}

function InvoicePreview({ invoiceDate, destination, lineItems }) {
  const sameDay = lineItems.filter((li) => isSameDayCategory(li.delivery_category));
  const takkyu = lineItems.filter((li) => !isSameDayCategory(li.delivery_category));
  const totals = buildInvoiceTotals(lineItems);

  // 宅急便は発送日・着日の組み合わせごとにグループ化する
  const takkyuGroups = [];
  takkyu.forEach((li) => {
    const key = `${li.takkyu_ship_date || ""}__${li.takkyu_arrival_date || ""}`;
    let g = takkyuGroups.find((x) => x.key === key);
    if (!g) {
      g = { key, ship: li.takkyu_ship_date, arrival: li.takkyu_arrival_date, items: [] };
      takkyuGroups.push(g);
    }
    g.items.push(li);
  });

  const renderLine = (li, idx) => (
    <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0", borderBottom: "1px dashed #ddd" }}>
      <span>
        {li.item_name} {li.origin && `(${li.origin})`} {li.quantity ? `${li.quantity}${li.quantity_unit || ""}` : ""} {li.weight ? `${li.weight}kg` : ""}
      </span>
      <span>
        {li.unit_price ? `¥${li.unit_price.toLocaleString("ja-JP")}/${li.price_unit || ""}` : ""} {fmtYen(li.amount)}
      </span>
    </div>
  );

  return (
    <div style={{ width: 380, maxWidth: "100%", margin: "0 auto", background: "#fff", padding: 20, border: "1px solid #ccc", fontFamily: "system-ui, sans-serif", color: "#222" }}>
      <h2 style={{ fontSize: 16, textAlign: "center", margin: "0 0 4px" }}>納品書</h2>
      <p style={{ textAlign: "center", fontSize: 13, margin: "0 0 12px", color: "#555" }}>
        {formatMD(invoiceDate)}（{weekdayJa(invoiceDate)}）
      </p>
      <p style={{ fontSize: 14, fontWeight: 700, margin: "0 0 12px" }}>{destination} 様</p>

      {sameDay.map(renderLine)}

      {takkyuGroups.map((g) => (
        <div key={g.key}>
          <div style={{ borderTop: "1px dashed #999", margin: "10px 0 6px", paddingTop: 6, fontSize: 12, color: "#555" }}>
            宅急便 {formatMD(g.ship)}発送 → {formatMD(g.arrival)}着
          </div>
          {g.items.map(renderLine)}
        </div>
      ))}

      <div style={{ marginTop: 14, borderTop: "2px solid #333", paddingTop: 8, fontSize: 13 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}><span>商品合計</span><span>{fmtYen(totals.subtotal)}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between" }}><span>消費税(8%)</span><span>{fmtYen(totals.tax)}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 15, marginTop: 4 }}><span>税込合計</span><span>{fmtYen(totals.total)}</span></div>
      </div>
    </div>
  );
}

/* ============================= 納品書作成 ============================= */
function InvoicePanel({ date, orderLines, manuscriptItemById, onSaved }) {
  const destinations = useMemo(
    () => [...new Set(orderLines.map((l) => l.destination).filter(Boolean))],
    [orderLines]
  );
  const [destination, setDestination] = useState("");
  const [included, setIncluded] = useState({}); // id -> bool
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [savedInvoiceId, setSavedInvoiceId] = useState(null);
  const previewRef = useRef(null);

  useEffect(() => {
    if (!destination && destinations.length > 0) setDestination(destinations[0]);
  }, [destinations, destination]);

  const destLines = useMemo(() => orderLines.filter((l) => l.destination === destination), [orderLines, destination]);

  useEffect(() => {
    const next = {};
    destLines.forEach((l) => { next[l.id] = l.shipped_checked; });
    setIncluded(next);
    setSavedInvoiceId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, date]);

  const includedLines = destLines.filter((l) => included[l.id]);
  const lineItems = useMemo(() => buildLineItemsForInvoice(includedLines, manuscriptItemById), [includedLines, manuscriptItemById]);
  const totals = buildInvoiceTotals(lineItems);
  const warnCount = includedLines.filter((l) => {
    const mi = l.manuscript_item_id ? manuscriptItemById.get(l.manuscript_item_id) : null;
    return comparePrice(mi ? mi.unit_price : null, l.actual_unit_price != null ? Number(l.actual_unit_price) : null).status === "up";
  }).length;

  const saveInvoice = async () => {
    if (includedLines.length === 0 || !destination) return;
    setSaving(true);
    setErr("");
    try {
      const [invoice] = await db.insert("invoices", {
        invoice_date: date,
        destination,
        subtotal: totals.subtotal,
        tax: totals.tax,
        total: totals.total,
      });
      const rows = lineItems.map((li, idx) => ({ ...li, invoice_id: invoice.id, sort_order: idx }));
      await db.insertMany("invoice_line_items", rows);
      await Promise.all(includedLines.map((l) => db.update("order_lines", l.id, { invoice_id: invoice.id })));
      setSavedInvoiceId(invoice.id);
      onSaved();
    } catch (e) {
      setErr("納品書の保存に失敗しました: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  const downloadImage = async () => {
    if (!previewRef.current) return;
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(previewRef.current, { backgroundColor: "#fff", scale: 2 });
      const link = document.createElement("a");
      link.download = `納品書_${date}_${destination}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } catch (e) {
      setErr("画像出力に失敗しました: " + (e.message || e));
    }
  };

  return (
    <div>
      <h2 style={h2()}>納品書作成（{date}）</h2>
      {err && <div style={{ color: T.warn, marginBottom: 12 }}>{err}</div>}

      <section style={card()}>
        <label style={{ fontSize: 13, marginRight: 8 }}>納品先:</label>
        <select style={inputStyle()} value={destination} onChange={(e) => setDestination(e.target.value)}>
          {destinations.length === 0 && <option value="">（この日の発注に納品先がありません）</option>}
          {destinations.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>

        {warnCount > 0 && (
          <div style={{ marginTop: 10, color: T.warn, fontSize: 13 }}>⚠️ 原稿より高くなった商品が{warnCount}件含まれています。</div>
        )}

        <h3 style={{ ...h3(), marginTop: 14 }}>含める発注行</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={table()}>
            <thead>
              <tr>
                <th style={th()}>含める</th>
                <th style={th()}>品目</th>
                <th style={th()}>産地</th>
                <th style={th()}>数量/目方</th>
                <th style={th()}>単価</th>
                <th style={th()}>金額</th>
              </tr>
            </thead>
            <tbody>
              {destLines.map((l) => {
                const li = buildLineItemsForInvoice([l], manuscriptItemById)[0];
                return (
                  <tr key={l.id}>
                    <td style={td()}><input type="checkbox" checked={!!included[l.id]} onChange={(e) => setIncluded((prev) => ({ ...prev, [l.id]: e.target.checked }))} /></td>
                    <td style={td()}>{l.item_name}</td>
                    <td style={td()}>{l.origin}</td>
                    <td style={td()}>{li.quantity ?? ""}{li.quantity_unit} {li.weight ? `/ ${li.weight}kg` : ""}</td>
                    <td style={td()}>{li.unit_price ? `¥${li.unit_price.toLocaleString("ja-JP")}/${li.price_unit}` : "未入力"}</td>
                    <td style={td()}>{fmtYen(li.amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {destination && includedLines.length > 0 && (
        <section style={card()}>
          <h3 style={h3()}>プレビュー</h3>
          <div ref={previewRef}>
            <InvoicePreview invoiceDate={date} destination={destination} lineItems={lineItems} />
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "center" }}>
            <button style={btn(true)} disabled={saving || !!savedInvoiceId} onClick={saveInvoice}>
              {savedInvoiceId ? "保存済み" : saving ? "保存中..." : "納品書を確定して保存"}
            </button>
            <button style={btn()} onClick={downloadImage}>PNG画像として保存</button>
          </div>
        </section>
      )}
    </div>
  );
}

/* ============================= 納品書履歴 ============================= */
function HistoryPanel() {
  const [startDate, setStartDate] = useState(todayStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState(null); // invoice row
  const [selectedItems, setSelectedItems] = useState([]);
  const previewRef = useRef(null);

  const search = useCallback(async () => {
    setLoading(true);
    setErr("");
    setSelected(null);
    try {
      const rows = await db.list(
        "invoices",
        `?invoice_date=gte.${startDate}&invoice_date=lte.${endDate}&order=invoice_date.desc,destination.asc`
      );
      setInvoices(rows);
    } catch (e) {
      setErr("検索に失敗しました: " + (e.message || e));
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => { search(); }, [search]);

  const openInvoice = async (inv) => {
    setSelected(inv);
    setSelectedItems([]);
    try {
      const items = await db.list("invoice_line_items", `?invoice_id=eq.${inv.id}&order=sort_order.asc`);
      setSelectedItems(items);
    } catch (e) {
      setErr("納品書明細の取得に失敗しました: " + (e.message || e));
    }
  };

  const downloadImage = async () => {
    if (!previewRef.current || !selected) return;
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(previewRef.current, { backgroundColor: "#fff", scale: 2 });
      const link = document.createElement("a");
      link.download = `納品書_${selected.invoice_date}_${selected.destination}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } catch (e) {
      setErr("画像出力に失敗しました: " + (e.message || e));
    }
  };

  const grouped = [];
  invoices.forEach((inv) => {
    let g = grouped.find((x) => x.date === inv.invoice_date);
    if (!g) { g = { date: inv.invoice_date, invoices: [] }; grouped.push(g); }
    g.invoices.push(inv);
  });

  return (
    <div>
      <h2 style={h2()}>納品書履歴</h2>
      {err && <div style={{ color: T.warn, marginBottom: 12 }}>{err}</div>}

      <section style={card()}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="date" style={inputStyle()} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <span>〜</span>
          <input type="date" style={inputStyle()} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          <button style={btn(true)} onClick={search}>検索</button>
        </div>
      </section>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <section style={{ ...card(), flex: "1 1 280px" }}>
          {loading ? (
            <p>読み込み中...</p>
          ) : grouped.length === 0 ? (
            <p style={{ color: T.textSub, fontSize: 13 }}>該当する納品書はありません。</p>
          ) : (
            grouped.map((g) => (
              <div key={g.date} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.green, marginBottom: 4 }}>
                  {g.date}（{weekdayJa(g.date)}）
                </div>
                {g.invoices.map((inv) => (
                  <div
                    key={inv.id}
                    onClick={() => openInvoice(inv)}
                    style={{
                      display: "flex", justifyContent: "space-between", padding: "6px 8px",
                      borderRadius: 6, cursor: "pointer", fontSize: 13,
                      background: selected && selected.id === inv.id ? T.panel : "transparent",
                    }}
                  >
                    <span>{inv.destination}</span>
                    <span>{fmtYen(inv.total)}</span>
                  </div>
                ))}
              </div>
            ))
          )}
        </section>

        {selected && (
          <section style={{ ...card(), flex: "1 1 400px" }}>
            <div ref={previewRef}>
              <InvoicePreview invoiceDate={selected.invoice_date} destination={selected.destination} lineItems={selectedItems} />
            </div>
            <div style={{ marginTop: 12, textAlign: "center" }}>
              <button style={btn()} onClick={downloadImage}>PNG画像として保存</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
