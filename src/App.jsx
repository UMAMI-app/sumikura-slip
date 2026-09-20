import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import { db, isSupabaseConfigured } from "./lib/supabase";
import { extractKadokuraManuscriptItems } from "./lib/manuscriptKadokura";
import { parseShippingList, cleanDestinationName } from "./lib/shippingList";
import { parseLineShipmentText, buildLineActualRows } from "./lib/lineShipment";
import { parseManuscriptPurchaseText } from "./lib/manuscriptPurchase";
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
  bg: "#f7f7f3",
  panel: "#ffffff",
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
  const [selectedDate] = useState(todayStr()); // 発注一覧・原稿読込・納品書作成は常に「今日」を対象にする（過去の振り返りは納品書履歴で行う）
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
    const lines = await db.list("order_lines", `?order_date=eq.${date}&order=created_at.asc,id.asc`);
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
      <header style={{ padding: "10px 16px 14px", borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontSize: 12, color: T.textSub }}>
          {selectedDate}（{weekdayJa(selectedDate)}）{" "}
          {manuscriptBatches.length > 0 && `原稿${manuscriptBatches.length}件読込済`}
        </span>
        <nav style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {[
            ["manuscript", "原稿"],
            ["orders", "発注"],
            ["pricecheck", "チェック"],
            ["invoice", "納品書"],
            ["history", "履歴"],
          ].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{ ...tabBtnStyle(tab === key), flex: 1 }}>
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
            onChanged={() => loadOrderLines(selectedDate).catch((e) => setGlobalError(e.message || String(e)))}
          />
        )}
        {tab === "pricecheck" && (
          <PriceCheckPanel
            date={selectedDate}
            orderLines={orderLines}
            manuscriptItems={manuscriptItems}
            manuscriptItemById={manuscriptItemById}
            onChanged={() => loadOrderLines(selectedDate).catch((e) => setGlobalError(e.message || String(e)))}
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
  return { padding: "6px 8px", border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 16, background: "#fff", color: T.textMain };
}
function tabBtnStyle(active) {
  return {
    padding: "9px 4px",
    borderRadius: 6,
    border: `1px solid ${active ? T.green : T.border}`,
    background: active ? T.green : "#fff",
    color: active ? "#fff" : T.textMain,
    fontSize: 12,
    whiteSpace: "nowrap",
    textAlign: "center",
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
  return { padding: "6px 8px", borderBottom: `1px solid ${T.softBorder}`, verticalAlign: "top" };
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

function combinedQtyText(line) {
  return `${line.quantity ?? ""}${line.quantity_unit ? " " + line.quantity_unit : ""}`.trim();
}

// 品目欄に「10尾」「3パック」のように数字+単位が含まれていたら、
// それを数量欄用に抜き出し、品目からは取り除く。
const ITEM_NAME_QTY_UNITS = ["本", "尾", "パック", "枚", "個", "杯", "pc"];
const ITEM_NAME_QTY_RE = new RegExp(
  `([\d]+(?:\.[\d]+)?)\s*(${ITEM_NAME_QTY_UNITS.join("|")})`,
  "i"
);
function extractQtyFromItemName(name) {
  if (!name) return null;
  const m = name.match(ITEM_NAME_QTY_RE);
  if (!m) return null;
  const quantity = parseFloat(m[1]);
  const quantity_unit = m[2];
  const cleanedName = (name.slice(0, m.index) + name.slice(m.index + m[0].length))
    .replace(/\s{2,}/g, " ")
    .trim();
  return { cleanedName, quantity, quantity_unit };
}

// 数量と単位をまとめて1つの入力欄で編集する（例:「10 尾」「1.5 kg」）。
// フォーカスを外した時に、先頭の数値部分と残りの単位部分に分解して保存する。
function QtyInput({ line, patchLocal, saveField, fontSize, width }) {
  const [text, setText] = useState(combinedQtyText(line));

  useEffect(() => {
    setText(combinedQtyText(line));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.quantity, line.quantity_unit]);

  const commit = () => {
    const m = text.trim().match(/^([\d.]+)?\s*(.*)$/);
    const quantity = m && m[1] ? parseFloat(m[1]) : null;
    const quantity_unit = m ? m[2].trim() : "";
    patchLocal(line.id, { quantity, quantity_unit });
    saveField(line.id, { quantity, quantity_unit });
  };

  return (
    <input
      style={{ ...inputStyle(), width: width || 90, fontSize: fontSize || 16 }}
      placeholder="例: 10尾"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
    />
  );
}

/* ============================= 発注一覧 ============================= */
function OrdersPanel({ date, orderLines, onChanged }) {
  const [localLines, setLocalLines] = useState(orderLines);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLine, setNewLine] = useState(BLANK_NEW_LINE);
  const [showBulkForm, setShowBulkForm] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkPreview, setBulkPreview] = useState(null); // { rows, warnings }
  const [bulkIncluded, setBulkIncluded] = useState({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // 削除確認をブラウザのconfirm()に頼らず画面内で行う（iOSでconfirm/alertを連発すると
  // 「このページでのダイアログ表示を停止」が働いてしまい、以降ボタンが反応しなくなるため）。
  // "__ALL__"は全削除ボタン用の特別なID。1回目のタップで確認状態にし、一定時間経ってから
  // 同じボタンをもう一度タップした時だけ実行する（誤タップ・連続タップでの誤削除を防ぐ）。
  const [confirmId, setConfirmId] = useState(null);
  const [confirmAt, setConfirmAt] = useState(0);
  const CONFIRM_MIN_MS = 400;

  useEffect(() => setLocalLines(orderLines), [orderLines]);

  const patchLocal = (id, patch) => {
    setLocalLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };
  const saveField = async (id, patch) => {
    // patchLocalで既に画面には反映済みなので、ここではDBへの保存のみ行う。
    // 毎回onChanged()で全件再取得すると、created_atが同じ行が並び替わってしまい
    // 「入力するたびに店舗の順番が変わる」原因になっていたため、再取得はしない。
    try {
      await db.update("order_lines", id, patch);
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

  const clearAllToday = async () => {
    const now = Date.now();
    if (confirmId !== "__ALL__") {
      setConfirmId("__ALL__");
      setConfirmAt(now);
      return;
    }
    if (now - confirmAt < CONFIRM_MIN_MS) return; // 連続タップでの誤削除を防ぐ
    setConfirmId(null);
    try {
      await db.removeWhere("order_lines", `?order_date=eq.${date}`);
      setLocalLines([]);
      onChanged();
    } catch (e) {
      setErr("全削除に失敗しました: " + (e.message || e));
    }
  };

  const deleteLine = async (id) => {
    // 1回目のタップで確認状態にし、少し間を置いてから同じ行をもう一度タップしたら実削除する。
    const now = Date.now();
    if (confirmId !== id) {
      setConfirmId(id);
      setConfirmAt(now);
      return;
    }
    if (now - confirmAt < CONFIRM_MIN_MS) return; // 連続タップでの誤削除を防ぐ
    setConfirmId(null);
    // 即座に画面から消す（サーバー往復や再取得を待たない）。
    // 失敗した場合はonChangedで再取得され、消えていたら元に戻る。
    setLocalLines((prev) => prev.filter((l) => l.id !== id));
    try {
      await db.remove("order_lines", id);
      onChanged();
    } catch (e) {
      setErr("削除に失敗しました: " + (e.message || e));
      onChanged();
    }
  };

  const grouped = { air: [], ground: [], takkyu: [] };
  localLines.forEach((l) => {
    (grouped[l.delivery_category] || grouped.ground).push(l);
  });

  const rowFontSize = 13;

  // 各品目ごとに削除ボタンを表示（その行だけを削除）
  const renderRow = (line, isFirst, destName, destLines) => {
    const isShippingFee = /^送料/.test(line.item_name || "");
    return (
    <Fragment key={line.id}>
      <tr>
        {isShippingFee ? (
          <td colSpan={3} style={{ ...td(), borderBottom: "none", paddingBottom: 4 }}>
            <input
              style={{ ...inputStyle(), width: "100%", fontSize: rowFontSize }}
              value={line.item_name || ""}
              onChange={(e) => patchLocal(line.id, { item_name: e.target.value })}
              onBlur={(e) => saveField(line.id, { item_name: e.target.value })}
            />
          </td>
        ) : (
          <>
            <td style={{ ...td(), borderBottom: "none", paddingBottom: 4, textAlign: "center" }}>
              <input
                type="checkbox"
                checked={!!line.shipped_checked}
                onChange={(e) => { patchLocal(line.id, { shipped_checked: e.target.checked }); saveField(line.id, { shipped_checked: e.target.checked }); }}
                style={{ width: 26, height: 64, accentColor: "red", cursor: "pointer" }}
              />
            </td>
            <td style={{ ...td(), borderBottom: "none", paddingBottom: 4, paddingLeft: 24 }}>
              <input
                style={{ ...inputStyle(), width: "100%", fontSize: rowFontSize }}
                value={line.item_name || ""}
                onChange={(e) => patchLocal(line.id, { item_name: e.target.value })}
                onBlur={(e) => {
                  const value = e.target.value;
                  const extracted = extractQtyFromItemName(value);
                  if (extracted) {
                    const patch = { item_name: extracted.cleanedName, quantity: extracted.quantity, quantity_unit: extracted.quantity_unit };
                    patchLocal(line.id, patch);
                    saveField(line.id, patch);
                  } else {
                    saveField(line.id, { item_name: value });
                  }
                }}
              />
              <input style={{ ...inputStyle(), width: "100%", marginTop: 4, fontSize: rowFontSize, color: T.textSub }} placeholder="産地" value={line.origin || ""} onChange={(e) => patchLocal(line.id, { origin: e.target.value })} onBlur={(e) => saveField(line.id, { origin: e.target.value })} />
            </td>
            <td style={{ ...td(), borderBottom: "none", paddingBottom: 4 }}>
              <QtyInput line={line} patchLocal={patchLocal} saveField={saveField} fontSize={rowFontSize} width="100%" />
              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                <input
                  style={{ ...inputStyle(), padding: "6px 4px", flex: "1 1 auto", minWidth: 0, fontSize: rowFontSize }}
                  placeholder="目方"
                  value={line.actual_weight ?? ""}
                  onChange={(e) => patchLocal(line.id, { actual_weight: e.target.value })}
                  onBlur={(e) => saveField(line.id, { actual_weight: e.target.value ? parseFloat(e.target.value) : null })}
                />
                <input
                  style={{ ...inputStyle(), padding: "6px 4px", flex: "0 0 32px", width: 32, fontSize: rowFontSize }}
                  placeholder="kg"
                  value={line.actual_weight_unit ?? ""}
                  onChange={(e) => patchLocal(line.id, { actual_weight_unit: e.target.value })}
                  onBlur={(e) => saveField(line.id, { actual_weight_unit: e.target.value })}
                />
              </div>
            </td>
          </>
        )}
      </tr>
      <tr>
        <td style={{ ...td(), borderBottom: "none", paddingTop: 0, paddingBottom: 8, textAlign: "center" }}>
          <button
            style={{
              ...btn(),
              width: "100%",
              minHeight: 40,
              padding: "8px 0",
              fontSize: 12,
              fontWeight: 600,
              touchAction: "manipulation",
              ...(confirmId === line.id ? { background: T.warn, borderColor: T.warn, color: "#fff" } : {}),
            }}
            onClick={() => deleteLine(line.id)}
          >
            {confirmId === line.id ? "確定" : "削除"}
          </button>
        </td>
        <td colSpan={2} style={{ ...td(), borderBottom: "none", paddingTop: 0, paddingBottom: 8, paddingLeft: 24 }}>
          <textarea
            rows={2}
            style={{ ...inputStyle(), width: "100%", fontSize: rowFontSize, lineHeight: 1.4, resize: "vertical", fontFamily: "inherit" }}
            placeholder="要望"
            value={line.request_note || ""}
            onChange={(e) => patchLocal(line.id, { request_note: e.target.value })}
            onBlur={(e) => saveField(line.id, { request_note: e.target.value })}
          />
        </td>
      </tr>
    </Fragment>
    );
  };

  // 店舗（納品先）ごとにグループ化して表示する（発送作業時にどの店舗の分か分かりやすくするため）
  const groupByDestination = (lines) => {
    const map = new Map();
    const order = [];
    lines.forEach((l) => {
      const key = cleanDestinationName(l.destination) || "（納品先未設定）";
      if (!map.has(key)) { map.set(key, []); order.push(key); }
      map.get(key).push(l);
    });
    // 送料は商品の後ろに来るように並べ替える（それ以外の順序は変えない）
    const isShippingFee = (l) => /^送料/.test(l.item_name || "");
    return order.map((destName) => ({
      destName,
      destLines: [...map.get(destName)].sort((a, b) => Number(isShippingFee(a)) - Number(isShippingFee(b))),
    }));
  };

  const renderSection = (label, lines, opts = {}) => (
    <section style={card()} key={label}>
      <h3 style={h3()}>{opts.countOnly ? `${lines.length}件` : `${label}（${lines.length}件）`}</h3>
      {lines.length === 0 ? (
        <p style={{ color: T.textSub, fontSize: 13 }}>該当する発注はありません。</p>
      ) : (
        <div style={{ overflowX: "hidden" }}>
          <table style={{ ...table(), tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "10%" }} />
              <col style={{ width: "62%" }} />
              <col style={{ width: "27%" }} />
            </colgroup>
            <tbody>
              {groupByDestination(lines).map(({ destName, destLines }, gi) => (
                <Fragment key={destName}>
                  <tr>
                    <td colSpan={3} style={{ padding: gi === 0 ? "10px 8px 6px" : "18px 8px 6px", fontWeight: 700, fontSize: 15, borderBottom: `1px solid ${T.border}`, wordBreak: "break-word" }}>
                      {destName}
                    </td>
                  </tr>
                  {destLines.map((line, idx) => renderRow(line, idx === 0, destName, destLines))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );

  return (
    <div>
      <h2 style={h2()}>発注一覧（{date}）</h2>
      {err && <div style={{ color: T.warn, marginBottom: 12 }}>{err}</div>}

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button style={btn()} onClick={() => setShowAddForm((v) => !v)}>{showAddForm ? "閉じる" : "+ 発注行を1件追加"}</button>
        <button style={btn()} onClick={() => setShowBulkForm((v) => !v)}>{showBulkForm ? "閉じる" : "一括貼り付けで追加"}</button>
        <button
          style={{
            ...btn(),
            marginLeft: "auto",
            color: confirmId === "__ALL__" ? "#fff" : T.warn,
            borderColor: T.warn,
            background: confirmId === "__ALL__" ? T.warn : "#fff",
          }}
          onClick={clearAllToday}
        >
          {confirmId === "__ALL__" ? "本当に全削除する（もう一度タップ）" : "本日分を全削除（テスト用）"}
        </button>
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
              <option value="air">当日・航空便✈️</option>
              <option value="ground">当日・配送便🚛</option>
              <option value="takkyu">宅急便📦</option>
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
                        <td style={td()}>
                          {r.item_name}
                          {r.origin && <div style={{ fontSize: 11, color: T.textSub }}>{r.origin}</div>}
                        </td>
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
      {renderSection(DELIVERY_CATEGORY_LABELS.air, grouped.air)}
      {renderSection(DELIVERY_CATEGORY_LABELS.ground, grouped.ground)}
      <h3 style={{ ...h3(), fontSize: 15, marginTop: 20 }}>{DELIVERY_CATEGORY_LABELS.takkyu}</h3>
      {renderSection(DELIVERY_CATEGORY_LABELS.takkyu, grouped.takkyu, { countOnly: true })}
    </div>
  );
}

/* ============================= 価格チェック ============================= */
// 原稿価格の紐付け・実単価の入力・差額確認はここで行う（発送作業時に見る発注一覧とは分離）。
// 詳細仕様は追って調整予定。今は発注一覧から移設した最小限の機能のみ。
function PriceCheckPanel({ date, orderLines, manuscriptItems, manuscriptItemById, onChanged }) {
  const [localLines, setLocalLines] = useState(orderLines);
  const [err, setErr] = useState("");

  useEffect(() => setLocalLines(orderLines), [orderLines]);

  const patchLocal = (id, patch) => {
    setLocalLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };
  const saveField = async (id, patch) => {
    // patchLocalで既に画面には反映済みなので、ここではDBへの保存のみ行う。
    // 毎回onChanged()で全件再取得すると、created_atが同じ行が並び替わってしまい
    // 「入力するたびに店舗の順番が変わる」原因になっていたため、再取得はしない。
    try {
      await db.update("order_lines", id, patch);
    } catch (e) {
      setErr("保存に失敗しました: " + (e.message || e));
    }
  };

  const setManuscriptLink = (line, manuscriptItemId) => {
    patchLocal(line.id, { manuscript_item_id: manuscriptItemId || null, manuscript_price_status: manuscriptItemId ? "linked" : "none" });
    saveField(line.id, { manuscript_item_id: manuscriptItemId || null, manuscript_price_status: manuscriptItemId ? "linked" : "none" });
  };

  const manuscriptOptions = manuscriptItems
    .slice()
    .sort((a, b) => a.item_name.localeCompare(b.item_name, "ja"))
    .map((it) => ({
      value: it.id,
      label: `${it.item_name}（${it.origin || "産地未記載"}）${it.spec ? " " + it.spec : ""} ${fmtYen(it.unit_price)}/${it.price_unit || "?"}`,
    }));

  const renderRow = (line) => {
    const mi = line.manuscript_item_id ? manuscriptItemById.get(line.manuscript_item_id) : null;
    const cmp = comparePrice({
      manuscriptPrice: mi ? mi.unit_price : null,
      manuscriptUnit: mi ? mi.price_unit : null,
      actualPrice: line.actual_unit_price != null ? Number(line.actual_unit_price) : null,
      actualUnit: line.actual_unit_price_unit || null,
    });
    const amountInfo = calcLineAmount({
      priceUnit: mi ? mi.price_unit : line.actual_unit_price_unit,
      unitPrice: line.actual_unit_price != null ? Number(line.actual_unit_price) : null,
      actualWeight: line.actual_weight != null ? Number(line.actual_weight) : null,
      actualQuantity: line.actual_quantity != null ? Number(line.actual_quantity) : (line.quantity != null ? Number(line.quantity) : null),
    });

    return (
      <tr key={line.id} style={{ background: cmp.status === "up" ? T.warnBg : "transparent" }}>
        <td style={td()}>
          {line.item_name}
          {line.origin && <div style={{ fontSize: 11, color: T.textSub }}>{line.origin}</div>}
        </td>
        <td style={td()}>{combinedQtyText(line)}</td>
        <td style={td()}>
          <select style={{ ...inputStyle(), maxWidth: 170 }} value={line.manuscript_item_id || ""} onChange={(e) => setManuscriptLink(line, e.target.value)}>
            <option value="">―原稿価格なし―</option>
            {manuscriptOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </td>
        <td style={td()}>
          <div style={{ display: "flex", gap: 4 }}>
            <input style={{ ...inputStyle(), width: 70 }} placeholder="実単価" value={line.actual_unit_price ?? ""} onChange={(e) => patchLocal(line.id, { actual_unit_price: e.target.value })} onBlur={(e) => saveField(line.id, { actual_unit_price: e.target.value ? parseFloat(e.target.value) : null })} />
            <input style={{ ...inputStyle(), width: 44 }} placeholder="単位" value={line.actual_unit_price_unit ?? ""} onChange={(e) => patchLocal(line.id, { actual_unit_price_unit: e.target.value })} onBlur={(e) => saveField(line.id, { actual_unit_price_unit: e.target.value })} />
          </div>
        </td>
        <td style={td()}>
          {cmp.status === "up" && <span style={{ color: T.warn, fontWeight: 700 }}>⚠️ +{fmtYen(cmp.diff)}</span>}
          {cmp.status === "down" && <span style={{ color: T.textSub }}>{fmtYen(cmp.diff)}</span>}
          {cmp.status === "same" && <span style={{ color: T.ok }}>±0</span>}
          {cmp.status === "no_manuscript_price" && <span style={{ color: T.textSub }}>―</span>}
          {cmp.status === "unit_unknown" && <span style={{ color: T.textSub, fontSize: 11 }}>単位未確認</span>}
          {cmp.status === "unit_mismatch" && (
            <span style={{ color: T.warn, fontSize: 11 }}>
              ⚠️単位不一致（原稿:{cmp.manuscriptUnit} / 実績:{cmp.actualUnit}）
            </span>
          )}
        </td>
        <td style={td()}>{amountInfo.amount != null ? fmtYen(amountInfo.amount) : ""}</td>
      </tr>
    );
  };

  return (
    <div>
      <h2 style={h2()}>価格チェック（{date}）</h2>
      {err && <div style={{ color: T.warn, marginBottom: 12 }}>{err}</div>}

      <ManuscriptPurchasePaste date={date} />
      <LineActualPaste date={date} />

      <section style={card()}>
        <h3 style={h3()}>③ 発注一覧との価格チェック（原稿読み込みタブで紐付け）</h3>
        {localLines.length === 0 ? (
          <p style={{ color: T.textSub, fontSize: 13 }}>発注はありません。</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={table()}>
              <thead>
                <tr>
                  {["品目", "数量", "原稿単価", "実単価", "差額", "金額"].map((h) => (
                    <th style={th()} key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>{localLines.map(renderRow)}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/* ----- ① 原稿を貼り付け（ブロック形式・新方式。manuscriptKadokura.jsの角倉タブ形式とは別物） ----- */
function ManuscriptPurchasePaste({ date }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(null); // { items: [...key付き], warnings }
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState([]);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [unitMap, setUnitMap] = useState({});

  const loadSaved = useCallback(async () => {
    setLoadingSaved(true);
    try {
      const rows = await db.list("manuscript_purchase_items", `?manuscript_date=eq.${date}&order=created_at.asc`);
      setSaved(rows);
    } catch (e) {
      setErr("読み込みに失敗しました: " + (e.message || e));
    } finally {
      setLoadingSaved(false);
    }
  }, [date]);

  const loadUnitMap = useCallback(async () => {
    try {
      const rows = await db.list("product_price_units");
      const m = {};
      rows.forEach((r) => { m[r.item_name] = r.default_unit; });
      setUnitMap(m);
    } catch (e) {
      // 学習データが読めなくても致命的ではないため、原則ルールのみで単位を推測させる
    }
  }, []);

  useEffect(() => { loadSaved(); }, [loadSaved]);
  useEffect(() => { loadUnitMap(); }, [loadUnitMap]);

  const handleParse = () => {
    if (!text.trim()) return;
    const { items, warnings } = parseManuscriptPurchaseText(text, unitMap);
    setPreview({ items: items.map((it, idx) => ({ key: idx, ...it })), warnings });
  };

  const updateItem = (key, patch) => {
    setPreview((prev) => ({ ...prev, items: prev.items.map((it) => (it.key === key ? { ...it, ...patch } : it)) }));
  };

  const handleConfirm = async () => {
    if (!preview || preview.items.length === 0) return;
    setSaving(true);
    setErr("");
    try {
      const payload = preview.items.map((it) => ({
        manuscript_date: date,
        is_shipping_fee: it.kind === "shipping",
        item_name: it.item_name || "",
        origin: it.origin || "",
        spec: it.spec || "",
        quantity: it.quantity,
        quantity_unit: it.quantity_unit || "",
        actual_weight: it.actual_weight,
        actual_weight_unit: it.actual_weight_unit || "",
        purchase_price: it.purchase_price,
        purchase_price_unit: it.purchase_price_unit || "",
        purchase_amount: it.purchase_amount,
        selling_price: it.selling_price,
        selling_price_unit: it.selling_price_unit || "",
        selling_price_source: it.selling_price_source || null,
        shipping_fee: it.shipping_fee,
        shipping_note: it.shipping_note || "",
        note: it.note || "",
        raw_line: it.raw_line,
      }));
      await db.insertMany("manuscript_purchase_items", payload);

      // 商品ごとの単価単位を学習・更新する（改修指示書6章）。
      const learned = new Map();
      preview.items.forEach((it) => {
        if (it.kind === "item" && it.item_name && it.purchase_price_unit) {
          learned.set(it.item_name, it.purchase_price_unit);
        }
      });
      await Promise.all(
        Array.from(learned.entries()).map(([name, unit]) =>
          db.upsertByKey("product_price_units", "item_name", name, { default_unit: unit, updated_at: new Date().toISOString() }).catch(() => {})
        )
      );

      setPreview(null);
      setText("");
      await loadSaved();
      await loadUnitMap();
    } catch (e) {
      setErr("原稿の保存に失敗しました: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSaved = async (id) => {
    setSaved((prev) => prev.filter((r) => r.id !== id));
    try {
      await db.remove("manuscript_purchase_items", id);
    } catch (e) {
      setErr("削除に失敗しました: " + (e.message || e));
      loadSaved();
    }
  };

  const renderPreviewItem = (it) => {
    if (it.kind === "shipping") {
      return (
        <div key={it.key} style={{ ...card(), marginBottom: 8, padding: 10, background: "#f3f3f3" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 13 }}>送料</strong>
            <input
              style={{ ...inputStyle(), width: 120 }}
              placeholder="備考（箱代含む等）"
              value={it.shipping_note ?? ""}
              onChange={(e) => updateItem(it.key, { shipping_note: e.target.value })}
            />
            <label style={{ fontSize: 11, color: T.textSub }}>
              金額
              <input
                style={{ ...inputStyle(), width: 80, marginLeft: 4 }}
                value={it.shipping_fee ?? ""}
                onChange={(e) => updateItem(it.key, { shipping_fee: e.target.value ? parseFloat(e.target.value) : null })}
              />
            </label>
          </div>
        </div>
      );
    }
    return (
      <div key={it.key} style={{ ...card(), marginBottom: 8, padding: 10 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
          <input style={{ ...inputStyle(), width: 130, fontWeight: 600 }} value={it.item_name ?? ""} onChange={(e) => updateItem(it.key, { item_name: e.target.value })} />
          <input style={{ ...inputStyle(), width: 80 }} placeholder="規格" value={it.spec ?? ""} onChange={(e) => updateItem(it.key, { spec: e.target.value })} />
          <input style={{ ...inputStyle(), width: 70 }} placeholder="産地" value={it.origin ?? ""} onChange={(e) => updateItem(it.key, { origin: e.target.value })} />
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
          <label style={{ fontSize: 11, color: T.textSub }}>
            数量
            <input style={{ ...inputStyle(), width: 50, marginLeft: 4 }} value={it.quantity ?? ""} onChange={(e) => updateItem(it.key, { quantity: e.target.value ? parseFloat(e.target.value) : null })} />
            <input style={{ ...inputStyle(), width: 44, marginLeft: 4 }} value={it.quantity_unit ?? ""} onChange={(e) => updateItem(it.key, { quantity_unit: e.target.value })} />
          </label>
          <label style={{ fontSize: 11, color: T.textSub }}>
            実重量
            <input style={{ ...inputStyle(), width: 60, marginLeft: 4 }} value={it.actual_weight ?? ""} onChange={(e) => updateItem(it.key, { actual_weight: e.target.value ? parseFloat(e.target.value) : null })} />
            kg
          </label>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
          <label style={{ fontSize: 11, color: T.textSub }}>
            仕入単価
            <input style={{ ...inputStyle(), width: 70, marginLeft: 4 }} value={it.purchase_price ?? ""} onChange={(e) => updateItem(it.key, { purchase_price: e.target.value ? parseFloat(e.target.value) : null })} />
            <input style={{ ...inputStyle(), width: 50, marginLeft: 4 }} placeholder="単位" value={it.purchase_price_unit ?? ""} onChange={(e) => updateItem(it.key, { purchase_price_unit: e.target.value })} />
          </label>
          <span style={{ fontSize: 11, color: T.textSub }}>仕入金額: {it.purchase_amount != null ? fmtYen(it.purchase_amount) : "―"}</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ fontSize: 11, color: T.textSub }}>
            売値
            <input style={{ ...inputStyle(), width: 70, marginLeft: 4 }} value={it.selling_price ?? ""} onChange={(e) => updateItem(it.key, { selling_price: e.target.value ? parseFloat(e.target.value) : null, selling_price_source: "manual" })} />
          </label>
          <span style={{ fontSize: 11, color: T.textSub }}>
            {it.selling_price_source === "original" && "原稿記載値"}
            {it.selling_price_source === "calculated" && "自動計算値（要確認）"}
            {it.selling_price_source === "manual" && "手動修正済み"}
          </span>
        </div>
      </div>
    );
  };

  return (
    <section style={card()}>
      <h3 style={h3()}>① 原稿を貼り付け</h3>
      {err && <div style={{ color: T.warn, marginBottom: 8, fontSize: 13 }}>{err}</div>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 14, padding: 8, border: `1px solid ${T.border}`, borderRadius: 6 }}
      />
      <div style={{ marginTop: 8 }}>
        <button style={btn(true)} onClick={handleParse}>解析する</button>
      </div>

      {preview && (
        <div style={{ marginTop: 12 }}>
          {preview.warnings.length > 0 && (
            <div style={{ fontSize: 12, color: T.warn, marginBottom: 8 }}>
              {preview.warnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
            </div>
          )}
          {preview.items.length === 0 ? (
            <p style={{ fontSize: 13, color: T.textSub }}>品目を抽出できませんでした。テキストの形式をご確認ください。</p>
          ) : (
            <>
              <p style={{ fontSize: 12, color: T.textSub }}>{preview.items.length}件を抽出しました。内容を確認・修正してから確定してください。</p>
              {preview.items.map(renderPreviewItem)}
              <button style={btn(true)} onClick={handleConfirm} disabled={saving}>
                {saving ? "保存中..." : "この内容で確定"}
              </button>
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: 16, borderTop: `1px solid ${T.softBorder}`, paddingTop: 10 }}>
        <div style={{ fontSize: 12, color: T.textSub, marginBottom: 6 }}>
          {loadingSaved ? "読み込み中..." : `本日確定済み: ${saved.length}件`}
        </div>
        {saved.map((r) => (
          <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, padding: "4px 0", borderBottom: `1px solid ${T.softBorder}` }}>
            <span>
              {r.is_shipping_fee ? `送料 ${r.shipping_note || ""}` : r.item_name}
              {!r.is_shipping_fee && r.spec ? `(${r.spec})` : ""}
              {" "}
              {r.is_shipping_fee ? (r.shipping_fee != null ? fmtYen(r.shipping_fee) : "金額なし") : `${fmtYen(r.purchase_price)}/${r.purchase_price_unit || "?"}`}
            </span>
            <button style={{ ...btn(false), padding: "2px 8px", fontSize: 11 }} onClick={() => handleDeleteSaved(r.id)}>削除</button>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ----- ② LINE実績データを貼り付け ----- */
function LineActualPaste({ date }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState([]);
  const [loadingSaved, setLoadingSaved] = useState(false);

  const loadSaved = useCallback(async () => {
    setLoadingSaved(true);
    try {
      const rows = await db.list("line_actual_items", `?order_date=eq.${date}&order=created_at.asc`);
      setSaved(rows);
    } catch (e) {
      setErr("読み込みに失敗しました: " + (e.message || e));
    } finally {
      setLoadingSaved(false);
    }
  }, [date]);

  useEffect(() => { loadSaved(); }, [loadSaved]);

  const handleParse = () => {
    if (!text.trim()) return;
    const { destinations, warnings } = parseLineShipmentText(text, date);
    const rows = buildLineActualRows(destinations, date);
    setPreview({ items: rows.map((row, idx) => ({ key: idx, ...row })), warnings });
  };

  const updateItem = (key, patch) => {
    setPreview((prev) => ({ ...prev, items: prev.items.map((it) => (it.key === key ? { ...it, ...patch } : it)) }));
  };

  const handleConfirm = async () => {
    if (!preview || preview.items.length === 0) return;
    setSaving(true);
    setErr("");
    try {
      const payload = preview.items.map((it) => ({
        order_date: it.order_date,
        destination: it.destination || "",
        ship_date: it.ship_date,
        delivery_date: it.delivery_date,
        delivery_time_note: it.delivery_time_note || "",
        delivery_category: it.delivery_category,
        item_name: it.item_name || "",
        origin: it.origin || "",
        spec: it.spec || "",
        quantity: it.quantity,
        quantity_unit: it.quantity_unit || "",
        actual_weight: it.actual_weight,
        actual_weight_unit: it.actual_weight_unit || "",
        purchase_price: it.purchase_price,
        purchase_price_unit: it.purchase_price_unit || "",
        raw_line: it.raw_line,
      }));
      await db.insertMany("line_actual_items", payload);
      setPreview(null);
      setText("");
      await loadSaved();
    } catch (e) {
      setErr("LINEデータの保存に失敗しました: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSaved = async (id) => {
    setSaved((prev) => prev.filter((r) => r.id !== id));
    try {
      await db.remove("line_actual_items", id);
    } catch (e) {
      setErr("削除に失敗しました: " + (e.message || e));
      loadSaved();
    }
  };

  const renderPreviewItem = (it) => (
    <div key={it.key} style={{ ...card(), marginBottom: 8, padding: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.textSub, marginBottom: 4 }}>
        <span>{it.destination || "（納品先不明）"} ・ {DELIVERY_CATEGORY_LABELS[it.delivery_category] || it.delivery_category}</span>
        <span>発送{it.ship_date || "―"} / 納品{it.delivery_date || "―"}{it.delivery_time_note}</span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
        <input style={{ ...inputStyle(), width: 120, fontWeight: 600 }} value={it.item_name ?? ""} onChange={(e) => updateItem(it.key, { item_name: e.target.value })} />
        <input style={{ ...inputStyle(), width: 70 }} placeholder="規格" value={it.spec ?? ""} onChange={(e) => updateItem(it.key, { spec: e.target.value })} />
        <input style={{ ...inputStyle(), width: 60 }} placeholder="産地" value={it.origin ?? ""} onChange={(e) => updateItem(it.key, { origin: e.target.value })} />
        <label style={{ fontSize: 11, color: T.textSub }}>
          数量
          <input style={{ ...inputStyle(), width: 44, marginLeft: 4 }} value={it.quantity ?? ""} onChange={(e) => updateItem(it.key, { quantity: e.target.value ? parseFloat(e.target.value) : null })} />
          <input style={{ ...inputStyle(), width: 40, marginLeft: 4 }} value={it.quantity_unit ?? ""} onChange={(e) => updateItem(it.key, { quantity_unit: e.target.value })} />
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: 11, color: T.textSub }}>
          実重量
          <input
            style={{ ...inputStyle(), width: 60, marginLeft: 4 }}
            value={it.actual_weight ?? ""}
            onChange={(e) => updateItem(it.key, { actual_weight: e.target.value ? parseFloat(e.target.value) : null, actual_weight_unit: e.target.value ? "kg" : "" })}
          />
          kg
        </label>
        <label style={{ fontSize: 11, color: T.textSub }}>
          仕入価格
          <input
            style={{ ...inputStyle(), width: 70, marginLeft: 4 }}
            placeholder="未記載なら空欄"
            value={it.purchase_price ?? ""}
            onChange={(e) => updateItem(it.key, { purchase_price: e.target.value ? parseFloat(e.target.value) : null })}
          />
        </label>
        <label style={{ fontSize: 11, color: T.textSub }}>
          単位
          <input
            style={{ ...inputStyle(), width: 50, marginLeft: 4 }}
            placeholder="kg/本 等"
            value={it.purchase_price_unit ?? ""}
            onChange={(e) => updateItem(it.key, { purchase_price_unit: e.target.value })}
          />
        </label>
      </div>
    </div>
  );

  return (
    <section style={card()}>
      <h3 style={h3()}>② LINE実績データを貼り付け</h3>
      {err && <div style={{ color: T.warn, marginBottom: 8, fontSize: 13 }}>{err}</div>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 14, padding: 8, border: `1px solid ${T.border}`, borderRadius: 6 }}
      />
      <div style={{ marginTop: 8 }}>
        <button style={btn(true)} onClick={handleParse}>解析する</button>
      </div>

      {preview && (
        <div style={{ marginTop: 12 }}>
          {preview.warnings.length > 0 && (
            <div style={{ fontSize: 12, color: T.warn, marginBottom: 8 }}>
              {preview.warnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
            </div>
          )}
          {preview.items.length === 0 ? (
            <p style={{ fontSize: 13, color: T.textSub }}>品目を抽出できませんでした。テキストの形式をご確認ください。</p>
          ) : (
            <>
              <p style={{ fontSize: 12, color: T.textSub }}>{preview.items.length}件を抽出しました。内容を確認・修正してから確定してください。</p>
              {preview.items.map(renderPreviewItem)}
              <button style={btn(true)} onClick={handleConfirm} disabled={saving}>
                {saving ? "保存中..." : "この内容で確定"}
              </button>
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: 16, borderTop: `1px solid ${T.softBorder}`, paddingTop: 10 }}>
        <div style={{ fontSize: 12, color: T.textSub, marginBottom: 6 }}>
          {loadingSaved ? "読み込み中..." : `本日確定済み: ${saved.length}件`}
        </div>
        {saved.map((r) => (
          <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, padding: "4px 0", borderBottom: `1px solid ${T.softBorder}` }}>
            <span>
              {r.destination ? `${r.destination} / ` : ""}{r.item_name}{r.spec ? `(${r.spec})` : ""}{" "}
              {r.purchase_price != null ? `${fmtYen(r.purchase_price)}/${r.purchase_price_unit || "?"}` : "仕入価格なし"}
            </span>
            <button style={{ ...btn(false), padding: "2px 8px", fontSize: 11 }} onClick={() => handleDeleteSaved(r.id)}>削除</button>
          </div>
        ))}
      </div>
    </section>
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
    return comparePrice({
      manuscriptPrice: mi ? mi.unit_price : null,
      manuscriptUnit: mi ? mi.price_unit : null,
      actualPrice: l.actual_unit_price != null ? Number(l.actual_unit_price) : null,
      actualUnit: l.actual_unit_price_unit || null,
    }).status === "up";
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
