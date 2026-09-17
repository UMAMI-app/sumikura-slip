# すみくら伝票（sumikura-slip）

旨味フーズの発注・出荷・納品書作成業務を1つのアプリで完結させるための社内向けWebアプリ。
開発指示書に基づき実装。

## 技術スタック
UMAMI stock（尼崎市場 在庫管理アプリ）と同じ構成。
- React + Vite
- Supabase（PostgREST経由の素のfetch呼び出し。SDKは使わず`src/lib/supabase.js`のsbFetchで統一）
- Vercelでの静的ホスティングを想定
- ログイン機能なし（社内利用のみ）

## 原稿読み込みについて（既存アプリからの移植）
既存アプリ「案内生成アプリ」(UMAMI-app/info-generate, upload.html) の原稿読み込み処理を
調査のうえ、コード・ロジックを移植した（既存アプリ自体は一切変更していない）。

- `public/pure_snappy.py` `public/numbers_to_tsv.py` … info-generateからそのままコピー
- `src/lib/manuscript.js` … Pyodide初期化、TSVグリッド解析(parseGrid)、価格解析(parsePrice)、
  産地・サイズのテキスト整形ヘルパーは移植。案内文生成（カテゴリー分類・絵文字装飾等）の
  ロジックは持ち込まず、この新アプリ向けに「品目・産地・規格・単価・単価単位」を抽出する
  `extractManuscriptItems()` を新規実装している。

## セットアップ

```bash
npm install
```

### Supabase設定（必須）
1. https://supabase.com で新規プロジェクトを作成
2. SQL Editorで `supabase/schema.sql` の内容を実行してテーブルを作成
3. Storage で `invoices` という名前のバケットを作成（Public推奨。納品書画像の保存用。※現バージョンでは画像はブラウザからのダウンロードのみ対応、Storageアップロードは未実装）
4. Project Settings → API から Project URL と anon public key を取得
5. `src/lib/supabase.js` の `SUPABASE_URL` / `SUPABASE_KEY` を書き換える

### 開発サーバー起動
```bash
npm run dev
```

### ロジックのテスト（Node上で単価計算・原稿解析ロジックを検証）
```bash
node scripts/test-pricing.mjs
node scripts/test-manuscript.mjs
```

### ビルド
```bash
npm run build
```

## 現在の実装状況（MVP）
- [x] 原稿読み込み（.numbersファイル直接読込 / テキスト貼り付けの両対応）
- [x] 発注一覧（当日航空便・当日配送便・翌日宅急便で表示分け、編集可能）
- [x] 出荷チェック
- [x] 原稿商品への手動紐付け（AI自動照合なし）、原稿にない商品は「原稿価格なし」
- [x] 実目方・実納品単価の入力
- [x] 原稿単価との照合（高くなった場合のみ警告、安くなった場合は通常表示）
- [x] kg単価・個数単価等、単位に応じた金額計算
- [x] 消費税8%・1円単位四捨五入
- [x] 納品書生成（当日納品／宅急便の区分表示、宅急便は発送日→着日を表示）
- [x] 納品書のPNG画像ダウンロード
- [x] 納品書元データのDB保存（invoices / invoice_line_items）
- [x] 納品書履歴（日付範囲指定、過去の納品書の再表示）

## 未実装・要相談
- 発注リストの一括インポート: 実際の発注リストのフォーマット（どのシステムから、どんな形式で
  出力されるか）が未確認のため、現状は「1件ずつ手動追加」または「タブ区切りテキストの
  一括貼り付け（仮フォーマット）」のみ対応。実際のフォーマットが分かり次第、専用のインポート
  処理に差し替える。
- 納品書画像のSupabase Storageへの自動アップロード（現在はブラウザへのダウンロードのみ）
