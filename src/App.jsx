import { useState, useEffect, useCallback, useRef, useMemo, useImperativeHandle, forwardRef, Fragment } from "react";
import { db, isSupabaseConfigured } from "./lib/supabase";
import { extractKadokuraManuscriptItems } from "./lib/manuscriptKadokura";
import { parseShippingList, cleanDestinationName } from "./lib/shippingList";
import { parseLineShipmentText, buildLineActualRows } from "./lib/lineShipment";
import {
  calcLineAmount,
  comparePrice,
  buildInvoiceTotals,
  isSameDayCategory,
  DELIVERY_CATEGORY_LABELS,
  computeSellPrice,
  computeSellUnitPrice,
  buildProfitTotals,
} from "./lib/pricing";
import { rankManuscriptCandidates, pickCertainCandidate, searchManuscriptItems } from "./lib/matching";

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
  // 2026-09-23 変更（kento指示）: 過去の納品書を作ることがあるため、「原稿」「発注」「チェック」
  // 「納品書」の各ページにカレンダーを置く（デフォルトは当日）。4ページとも同じ日付を共有し、
  // どのページでカレンダーを変えても他のページの日付も同じになる。
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
            onDateChange={setSelectedDate}
            items={manuscriptItems}
            loading={loading}
            onSaved={() => reloadAll(selectedDate)}
          />
        )}
        {tab === "orders" && (
          <OrdersPanel
            date={selectedDate}
            onDateChange={setSelectedDate}
            orderLines={orderLines}
            onChanged={() => loadOrderLines(selectedDate).catch((e) => setGlobalError(e.message || String(e)))}
          />
        )}
        {tab === "pricecheck" && (
          <PriceCheckPanel
            date={selectedDate}
            onDateChange={setSelectedDate}
            manuscriptItems={manuscriptItems}
            manuscriptItemById={manuscriptItemById}
          />
        )}
        {tab === "invoice" && (
          <InvoicePanel date={selectedDate} onDateChange={setSelectedDate} manuscriptItemById={manuscriptItemById} />
        )}
        {tab === "history" && <HistoryPanel />}
      </main>
    </div>
  );
}

function inputStyle() {
  return { padding: "6px 8px", border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 16, background: "#fff", color: T.textMain };
}
// 枠線ではなく下線だけの入力欄（LINE実績データの確認カードで使用）
function underlineInputStyle() {
  return { padding: "4px 2px", border: "none", borderBottom: `1px solid ${T.border}`, borderRadius: 0, fontSize: 16, background: "transparent", color: T.textMain, outline: "none" };
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
function ManuscriptPanel({ date, onDateChange, items, loading, onSaved }) {
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

  // 2026-09-21 追加変更（kento指示）: 保存済みの原稿もクリア（削除）できるようにする。
  // manuscript_batchesを削除すればmanuscript_itemsはon delete cascadeでまとめて消える。
  const [clearingSaved, setClearingSaved] = useState(false);
  const clearSavedManuscript = async () => {
    if (items.length === 0) return;
    if (!window.confirm(`${date} に保存済みの原稿（${items.length}件）をすべて削除しますか？\nこの操作は取り消せません。`)) return;
    setClearingSaved(true);
    setErr("");
    try {
      await db.removeWhere("manuscript_batches", `?manuscript_date=eq.${date}`);
      onSaved();
    } catch (e) {
      setErr("削除に失敗しました: " + (e.message || e));
    } finally {
      setClearingSaved(false);
    }
  };

  return (
    <div>
      <DateHeader title="原稿読み込み" date={date} onDateChange={onDateChange} />
      <section style={card()}>
        <h3 style={h3()}>原稿テキストを貼り付け</h3>
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={"・白甘鯛\n和歌山\n1.5kg k12,000\n\n・メックリアジ兵庫(二見)\n1.5kg k1,200"}
          rows={10}
          style={{ width: "100%", fontFamily: "monospace", fontSize: 16, padding: 8, border: `1px solid ${T.border}`, borderRadius: 6 }}
        />
        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <button style={btn(true)} onClick={handleExtract}>解析する</button>
          <button style={btn()} onClick={() => { setPasteText(""); setPreview(null); }}>クリア</button>
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <h3 style={h3()}>{date} に保存済みの原稿商品（{items.length}件）</h3>
          {items.length > 0 && (
            <button style={btn()} disabled={clearingSaved} onClick={clearSavedManuscript}>
              {clearingSaved ? "削除中..." : "クリア"}
            </button>
          )}
        </div>
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
// 店舗名から「株式会社」を取り除く（kento指示 2026-09-23。保存済みの古いデータの表示用にも使う）
function stripCompanyWords(name) {
  const n = name || "";
  return n.includes("株式会社") ? n.replace(/[\s　]*株式会社[\s　]*/g, "").trim() || n : n;
}

// ページ見出し＋カレンダー（原稿・発注・チェック・納品書で共通。日付は全ページで共有）
function DateHeader({ title, date, onDateChange, children }) {
  const today = todayStr();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
      <h2 style={{ ...h2(), marginBottom: 0 }}>{title}</h2>
      <input
        type="date"
        style={{ ...inputStyle(), ...(date !== today ? { borderColor: T.warn, color: T.warn } : {}) }}
        value={date}
        onChange={(e) => { if (e.target.value && onDateChange) onDateChange(e.target.value); }}
      />
      {date !== today && onDateChange && (
        <button style={{ ...btn(false), padding: "4px 10px", fontSize: 12 }} onClick={() => onDateChange(today)}>
          今日に戻す
        </button>
      )}
      {children}
    </div>
  );
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
function OrdersPanel({ date, onDateChange, orderLines, onChanged }) {
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
      <DateHeader title="発注一覧" date={date} onDateChange={onDateChange} />
      {err && <div style={{ color: T.warn, marginBottom: 12 }}>{err}</div>}

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
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
// 「② 発注一覧との価格チェック」（order_lines側の紐付け）はSTEP5でLineActualPaste
// (①LINE実績データ)側への原稿紐付け・単価チェックに一本化したため廃止した
// （kento指示: 2026-09-21）。中身は LineActualPaste 内のManuscriptLinkSelect/
// ManuscriptCompareBadgeを参照。
function PriceCheckPanel({ date, onDateChange, manuscriptItems, manuscriptItemById }) {
  return (
    <div>
      <DateHeader title="価格チェック" date={date} onDateChange={onDateChange} />
      <LineActualPaste date={date} manuscriptItems={manuscriptItems} manuscriptItemById={manuscriptItemById} />
    </div>
  );
}

/* ----- ① LINE実績データを貼り付け ----- */
function isShippingRowName(name) {
  return /^送料/.test(name || "");
}

// 「午前中」「午後」をAM/PMに略す（それ以外の自由記述はそのまま残す）。
function abbreviateTimeNote(note) {
  if (!note) return "";
  if (/午前/.test(note)) return "AM";
  if (/午後/.test(note)) return "PM";
  return note;
}

// 航空便・配送便は当日便のため発送日等は表示せず、宅急便のときだけ「9/19→9/20AM」
// のように省略して表示する。
function formatShipDeliveryLabel(g) {
  if (isSameDayCategory(g.delivery_category)) return "";
  const shipPart = g.ship_date ? formatMD(g.ship_date) : "";
  const deliveryPart = g.delivery_date ? `${formatMD(g.delivery_date)}${abbreviateTimeNote(g.delivery_time_note)}` : "";
  if (shipPart && deliveryPart) return `${shipPart}→${deliveryPart}`;
  return shipPart || deliveryPart;
}

// destination/delivery_category/日付が同じ行をまとめて、発注一覧タブと同じように
// 納品先ごとの見出し付きで表示するためのグルーピング（送料は各グループの最後に回す）。
function groupLineItemsByDestination(items) {
  const map = new Map();
  const order = [];
  items.forEach((it) => {
    const key = [it.destination || "", it.delivery_category, it.ship_date, it.delivery_date, it.delivery_time_note].join("|");
    if (!map.has(key)) {
      map.set(key, {
        destination: it.destination || "（納品先不明）",
        delivery_category: it.delivery_category,
        ship_date: it.ship_date,
        delivery_date: it.delivery_date,
        delivery_time_note: it.delivery_time_note,
        items: [],
      });
      order.push(key);
    }
    map.get(key).items.push(it);
  });
  return order.map((k) => {
    const g = map.get(k);
    g.items = [...g.items].sort((a, b) => Number(isShippingRowName(a.item_name)) - Number(isShippingRowName(b.item_name)));
    return g;
  });
}

function LineActualPaste({ date, manuscriptItems, manuscriptItemById }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState([]);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [unitMap, setUnitMap] = useState({});

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

  const loadUnitMap = useCallback(async () => {
    try {
      const rows = await db.list("product_price_units");
      const m = {};
      rows.forEach((r) => { m[r.item_name] = r.default_unit; });
      setUnitMap(m);
    } catch (e) {
      // 学習データが読めなくても致命的ではないため、名前パターン＋kgデフォルトで推測させる
    }
  }, []);

  useEffect(() => { loadSaved(); }, [loadSaved]);
  useEffect(() => { loadUnitMap(); }, [loadUnitMap]);

  const handleParse = () => {
    if (!text.trim()) return;
    const { destinations, warnings } = parseLineShipmentText(text, date);
    const rows = buildLineActualRows(destinations, date, unitMap);
    // 2026-09-24 追加変更（kento指示）: レビュー画面から規格／産地の入力欄を削除したため、
    // 抽出した規格・産地はここで品目名にそのまま含めてしまう（値が無ければ何も変わらない）。
    const merged = rows.map((row) => ({
      ...row,
      // 2026-09-23 変更（kento指示）: 産地は品目名に含めず origin として保持する
      // （品目名・納品書には出さず、チェック画面の確定済み一覧でのみ表示する）。
      item_name: [row.item_name, row.spec].filter(Boolean).join(" ").trim(),
      origin: row.origin || "",
      spec: "",
    }));
    setPreview({ items: merged.map((row, idx) => ({ key: idx, ...row })), warnings });
  };

  const updateItem = (key, patch) => {
    setPreview((prev) => ({ ...prev, items: prev.items.map((it) => (it.key === key ? { ...it, ...patch } : it)) }));
  };

  const groupedPreviewItems = useMemo(() => (preview ? groupLineItemsByDestination(preview.items) : []), [preview]);
  const groupedSavedItems = useMemo(() => groupLineItemsByDestination(saved), [saved]);

  const handleConfirm = async () => {
    if (!preview || preview.items.length === 0) return;
    setSaving(true);
    setErr("");
    try {
      // 2026-09-23 追加（kento指示）: 原稿との紐付けは「確実なもの」（pickCertainCandidate:
      // 品目名の完全一致 or 確実な対応表で、同点の候補が無いもの）だけをデフォルトで設定する。
      const payload = preview.items.map((it) => {
        const certain = isShippingRowName(it.item_name)
          ? null
          : pickCertainCandidate(
              { item_name: it.item_name, spec: it.spec, origin: it.origin, size_hint: it.size_hint, actual_weight: it.actual_weight, quantity: it.quantity, partial: it.partial },
              manuscriptItems
            );
        return {
        manuscript_item_id: certain ? certain.id : null,
        manuscript_price_status: certain ? "linked" : "none",
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
        sell_price: it.sell_price != null ? it.sell_price : null,
        note: it.note || "",
        raw_line: it.raw_line,
        };
      });
      await db.insertMany("line_actual_items", payload);

      // 商品ごとの単価単位を学習・更新する（原稿パーサー側と同じ学習テーブルを共有する）。
      // 送料は単価という概念が無いため学習対象から除く。
      const learned = new Map();
      preview.items.forEach((it) => {
        if (!isShippingRowName(it.item_name) && it.item_name && it.purchase_price_unit) {
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
      setErr("LINEデータの保存に失敗しました: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  // 確定済みLINE実績データの編集（id → 編集中の下書き）
  const [editingSaved, setEditingSaved] = useState({});
  const [savingEditId, setSavingEditId] = useState(null);
  const EDITABLE_FIELDS = ["item_name", "quantity", "quantity_unit", "actual_weight", "actual_weight_unit", "purchase_price", "purchase_price_unit", "sell_price", "note"];
  const startEditSaved = (r) => setEditingSaved((prev) => ({ ...prev, [r.id]: { ...r } }));
  const cancelEditSaved = (id) => setEditingSaved((prev) => { const n = { ...prev }; delete n[id]; return n; });
  const patchEditSaved = (id, patch) => setEditingSaved((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  const saveEditSaved = async (id) => {
    const draft = editingSaved[id];
    if (!draft) return;
    const patch = {};
    // 数値欄は編集UI側で数値かnullに変換済み。文字欄（品目・単位・備考）は空文字で保存する。
    EDITABLE_FIELDS.forEach((f) => {
      const isText = f === "item_name" || f === "note" || f.endsWith("_unit");
      patch[f] = draft[f] ?? (isText ? "" : null);
    });
    setSavingEditId(id);
    setErr("");
    try {
      await db.update("line_actual_items", id, patch);
      setSaved((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
      cancelEditSaved(id);
    } catch (e) {
      setErr("修正の保存に失敗しました: " + (e.message || e));
    } finally {
      setSavingEditId(null);
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

  // 原稿(manuscript_items)との紐付け（候補提示のみ・最終選択はユーザー。STEP5仕様）。
  // 画面には即反映しつつ、DB保存は個別PATCHのみ行い全件再取得はしない
  // （②の実装時と同じ理由: 再取得すると created_at が同じ行の並び順が変わってしまうため）。
  const setManuscriptLink = (row, manuscriptItemId) => {
    const patch = { manuscript_item_id: manuscriptItemId || null, manuscript_price_status: manuscriptItemId ? "linked" : "none" };
    setSaved((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
    db.update("line_actual_items", row.id, patch).catch((e) => {
      setErr("原稿との紐付けの保存に失敗しました: " + (e.message || e));
      loadSaved();
    });
  };

  const manuscriptOptions = useMemo(
    () =>
      manuscriptItems
        .slice()
        .sort((a, b) => a.item_name.localeCompare(b.item_name, "ja"))
        .map((it) => ({
          value: it.id,
          label: `${it.item_name}（${it.origin || "産地未記載"}）${it.spec ? " " + it.spec : ""} ${fmtYen(it.unit_price)}/${it.price_unit || "?"}`,
        })),
    [manuscriptItems]
  );

  // 品目カードの編集UI。解析直後のプレビュー（renderPreviewItem）と、確定済み行の編集
  // （2026-09-23 kento指示: 確定後も修正できるように）の両方で共用する。
  const renderItemEditor = (it, update) => {
    if (isShippingRowName(it.item_name)) {
      return (
        <div key={it.key || it.id} style={{ ...card(), marginBottom: 8, padding: 10, background: "#f3f3f3" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input style={{ ...inputStyle(), width: 130, fontWeight: 600 }} value={it.item_name ?? ""} onChange={(e) => update({ item_name: e.target.value })} />
            <label style={{ fontSize: 11, color: T.textSub }}>
              金額
              <input
                style={{ ...inputStyle(), width: 80, marginLeft: 4 }}
                value={it.purchase_price ?? ""}
                onChange={(e) => update({ purchase_price: e.target.value ? parseFloat(e.target.value) : null })}
              />
            </label>
          </div>
        </div>
      );
    }
    // 2026-09-23 レイアウト変更（kento指示・6回目）:
    //   1行目: 品目名（残り幅いっぱい）＋ 数量（右端）
    //   2行目: 目方（幅そのまま）＋ 備考（欄内に薄く小さく「備考」、右端に×で削除。残り幅いっぱい）
    //   3行目: 仕入値 ＋ 売値
    //   入力欄は枠線ではなく下線（underlineInputStyle）
    const u = underlineInputStyle();
    const lbl = { fontSize: 11, color: T.textSub, flexShrink: 0, display: "flex", alignItems: "center", whiteSpace: "nowrap" };
    return (
      <div key={it.key || it.id} style={{ ...card(), marginBottom: 8, padding: 10 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
          <input style={{ ...u, flex: 1, minWidth: 0, fontWeight: 600 }} value={it.item_name ?? ""} onChange={(e) => update({ item_name: e.target.value })} />
          <label style={lbl}>
            数量
            <input style={{ ...u, width: 44, marginLeft: 4 }} value={it.quantity ?? ""} onChange={(e) => update({ quantity: e.target.value ? parseFloat(e.target.value) : null })} />
            <input style={{ ...u, width: 40, marginLeft: 4 }} value={it.quantity_unit ?? ""} onChange={(e) => update({ quantity_unit: e.target.value })} />
          </label>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
          <label style={lbl}>
            目方
            <input
              style={{ ...u, width: 60, marginLeft: 4 }}
              value={it.actual_weight ?? ""}
              onChange={(e) => update({ actual_weight: e.target.value ? parseFloat(e.target.value) : null, actual_weight_unit: e.target.value ? "kg" : "" })}
            />
            kg
          </label>
          {/* 備考欄: 下線の中に薄く小さく「備考」、右端に×（備考を空にする）ボタン */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", borderBottom: `1px solid ${T.border}` }}>
            <span style={{ fontSize: 10, color: T.textSub, opacity: 0.55, flexShrink: 0, marginRight: 4 }}>備考</span>
            <input
              style={{ ...u, borderBottom: "none", flex: 1, minWidth: 0 }}
              value={it.note ?? ""}
              onChange={(e) => update({ note: e.target.value })}
            />
            {it.note ? (
              <button
                type="button"
                aria-label="備考を削除"
                onClick={() => update({ note: "" })}
                style={{ border: "none", background: "transparent", color: T.textSub, fontSize: 16, lineHeight: 1, padding: "2px 4px", cursor: "pointer", flexShrink: 0 }}
              >
                ×
              </button>
            ) : null}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={lbl}>
            仕入値
            <input
              style={{ ...u, width: 50, marginLeft: 4 }}
              placeholder="kg/本"
              value={it.purchase_price_unit ?? ""}
              onChange={(e) => update({ purchase_price_unit: e.target.value })}
            />
            <input
              style={{ ...u, width: 70, marginLeft: 4 }}
              value={it.purchase_price ?? ""}
              onChange={(e) => update({ purchase_price: e.target.value ? parseFloat(e.target.value) : null })}
            />
          </label>
          <label style={lbl}>
            売値
            <input
              style={{ ...u, width: 70, marginLeft: 4 }}
              value={it.sell_price ?? ""}
              onChange={(e) => update({ sell_price: e.target.value ? parseFloat(e.target.value) : null })}
            />
          </label>
        </div>
      </div>
    );
  };

  const renderPreviewItem = (it) => renderItemEditor(it, (patch) => updateItem(it.key, patch));

  const renderGroupHeader = (g, gi) => {
    const label = formatShipDeliveryLabel(g);
    return (
      <div
        style={{
          fontWeight: 700,
          fontSize: 15,
          borderBottom: `1px solid ${T.border}`,
          padding: gi === 0 ? "4px 4px 6px" : "16px 4px 6px",
          marginBottom: 8,
        }}
      >
        {g.destination}
        <span style={{ fontWeight: 400, fontSize: 12, color: T.textSub, marginLeft: 8 }}>
          {DELIVERY_CATEGORY_LABELS[g.delivery_category] || g.delivery_category}
          {label && ` ${label}`}
        </span>
      </div>
    );
  };

  return (
    <section style={card()}>
      <h3 style={h3()}>① LINE実績データを貼り付け</h3>
      {err && <div style={{ color: T.warn, marginBottom: 8, fontSize: 13 }}>{err}</div>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 14, padding: 8, border: `1px solid ${T.border}`, borderRadius: 6 }}
      />
      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
        <button style={btn(true)} onClick={handleParse}>解析する</button>
        <button style={btn()} onClick={() => { setText(""); setPreview(null); }}>クリア</button>
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
              {groupedPreviewItems.map((g, gi) => (
                <Fragment key={gi}>
                  {renderGroupHeader(g, gi)}
                  {g.items.map(renderPreviewItem)}
                </Fragment>
              ))}
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
        {groupedSavedItems.map((g, gi) => (
          <div key={gi} style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginTop: gi === 0 ? 0 : 10, marginBottom: 4 }}>
              {g.destination}
              <span style={{ fontWeight: 400, fontSize: 11, color: T.textSub, marginLeft: 6 }}>
                {DELIVERY_CATEGORY_LABELS[g.delivery_category] || g.delivery_category}
                {formatShipDeliveryLabel(g) && ` ${formatShipDeliveryLabel(g)}`}
              </span>
            </div>
            {g.items.map((r) => (
              <div key={r.id} style={{ padding: "6px 0", borderBottom: `1px solid ${T.softBorder}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                  <span>
                    {r.item_name}{r.spec ? `(${r.spec})` : ""}{" "}
                    {r.origin ? <span style={{ color: T.textSub }}>［{r.origin}］</span> : null}{r.origin ? " " : ""}
                    {r.quantity != null && r.quantity !== "" ? `${r.quantity}${r.quantity_unit || ""} ` : ""}
                    {r.actual_weight != null && r.actual_weight !== "" ? `${r.actual_weight}${r.actual_weight_unit || "kg"} ` : ""}
                    {isShippingRowName(r.item_name)
                      ? (r.purchase_price != null ? fmtYen(r.purchase_price) : "金額なし")
                      : (r.purchase_price != null ? `${fmtYen(r.purchase_price)}/${r.purchase_price_unit || "?"}` : "仕入価格なし")}
                  </span>
                  <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    {!editingSaved[r.id] && (
                      <button style={{ ...btn(false), padding: "2px 8px", fontSize: 11 }} onClick={() => startEditSaved(r)}>編集</button>
                    )}
                    <button style={{ ...btn(false), padding: "2px 8px", fontSize: 11 }} onClick={() => handleDeleteSaved(r.id)}>削除</button>
                  </span>
                </div>
                {editingSaved[r.id] && (
                  <div style={{ marginTop: 6 }}>
                    {renderItemEditor(editingSaved[r.id], (patch) => patchEditSaved(r.id, patch))}
                    {r.invoice_id && (
                      <div style={{ fontSize: 11, color: T.warn, marginBottom: 4 }}>
                        ⚠️この行は納品書に保存済みです。ここで修正しても保存済みの納品書には反映されません。
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6 }}>
                      <button style={btn(true)} disabled={savingEditId === r.id} onClick={() => saveEditSaved(r.id)}>
                        {savingEditId === r.id ? "保存中..." : "修正を保存"}
                      </button>
                      <button style={btn(false)} onClick={() => cancelEditSaved(r.id)}>キャンセル</button>
                    </div>
                  </div>
                )}
                {!isShippingRowName(r.item_name) && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
                    <ManuscriptLinkSelect row={r} manuscriptOptions={manuscriptOptions} manuscriptItems={manuscriptItems} onLink={setManuscriptLink} />
                    <ManuscriptCompareBadge row={r} manuscriptItemById={manuscriptItemById} />
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

// LINE実績データの1品目に対する原稿(manuscript_items)紐付け欄（STEP5仕様、案A）。
// rankManuscriptCandidates（matching.js）による上位候補（最大5件）を先頭に、
// それ以外の全商品を「その他」としてまとめる。候補が0件で未紐付けの場合は、プルダウンの代わりに
// 原稿を検索して選ぶ検索欄を出す。確実な候補（pickCertainCandidate）は確定時に自動で紐付け済み。
function ManuscriptLinkSelect({ row, manuscriptItems, manuscriptOptions, onLink }) {
  const candidates = useMemo(
    () =>
      rankManuscriptCandidates({ item_name: row.item_name, spec: row.spec, origin: row.origin }, manuscriptItems).slice(0, 5),
    [row.item_name, row.spec, row.origin, manuscriptItems]
  );
  const candidateIds = useMemo(() => new Set(candidates.map((c) => c.item.id)), [candidates]);
  const restOptions = useMemo(() => manuscriptOptions.filter((o) => !candidateIds.has(o.value)), [manuscriptOptions, candidateIds]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const results = useMemo(() => searchManuscriptItems(query, manuscriptItems).slice(0, 10), [query, manuscriptItems]);

  // 2026-09-23 変更（kento指示）: 候補が無く、まだ紐付けもされていない場合は、
  // 「候補なし（全商品から選択）」のプルダウンの代わりに検索欄を出す。
  if (candidates.length === 0 && !row.manuscript_item_id) {
    return (
      <div style={{ position: "relative", width: 230, maxWidth: "100%" }}>
        <input
          style={{ ...inputStyle(), width: "100%", boxSizing: "border-box", fontSize: 12 }}
          placeholder="候補なし：原稿から検索"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {open && query.trim() && (
          <div style={{ position: "absolute", zIndex: 20, top: "100%", left: 0, right: 0, background: "#fff", border: `1px solid ${T.border}`, borderRadius: 6, maxHeight: 240, overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,0.12)" }}>
            {results.length === 0 ? (
              <div style={{ padding: 8, fontSize: 12, color: T.textSub }}>該当なし</div>
            ) : (
              results.map((mi) => (
                <div
                  key={mi.id}
                  onMouseDown={(e) => { e.preventDefault(); onLink(row, mi.id); setQuery(""); setOpen(false); }}
                  style={{ padding: "6px 8px", fontSize: 12, cursor: "pointer", borderBottom: `1px solid ${T.softBorder}` }}
                >
                  {mi.item_name}（{mi.origin || "産地未記載"}）{mi.spec ? " " + mi.spec : ""} {fmtYen(mi.unit_price)}/{mi.price_unit || "?"}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <select
      style={{ ...inputStyle(), maxWidth: 230, fontSize: 12 }}
      value={row.manuscript_item_id || ""}
      onChange={(e) => onLink(row, e.target.value)}
    >
      <option value="">―原稿価格なし―</option>
      {candidates.length > 0 && (
        <optgroup label="候補">
          {candidates.map((c) => (
            <option key={c.item.id} value={c.item.id}>
              {c.item.item_name}（{c.item.origin || "産地未記載"}）{c.item.spec ? " " + c.item.spec : ""} {fmtYen(c.item.unit_price)}/{c.item.price_unit || "?"}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="その他（全商品）">
        {restOptions.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </optgroup>
    </select>
  );
}

// 原稿単価と実績仕入単価の比較バッジ（②のcomparePriceロジックをそのまま流用）。
// 紐付け無し（no_manuscript_price）の場合は紐付け欄自体が未選択状態なので何も表示しない。
function ManuscriptCompareBadge({ row, manuscriptItemById }) {
  const mi = row.manuscript_item_id ? manuscriptItemById.get(row.manuscript_item_id) : null;
  const cmp = comparePrice({
    manuscriptPrice: mi ? mi.unit_price : null,
    manuscriptUnit: mi ? mi.price_unit : null,
    actualPrice: row.purchase_price != null ? Number(row.purchase_price) : null,
    actualUnit: row.purchase_price_unit || null,
  });
  if (cmp.status === "up") return <span style={{ color: T.warn, fontWeight: 700, fontSize: 11 }}>⚠️ +{fmtYen(cmp.diff)}</span>;
  if (cmp.status === "down") return <span style={{ color: T.textSub, fontSize: 11 }}>{fmtYen(cmp.diff)}</span>;
  if (cmp.status === "same") return <span style={{ color: T.ok, fontSize: 11 }}>±0</span>;
  if (cmp.status === "unit_unknown") return <span style={{ color: T.textSub, fontSize: 11 }}>単位未確認</span>;
  if (cmp.status === "unit_mismatch") {
    return (
      <span style={{ color: T.warn, fontSize: 11 }}>
        ⚠️単位不一致（原稿:{cmp.manuscriptUnit} / 実績:{cmp.actualUnit}）
      </span>
    );
  }
  return null;
}

/* ============================= 納品書プレビュー（共通） ============================= */
// 納品書の明細は常にLINE実績データ(line_actual_items)側の仕入価格(purchase_price/
// purchase_price_unit)を使う。原稿単価は比較専用であり、納品書の金額計算には使わない
// （kento指示: 2026-09-21）。takkyu_ship_date/takkyu_arrival_date は、line_actual_items
// では ship_date/delivery_date という列名なのでここで詰め替える。
function buildLineItemsForInvoice(lines) {
  return lines.map((line) => {
    const priceUnit = line.purchase_price_unit || "";
    const unitPrice = line.purchase_price != null ? Number(line.purchase_price) : null;
    const actualWeight = line.actual_weight != null ? Number(line.actual_weight) : null;
    const actualQuantity = line.quantity != null ? Number(line.quantity) : null;
    const { amount } = calcLineAmount({ priceUnit, unitPrice, actualWeight, actualQuantity });
    return {
      line_actual_item_id: line.id,
      item_name: line.item_name,
      origin: line.origin,
      quantity: actualQuantity,
      quantity_unit: line.quantity_unit,
      weight: actualWeight,
      unit_price: unitPrice,
      price_unit: priceUnit,
      amount: amount || 0,
      // 2026-09-25 追加変更（kento指示・5回目）: LINE実績データに「売値」が明記されていれば
      // そのままinvoice_line_items.sell_priceに引き継ぐ（履歴ページの利益計算にそのまま使われる。
      // 未記載ならnullのままで、従来通りHistoryPanel側の自動計算・手入力に委ねる）。
      sell_price: line.sell_price != null ? Number(line.sell_price) : null,
      // 2026-09-23 追加（kento指示）: 納品書では備考を品目の右隣に「(備考)」で表示する。
      // invoice_line_itemsには備考の列が無いため、保存時(saveGroup)には除外し、
      // 履歴ページではline_actual_item_id経由でLINE実績データの備考を読み直す。
      note: line.note || "",
      delivery_category: line.delivery_category,
      takkyu_ship_date: line.ship_date,
      takkyu_arrival_date: line.delivery_date,
    };
  });
}

// 2026-09-23 修正（kento指示）: スマホでPDF書き出しすると文字が重なってぐちゃぐちゃになる不具合の修正と、
// A4ページ送りの改善。
// 原因: 納品書プレビューは画面幅に合わせて transform: scale() で縮小表示している。PDF化の瞬間だけ
//   縮小を解除していたが、解除でサイズが変わるとResizeObserverが即座に縮小を掛け直してしまい、
//   html2canvasが「縮小された位置」に「原寸の文字」を描いて重なっていた（縮小が掛かるスマホでだけ発生）。
// 対策: 画面上の要素ではなく、html2canvasが内部で作る複製(onclone)側で祖先の縮小・はみ出し隠しを解除して
//   原寸で撮影する（画面上の表示には一切触らない）。
// ページ送り: 1枚の長い画像を機械的にA4の高さで切ると店舗の途中で行が真っ二つになるため、
//   data-pdf-block を付けた塊（店舗ごとの納品書・合計欄）の切れ目で改ページする。
//   1店舗だけでA4に入り切らない場合のみ、その店舗の途中で次ページに送る。
// iPhoneのcanvasサイズ上限（約1,670万ピクセル）を超えると描画が壊れるため、撮影倍率を自動で下げる。
// 納品書（PDF化する部分）のフォント。「system-ui」はhtml2canvasのcanvas描画側で別フォントとして
// 扱われ、文字位置の計算と実際の描画がズレて文字が重なる原因になるため、具体的なフォント名を指定する。
const INVOICE_FONT = "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Noto Sans CJK JP', 'Yu Gothic', Meiryo, sans-serif";

async function exportA4Pdf(node, filename) {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas"), import("jspdf")]);
  const MM_TO_PX = 96 / 25.4;
  const cssWidth = Math.round(210 * MM_TO_PX);
  const cssHeight = Math.ceil(node.scrollHeight);
  const MAX_AREA = 16000000;
  const MAX_SIDE = 16000;
  const scale = Math.max(0.5, Math.min(2, Math.sqrt(MAX_AREA / (cssWidth * cssHeight)), MAX_SIDE / cssHeight));

  // offsetTop/offsetHeightは transform の影響を受けない（原寸のレイアウト値）
  const blocks = Array.from(node.querySelectorAll("[data-pdf-block]")).map((el) => {
    let top = 0;
    let cur = el;
    while (cur && cur !== node) { top += cur.offsetTop; cur = cur.offsetParent; }
    return { top, bottom: top + el.offsetHeight };
  }).sort((a, b) => a.top - b.top);

  const canvas = await html2canvas(node, {
    backgroundColor: "#fff",
    scale,
    width: cssWidth,
    height: cssHeight,
    windowWidth: Math.max(cssWidth + 40, 1024),
    scrollX: 0,
    scrollY: 0,
    onclone: (doc, cloned) => {
      let el = cloned;
      while (el && el !== doc.documentElement) {
        el.style.transform = "none";
        el.style.overflow = "visible";
        if (el.hasAttribute && el.hasAttribute("data-a4-outer")) el.style.height = "auto";
        el = el.parentElement;
      }
    },
  });

  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = 210;
  const pageH = 297;
  const pxPerMm = cssWidth / pageW;
  const topMarginNextMm = 8;
  const bottomMarginMm = 6;
  let start = 0;
  let page = 0;
  while (start < cssHeight - 1) {
    const usableMm = pageH - bottomMarginMm - (page === 0 ? 0 : topMarginNextMm);
    const limit = start + usableMm * pxPerMm;
    let end;
    if (cssHeight <= limit) {
      end = cssHeight;
    } else {
      end = start;
      for (const b of blocks) {
        if (b.bottom <= start) continue;
        if (b.bottom <= limit) end = b.bottom;
        else break;
      }
      if (end <= start + 1) end = limit; // 1ブロックだけでページに入り切らない → そのブロックの途中で改ページ
    }
    const sy = Math.floor(start * scale);
    const sh = Math.min(canvas.height - sy, Math.ceil((end - start) * scale));
    const slice = document.createElement("canvas");
    slice.width = canvas.width;
    slice.height = sh;
    const ctx = slice.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, slice.width, slice.height);
    ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
    if (page > 0) pdf.addPage();
    pdf.addImage(slice.toDataURL("image/jpeg", 0.95), "JPEG", 0, page === 0 ? 0 : topMarginNextMm, pageW, sh / scale / pxPerMm);
    start = end;
    page += 1;
  }
  pdf.save(filename);
}

// 2026-09-21 追加変更（kento指示）: 納品書ページ・履歴ページのプレビューを、
// 実際に書き出すPDFの見た目に近づける（A4ページ全体が画面幅に収まるよう
// 自動で縮小表示する）。PDF化する瞬間だけ原寸に戻してhtml2canvasで撮影し、
// 終わったら縮小表示に戻す（withNaturalSizeをrefで公開）。
const A4PreviewScaler = forwardRef(function A4PreviewScaler({ children }, ref) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);

  const applyScale = () => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const MM_TO_PX = 96 / 25.4; // CSS仕様上の固定値（1mm ≈ 3.78px）
    const naturalWidthPx = 210 * MM_TO_PX;
    const containerWidth = outer.clientWidth;
    const scale = containerWidth > 0 ? Math.min(1, containerWidth / naturalWidthPx) : 1;
    inner.style.transform = `scale(${scale})`;
    outer.style.height = `${inner.offsetHeight * scale}px`;
  };

  useEffect(() => {
    applyScale();
    const ro = new ResizeObserver(() => applyScale());
    if (outerRef.current) ro.observe(outerRef.current);
    if (innerRef.current) ro.observe(innerRef.current);
    return () => ro.disconnect();
  }, []);

  useImperativeHandle(ref, () => ({
    withNaturalSize: async (fn) => {
      const inner = innerRef.current;
      const outer = outerRef.current;
      if (!inner || !outer) return fn();
      const prevTransform = inner.style.transform;
      const prevOverflow = outer.style.overflow;
      const prevHeight = outer.style.height;
      inner.style.transform = "none";
      outer.style.overflow = "visible";
      outer.style.height = "auto";
      try {
        return await fn();
      } finally {
        inner.style.transform = prevTransform;
        outer.style.overflow = prevOverflow;
        outer.style.height = prevHeight;
        applyScale();
      }
    },
  }));

  return (
    <div ref={outerRef} data-a4-outer="1" style={{ width: "100%", minWidth: 0, overflow: "hidden" }}>
      <div ref={innerRef} style={{ display: "inline-block", transformOrigin: "top left" }}>
        {children}
      </div>
    </div>
  );
});

// 2026-09-23 変更（kento指示）:
//   - 列を「品目 / 数量 / 目方 / 単価 / 金額」にする（数量の列を新設）
//   - 備考は新しい列ではなく、品目名の右に続けて「(備考)」で表示（文字は約80%）
//   - section="sameDay" は当日納品分だけ、section="takkyu" は宅急便分だけを表示する
//     （宅急便は納品書全体の最後にまとめて記載するため。InvoiceDocument参照）
function InvoicePreview({ invoiceDate, destination, lineItems, showTitle = true, showTotals = true, section, sectionHeader = null }) {
  const sameDay = section === "takkyu" ? [] : lineItems.filter((li) => isSameDayCategory(li.delivery_category));
  const takkyu = section === "sameDay" ? [] : lineItems.filter((li) => !isSameDayCategory(li.delivery_category));
  const shownItems = [...sameDay, ...takkyu];
  const totals = buildInvoiceTotals(shownItems);

  // 品目・数量・目方・単価・金額を列として揃える。品目の列幅を広めに確保。
  const ITEM_COLS = "3fr 0.9fr 1.1fr 1.5fr 1.4fr";

  const renderLine = (li, idx) => (
    <div
      key={idx}
      style={{ display: "grid", gridTemplateColumns: ITEM_COLS, columnGap: 10, alignItems: "baseline", fontSize: 18, padding: "4px 0", borderBottom: "1px solid #ddd" }}
    >
      <span>
        {li.item_name}{" "}
        {li.note ? <span style={{ fontSize: "0.8em", color: "#444" }}>({li.note})</span> : null}
      </span>
      <span style={{ textAlign: "right" }}>
        {li.quantity ? `${li.quantity}${li.quantity_unit || ""}` : ""}
      </span>
      <span style={{ textAlign: "right" }}>
        {li.weight ? `${li.weight}kg` : ""}
      </span>
      <span style={{ textAlign: "right" }}>
        {li.unit_price ? `¥${li.unit_price.toLocaleString("ja-JP")}/${li.price_unit || ""}` : ""}
      </span>
      <span style={{ textAlign: "right", fontWeight: 600 }}>{fmtYen(li.amount)}</span>
    </div>
  );

  const itemHeader = shownItems.length > 0 && (
    <div
      style={{ display: "grid", gridTemplateColumns: ITEM_COLS, columnGap: 10, fontSize: 11.7, color: "#888", borderBottom: "1px solid #ddd", paddingBottom: 4, marginTop: 4 }}
    >
      <span>品目</span>
      <span style={{ textAlign: "right" }}>数量</span>
      <span style={{ textAlign: "right" }}>目方</span>
      <span style={{ textAlign: "right" }}>単価</span>
      <span style={{ textAlign: "right" }}>金額</span>
    </div>
  );

  return (
    <div
      className="invoice-store-block"
      data-pdf-block="1"
      style={{ width: "100%", boxSizing: "border-box", background: "#fff", padding: "2.7mm 10mm", fontFamily: INVOICE_FONT, color: "#222" }}
    >
      {showTitle && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 16.2, borderBottom: "2px solid #333", paddingBottom: 5.4, marginBottom: 9 }}>
          <h2 style={{ fontSize: 16.2, margin: 0 }}>納品書</h2>
          <span style={{ fontSize: 16.2, color: "#555" }}>{formatMD(invoiceDate)}（{weekdayJa(invoiceDate)}）</span>
        </div>
      )}
      {sectionHeader}
      {!showTitle && !sectionHeader && <div style={{ borderTop: "1px solid #999", margin: "1.7px 0" }} />}
      {/* 2026-09-23 変更（kento指示）: 宅急便の発送→着日は店舗名の横には書かず、
          InvoiceDocumentの区切り見出し（「宅急便 9/23(水)→9/24(木)」）にまとめて記載する。 */}
      <p style={{ fontSize: 16.2, fontWeight: 700, margin: "9px 0" }}>
        {stripCompanyWords(destination)} 様
      </p>

      {itemHeader}
      {sameDay.map(renderLine)}
      {takkyu.map(renderLine)}

      {showTotals && (
        <div style={{ marginTop: 12.6, borderTop: "2px solid #333", paddingTop: 7.2, fontSize: 16.2 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>商品合計</span><span>{fmtYen(totals.subtotal)}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>消費税(8%)</span><span>{fmtYen(totals.tax)}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 16.2, marginTop: 3.6 }}><span>税込合計</span><span>{fmtYen(totals.total)}</span></div>
        </div>
      )}
    </div>
  );
}

// 納品書1日分（全店舗）。当日納品の店舗を先に並べ、宅急便の分は最後にまとめて
// 「ここから宅急便」の区切りの後に記載する（kento指示 2026-09-23）。
// 合計（商品合計・消費税・税込合計）は従来どおり当日納品＋宅急便をまとめて1回だけ表示する。
// groups: [{ key, destination, lineItems }]
function InvoiceDocument({ invoiceDate, groups, grandTotals }) {
  const sameDayGroups = groups.filter((g) => g.lineItems.some((li) => isSameDayCategory(li.delivery_category)));

  // 2026-09-23 変更（kento指示）: 宅急便は「発送日→着日」の組み合わせごとに区切り、
  // 見出しを「宅急便 9/23(水)→9/24(木)」の形にする。中1日かかる便（例: 9/23(水)→9/25(金)）
  // などが混ざる場合は、組み合わせごとに別の区切りを立てる。店舗名の横には日付を書かない。
  const takkyuPairs = [];
  groups.forEach((g) => {
    g.lineItems
      .filter((li) => !isSameDayCategory(li.delivery_category))
      .forEach((li) => {
        const ship = li.takkyu_ship_date || "";
        const arrival = li.takkyu_arrival_date || "";
        const key = `${ship}__${arrival}`;
        let pair = takkyuPairs.find((p) => p.key === key);
        if (!pair) {
          pair = { key, ship, arrival, stores: [] };
          takkyuPairs.push(pair);
        }
        let store = pair.stores.find((st) => st.key === g.key);
        if (!store) {
          store = { key: g.key, destination: g.destination, lineItems: [] };
          pair.stores.push(store);
        }
        store.lineItems.push(li);
      });
  });
  takkyuPairs.sort((a, b) => (a.ship || "9999").localeCompare(b.ship || "9999") || (a.arrival || "9999").localeCompare(b.arrival || "9999"));

  const fmtDay = (d) => (d ? `${formatMD(d)}(${weekdayJa(d)})` : "未定");
  const takkyuDivider = (pair) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0 4px", fontSize: 14.4, fontWeight: 700, color: "#333" }}>
      <div style={{ flex: 1, borderTop: "2px dashed #666" }} />
      <span>宅急便 {fmtDay(pair.ship)}→{fmtDay(pair.arrival)}</span>
      <div style={{ flex: 1, borderTop: "2px dashed #666" }} />
    </div>
  );
  return (
    <>
      {sameDayGroups.map((g, idx) => (
        <InvoicePreview
          key={`s-${g.key}`}
          invoiceDate={invoiceDate}
          destination={g.destination}
          lineItems={g.lineItems}
          section="sameDay"
          showTitle={idx === 0}
          showTotals={false}
        />
      ))}
      {takkyuPairs.map((pair, pi) =>
        pair.stores.map((st, si) => (
          <InvoicePreview
            key={`t-${pair.key}-${st.key}`}
            invoiceDate={invoiceDate}
            destination={st.destination}
            lineItems={st.lineItems}
            section="takkyu"
            showTitle={sameDayGroups.length === 0 && pi === 0 && si === 0}
            sectionHeader={si === 0 ? takkyuDivider(pair) : null}
            showTotals={false}
          />
        ))
      )}
      <div data-pdf-block="1" style={{ padding: "0 10mm 8mm", background: "#fff", fontFamily: INVOICE_FONT, color: "#222" }}>
        <div style={{ borderTop: "2px solid #333", paddingTop: 7.2, fontSize: 16.2 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>商品合計</span><span>{fmtYen(grandTotals.subtotal)}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>消費税(8%)</span><span>{fmtYen(grandTotals.tax)}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 16.2, marginTop: 3.6 }}><span>税込合計</span><span>{fmtYen(grandTotals.total)}</span></div>
        </div>
      </div>
    </>
  );
}

/* ============================= 納品書作成 ============================= */
// 納品書作成（STEP5でorder_lines依存を廃止し、①で紐付け・確定したline_actual_items
// から作成する形に作り替えたもの。kento指示: 2026-09-21）。
// 2026-09-21 追加変更（kento指示）: 一店舗ずつではなく、その日の全店舗を
// まとめて（店舗ごとにわかりやすく区切って）1つのA4印刷用プレビューに表示する。
// 保存自体は従来どおりinvoices/invoice_line_itemsに店舗ごとに1件ずつ作る
// （HistoryPanelが店舗単位の閲覧を前提にしているため、データモデルは変更しない）。
function InvoicePanel({ date, onDateChange }) {
  // 2026-09-21 追加変更（kento指示）: 前日など当日以外の納品書も作れるように、
  // タイトル横のカレンダーで対象日を選べるようにする（デフォルトは当日）。
  // 選んだ日付がLINE実績の読み込み・保存・PDFファイル名すべてに反映される。
  // 日付は原稿・発注・チェックと共有（App側のselectedDate）
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [loadErr, setLoadErr] = useState("");

  const loadItems = useCallback(async () => {
    setLoadingItems(true);
    setLoadErr("");
    try {
      const rows = await db.list("line_actual_items", `?order_date=eq.${date}&order=created_at.asc`);
      setItems(rows);
    } catch (e) {
      setLoadErr("読み込みに失敗しました: " + (e.message || e));
    } finally {
      setLoadingItems(false);
    }
  }, [date]);

  useEffect(() => { loadItems(); }, [loadItems]);

  const destinations = useMemo(
    () => [...new Set(items.map((l) => l.destination).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")),
    [items]
  );

  const [err, setErr] = useState("");

  // その日のLINE実績データは、店舗を問わず最初から全件を納品書プレビューに含める
  // （kento指示: 一店舗ごとにチェックして含める/含めないを選ぶ作業は廃止。
  //  間違いがあれば原稿チェック側のページで直す運用のため）。
  const byDestination = useMemo(
    () =>
      destinations.map((dest) => {
        const destLines = items.filter((l) => l.destination === dest);
        const lineItems = buildLineItemsForInvoice(destLines);
        return { destination: dest, destLines, lineItems };
      }),
    [destinations, items]
  );

  // 2026-09-21 追加変更（kento指示）: 保存は店舗ごとではなく、PDF書き出しと同じく
  // 「その日」単位の1つの操作にする。まだ納品書化されていない（invoice_idが
  // 付いていない）実績行だけを対象にし、DB上の実際の状態から判定する
  // （セッション内だけのフラグではなく、ページを開き直しても正しく判定できるように）。
  const unsavedByDestination = useMemo(
    () =>
      destinations
        .map((dest) => {
          const destLines = items.filter((l) => l.destination === dest && !l.invoice_id);
          const lineItems = buildLineItemsForInvoice(destLines);
          return { destination: dest, destLines, lineItems };
        })
        .filter((g) => g.lineItems.length > 0),
    [destinations, items]
  );

  // 1店舗ぶんのinvoices/invoice_line_items作成＋line_actual_itemsへのinvoice_idマーキング。
  const saveGroup = async (group) => {
    const totals = buildInvoiceTotals(group.lineItems);
    const [invoice] = await db.insert("invoices", {
      invoice_date: date,
      destination: group.destination,
      subtotal: totals.subtotal,
      tax: totals.tax,
      total: totals.total,
    });
    // eslint-disable-next-line no-unused-vars
    const rows = group.lineItems.map(({ note, ...li }, idx) => ({ ...li, invoice_id: invoice.id, sort_order: idx }));
    await db.insertMany("invoice_line_items", rows);
    await Promise.all(group.destLines.map((l) => db.update("line_actual_items", l.id, { invoice_id: invoice.id })));
    return invoice;
  };

  // その日の未保存分（店舗をまたいで）をまとめて1つの操作として保存する。
  // 並行実行にすると同じタイミングのinvoice作成やline_actual_itemsの更新が
  // 競合しうるため、あえて直列（for...of + await）で処理する
  // （データ自体は従来どおりinvoices/invoice_line_itemsに店舗ごとに1件ずつ
  //  作る。HistoryPanelが店舗単位の閲覧を前提にしているため）。
  const [savingAll, setSavingAll] = useState(false);

  const saveAll = async () => {
    if (unsavedByDestination.length === 0) return;
    setSavingAll(true);
    setErr("");
    const failedDestinations = [];
    for (const group of unsavedByDestination) {
      try {
        await saveGroup(group);
      } catch (e) {
        failedDestinations.push(group.destination);
      }
    }
    if (failedDestinations.length > 0) {
      setErr(`保存に失敗した店舗があります: ${failedDestinations.join("、")}`);
    }
    await loadItems();
    setSavingAll(false);
  };

  // 2026-09-21 追加変更（kento指示）: 「印刷する」ボタンをやめて、html2canvas+jsPDF で
  // #invoice-print-area をそのままPDFファイルとしてダウンロードする「PDFで保存」ボタンにする。
  // A4の縦幅に収まらない分は自動で複数ページに分割する。
  const [savingPdf, setSavingPdf] = useState(false);
  const previewScalerRef = useRef(null);
  const savePdfAll = async () => {
    const node = document.getElementById("invoice-print-area");
    if (!node) return;
    setSavingPdf(true);
    setErr("");
    try {
      await exportA4Pdf(node, `納品書_${date}.pdf`);
    } catch (e) {
      setErr("PDF保存に失敗しました: " + (e.message || e));
    } finally {
      setSavingPdf(false);
    }
  };

  const printableGroups = byDestination.filter((g) => g.lineItems.length > 0);
  // 2026-09-21 追加変更（kento指示）: 店舗ごとの合計は出さず、その日にまとめて
  // 作成する納品書全体で「商品合計＋消費税＝合計」を1回だけ表示する。
  const grandTotals = buildInvoiceTotals(printableGroups.flatMap((g) => g.lineItems));

  const saveDisabled = savingAll || unsavedByDestination.length === 0;

  return (
    <div>
      <DateHeader title="納品書作成" date={date} onDateChange={onDateChange}>
        <button
          style={{
            ...btn(true),
            ...(saveDisabled ? { background: T.border, borderColor: T.border, color: "#fff", cursor: "default" } : {}),
          }}
          disabled={saveDisabled}
          onClick={saveAll}
        >
          {savingAll ? "保存中..." : "保存"}
        </button>
      </DateHeader>
      {loadErr && <div style={{ color: T.warn, marginBottom: 12 }}>{loadErr}</div>}
      {err && <div style={{ color: T.warn, marginBottom: 12 }}>{err}</div>}
      {loadingItems && <p style={{ fontSize: 13, color: T.textSub }}>読み込み中...</p>}

      {destinations.length === 0 ? (
        <p style={{ color: T.textSub, fontSize: 13 }}>この日のLINE実績データに納品先がありません。</p>
      ) : (
        <>
          {printableGroups.length > 0 && (
            <section style={card()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <h3 style={{ ...h3(), marginBottom: 0 }}>プレビュー（A4印刷用）</h3>
                <button style={btn(true)} disabled={savingPdf} onClick={savePdfAll}>{savingPdf ? "PDF作成中..." : "PDFで保存"}</button>
              </div>
              <A4PreviewScaler ref={previewScalerRef}>
                <div id="invoice-print-area" style={{ position: "relative", width: "210mm", maxWidth: "none", margin: "0 auto", background: "#fff", border: `1px solid ${T.softBorder}` }}>
                  <InvoiceDocument
                    invoiceDate={date}
                    groups={printableGroups.map((g) => ({ key: g.destination, destination: g.destination, lineItems: g.lineItems }))}
                    grandTotals={grandTotals}
                  />
                </div>
              </A4PreviewScaler>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/* ============================= 納品書履歴 ============================= */
function HistoryPanel() {
  const [startDate, setStartDate] = useState(todayStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [invoices, setInvoices] = useState([]);
  const [listLineItems, setListLineItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // 2026-09-21 追加変更（kento指示）: 履歴は店舗ごとではなく日付単位の一覧にする。
  // タップするとその日にまとめて作成した納品書（全店舗分）をプレビューできる。
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedGroups, setSelectedGroups] = useState([]); // [{ invoice, items }]（店舗ごと。表示は日付単位でまとめる）
  const [loadingDetail, setLoadingDetail] = useState(false);
  const previewRef = useRef(null);

  // 2026-09-21 追加変更（kento指示）: 選択した日付の利益を表示する。
  // 売値は明細ごとに入力・保存でき（未入力ならcomputeSellPriceで自動計算）、
  // 入力欄は「id -> 編集中の文字列」で保持し、フォーカスを外したタイミングでDB保存する。
  const [sellPriceDrafts, setSellPriceDrafts] = useState({});
  const [savingSellPriceId, setSavingSellPriceId] = useState(null);

  const search = useCallback(async () => {
    setLoading(true);
    setErr("");
    setSelectedDate(null);
    setSelectedGroups([]);
    try {
      const rows = await db.list(
        "invoices",
        `?invoice_date=gte.${startDate}&invoice_date=lte.${endDate}&order=invoice_date.desc,destination.asc`
      );
      setInvoices(rows);
      // 2026-09-23 追加（kento指示）: 一覧の各日付に利益も出すため、明細の金額・売値だけまとめて読む
      if (rows.length > 0) {
        try {
          const ids = rows.map((r) => r.id).join(",");
          const lis = await db.list("invoice_line_items", `?invoice_id=in.(${ids})&select=id,invoice_id,amount,sell_price`);
          setListLineItems(lis);
        } catch (e) {
          setListLineItems([]);
        }
      } else {
        setListLineItems([]);
      }
    } catch (e) {
      setErr("検索に失敗しました: " + (e.message || e));
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => { search(); }, [search]);

  // invoicesを日付単位にグループ化（一覧・削除・プレビューはすべてこの単位で行う）。
  const dateGroups = useMemo(() => {
    const groups = [];
    invoices.forEach((inv) => {
      let g = groups.find((x) => x.date === inv.invoice_date);
      if (!g) { g = { date: inv.invoice_date, invoices: [], total: 0, subtotal: 0, profit: 0 }; groups.push(g); }
      g.invoices.push(inv);
      g.total += inv.total || 0;
      // 2026-09-23 変更（kento指示）: 一覧の金額は税抜（商品合計）で表示する
      g.subtotal += inv.subtotal || 0;
    });
    groups.forEach((g) => {
      const ids = new Set(g.invoices.map((inv) => inv.id));
      g.profit = buildProfitTotals(listLineItems.filter((li) => ids.has(li.invoice_id))).profit;
    });
    return groups;
  }, [invoices, listLineItems]);

  const openDate = async (group) => {
    // 2026-09-21 追加変更（kento指示）: 同じ日付をもう一度タップしたらプレビューを閉じる。
    if (selectedDate === group.date) {
      setSelectedDate(null);
      setSelectedGroups([]);
      return;
    }
    setSelectedDate(group.date);
    setSelectedGroups([]);
    setLoadingDetail(true);
    setErr("");
    try {
      const groups = await Promise.all(
        group.invoices.map(async (inv) => {
          const items = await db.list("invoice_line_items", `?invoice_id=eq.${inv.id}&order=sort_order.asc`);
          // 備考はLINE実績データ(line_actual_items)側から読み直す（納品書では品目の右隣に表示）
          const lineIds = items.map((it) => it.line_actual_item_id).filter(Boolean);
          if (lineIds.length > 0) {
            try {
              const lines = await db.list("line_actual_items", `?id=in.(${lineIds.join(",")})&select=id,note`);
              const noteById = new Map(lines.map((l) => [l.id, l.note || ""]));
              items.forEach((it) => { it.note = noteById.get(it.line_actual_item_id) || ""; });
            } catch (e) {
              // 備考が読めなくても納品書自体は表示する
            }
          }
          return { invoice: inv, items };
        })
      );
      groups.sort((a, b) => a.invoice.destination.localeCompare(b.invoice.destination, "ja"));
      setSelectedGroups(groups);
      const drafts = {};
      groups.forEach((g) => g.items.forEach((it) => { drafts[it.id] = it.sell_price != null ? String(it.sell_price) : ""; }));
      setSellPriceDrafts(drafts);
    } catch (e) {
      setErr("納品書明細の取得に失敗しました: " + (e.message || e));
    } finally {
      setLoadingDetail(false);
    }
  };

  // 2026-09-21 追加変更（kento指示）: 売値を明細ごとに編集・保存する。
  // 空欄に戻せば自動計算（computeSellPrice）に戻る。
  const updateSellPrice = async (itemId, rawValue) => {
    const value = rawValue.trim() === "" ? null : Number(rawValue);
    if (value != null && Number.isNaN(value)) return;
    setSavingSellPriceId(itemId);
    setErr("");
    try {
      await db.update("invoice_line_items", itemId, { sell_price: value });
      setSelectedGroups((prev) =>
        prev.map((g) => ({ ...g, items: g.items.map((it) => (it.id === itemId ? { ...it, sell_price: value } : it)) }))
      );
      setListLineItems((prev) => prev.map((li) => (li.id === itemId ? { ...li, sell_price: value } : li)));
    } catch (e) {
      setErr("売値の保存に失敗しました: " + (e.message || e));
    } finally {
      setSavingSellPriceId(null);
    }
  };

  // 納品書履歴の削除機能。その日にある全店舗分のinvoice_line_items（明細）と
  // invoices（本体）を削除し、元になったline_actual_itemsのinvoice_idをnullに
  // 戻す（納品書作成ページで「未保存」として再度扱えるようにするため）。
  const [deletingDate, setDeletingDate] = useState(null);
  const deleteDate = async (group) => {
    if (!window.confirm(`${group.date} の納品書（${group.invoices.length}件）を削除しますか？\nこの操作は取り消せません。`)) return;
    setDeletingDate(group.date);
    setErr("");
    try {
      for (const inv of group.invoices) {
        await db.removeWhere("invoice_line_items", `?invoice_id=eq.${inv.id}`);
        await db.updateWhere("line_actual_items", `?invoice_id=eq.${inv.id}`, { invoice_id: null });
        await db.remove("invoices", inv.id);
      }
      if (selectedDate === group.date) {
        setSelectedDate(null);
        setSelectedGroups([]);
      }
      await search();
    } catch (e) {
      setErr("削除に失敗しました: " + (e.message || e));
    } finally {
      setDeletingDate(null);
    }
  };

  const grandTotals = buildInvoiceTotals(selectedGroups.flatMap((g) => g.items));
  const profitTotals = buildProfitTotals(selectedGroups.flatMap((g) => g.items));

  // 2026-09-21 追加変更（kento指示）: 履歴側のダウンロードも、納品書作成ページの
  // 「PDFで保存」と同じくその日の全店舗分をまとめて1つのPDFにする。
  const [savingPdf, setSavingPdf] = useState(false);
  const previewScalerRef = useRef(null);
  const savePdf = async () => {
    if (!previewRef.current || !selectedDate) return;
    setSavingPdf(true);
    setErr("");
    try {
      await exportA4Pdf(previewRef.current, `納品書_${selectedDate}.pdf`);
    } catch (e) {
      setErr("PDF保存に失敗しました: " + (e.message || e));
    } finally {
      setSavingPdf(false);
    }
  };

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
          ) : dateGroups.length === 0 ? (
            <p style={{ color: T.textSub, fontSize: 13 }}>該当する納品書はありません。</p>
          ) : (
            dateGroups.map((g) => (
              <div
                key={g.date}
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 8px",
                  borderRadius: 6, fontSize: 13,
                  background: selectedDate === g.date ? T.panel : "transparent",
                }}
              >
                <span onClick={() => openDate(g)} style={{ cursor: "pointer", flex: 1 }}>
                  {g.date}（{weekdayJa(g.date)}）
                </span>
                <span onClick={() => openDate(g)} style={{ cursor: "pointer", marginRight: 10, textAlign: "right" }}>
                  {fmtYen(g.subtotal)}
                  <span style={{ marginLeft: 8, color: T.green, fontSize: 12 }}>利益 {fmtYen(g.profit)}</span>
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteDate(g); }}
                  disabled={deletingDate === g.date}
                  title="削除"
                  style={{ border: "none", background: "transparent", color: T.warn, cursor: "pointer", fontSize: 12, padding: "2px 4px" }}
                >
                  {deletingDate === g.date ? "削除中..." : "削除"}
                </button>
              </div>
            ))
          )}
        </section>

        {selectedDate && (
          <section style={{ ...card(), flex: "1 1 400px", minWidth: 0 }}>
            {loadingDetail ? (
              <p>読み込み中...</p>
            ) : (
              <>
                <A4PreviewScaler ref={previewScalerRef}>
                  <div ref={previewRef} style={{ position: "relative", width: "210mm", maxWidth: "none", background: "#fff" }}>
                    <InvoiceDocument
                      invoiceDate={selectedDate}
                      groups={selectedGroups.map((g) => ({ key: g.invoice.id, destination: g.invoice.destination, lineItems: g.items }))}
                      grandTotals={grandTotals}
                    />
                  </div>
                </A4PreviewScaler>
                <div style={{ marginTop: 12, textAlign: "center" }}>
                  <button style={btn(true)} disabled={savingPdf} onClick={savePdf}>{savingPdf ? "PDF作成中..." : "PDFで保存"}</button>
                </div>

                {/* 2026-09-21 追加（kento指示）: 選択した日付の利益。
                    仕入れ値＝納品書明細の金額(amount)。売値は明細ごとに入力・保存でき、
                    未入力なら仕入単価×1.15（単価1万円以上は1.1）を100円単位に切り上げた売値単価×目方/数量で自動計算（税抜）。 */}
                <div style={{ marginTop: 20 }}>
                  <h3 style={h3()}>利益（{selectedDate}）</h3>
                  <div style={{ marginBottom: 10, fontSize: 13, color: T.textSub }}>
                    仕入れ値合計 {fmtYen(profitTotals.cost)}　/　売値合計 {fmtYen(profitTotals.sell)}
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={table()}>
                      <thead>
                        <tr>
                          <th style={th()}>店舗</th>
                          <th style={th()}>品目</th>
                          <th style={{ ...th(), textAlign: "right" }}>仕入れ値</th>
                          <th style={{ ...th(), textAlign: "right" }}>売値</th>
                          <th style={{ ...th(), textAlign: "right" }}>利益</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedGroups.map((g) =>
                          g.items.map((it) => {
                            const sell = computeSellPrice(it);
                            const itemProfit = sell - (it.amount || 0);
                            return (
                              <tr key={it.id}>
                                <td style={td()}>{g.invoice.destination}</td>
                                <td style={td()}>{it.item_name}</td>
                                <td style={{ ...td(), textAlign: "right" }}>{fmtYen(it.amount)}</td>
                                <td style={{ ...td(), textAlign: "right" }}>
                                  <input
                                    style={{ ...inputStyle(), width: 90, textAlign: "right" }}
                                    placeholder={String(computeSellPrice({ ...it, sell_price: null }))}
                                    value={sellPriceDrafts[it.id] ?? ""}
                                    disabled={savingSellPriceId === it.id}
                                    onChange={(e) => setSellPriceDrafts((prev) => ({ ...prev, [it.id]: e.target.value }))}
                                    onBlur={(e) => updateSellPrice(it.id, e.target.value)}
                                  />
                                  {computeSellUnitPrice(it.unit_price) != null && (it.sell_price == null || it.sell_price === "") && (
                                    <div style={{ fontSize: 10, color: T.textSub }}>
                                      @{fmtYen(computeSellUnitPrice(it.unit_price))}/{it.price_unit || "?"}
                                    </div>
                                  )}
                                </td>
                                <td style={{ ...td(), textAlign: "right", fontWeight: 600 }}>{fmtYen(itemProfit)}</td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ marginTop: 10, borderTop: `2px solid ${T.border}`, paddingTop: 8, fontSize: 15, fontWeight: 700, display: "flex", justifyContent: "space-between" }}>
                    <span>利益</span>
                    <span>{fmtYen(profitTotals.profit)}</span>
                  </div>
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
