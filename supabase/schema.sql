-- sumikura-slip: 発注・納品管理アプリ DB スキーマ
-- Supabase の SQL Editor にそのまま貼り付けて実行してください。
-- 商品マスタは作らず、「今回の発注リストの1行」を基準データとする設計（開発指示書 4章参照）。

-- 1. 原稿バッチ（1回の原稿読み込み = 1バッチ）
create table if not exists manuscript_batches (
  id uuid primary key default gen_random_uuid(),
  manuscript_date date not null default current_date,
  source_type text not null default 'kadokura_paste', -- 現状は角倉タブ形式の貼り付けのみ
  source_filename text,
  raw_grid_text text, -- TSV化した原稿全文（再解析・デバッグ用に保持）
  created_at timestamptz not null default now()
);

-- 2. 原稿商品（原稿から抽出した品目）
create table if not exists manuscript_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references manuscript_batches(id) on delete cascade,
  item_name text not null,
  origin text default '',        -- 産地（未記載なら空文字）
  spec text default '',          -- 規格（例: 1.5kg, 10本 など原稿記載のサイズ表記）
  unit_price numeric not null,   -- 単価の数値
  price_unit text not null,      -- 単価単位: kg / 本 / 尾 / 個 / 箱 / 束 / 枚 / 杯 / その他自由入力
  raw_line text,                 -- 原文（表記違いの突合デバッグ用）
  created_at timestamptz not null default now()
);
create index if not exists idx_manuscript_items_batch on manuscript_items(batch_id);

-- 3. 発注行（中心データ）。1行 = 発注行ID（例: 20260917-001）に相当。
create table if not exists order_lines (
  id uuid primary key default gen_random_uuid(),
  line_code text unique,                    -- 表示用の発注行ID（例: 20260917-001）
  order_date date not null default current_date,
  delivery_date date,                       -- 納品日
  delivery_time_note text default '',       -- 納品時間帯の自由記述（例: 午前中）
  destination text not null default '',     -- 納品先
  item_name text not null,
  origin text default '',
  quantity numeric,
  quantity_unit text default '本',
  weight text default '',                   -- 目方（自由入力: "1.5kg" 等。数値化できない表記もあるためtext）
  request_note text default '',             -- 要望
  delivery_category text not null default 'ground'
    check (delivery_category in ('air','ground','takkyu')), -- 当日航空便/当日配送便/翌日宅急便
  takkyu_ship_date date,                    -- 宅急便: 発送日
  takkyu_arrival_date date,                 -- 宅急便: 着日

  -- 原稿紐付け（ユーザーが手動選択。AI自動照合は使わない）
  manuscript_item_id uuid references manuscript_items(id) on delete set null,
  manuscript_price_status text not null default 'none'
    check (manuscript_price_status in ('linked','none')), -- 'none' = 原稿価格なし

  -- 出荷チェック
  shipped_checked boolean not null default false,

  -- 実納品情報（原稿単価は上書きしない。別フィールドで保持）
  actual_quantity numeric,
  actual_weight numeric,        -- kg数値（単価計算用）
  actual_unit_price numeric,
  actual_unit_price_unit text,  -- 実納品単価の単位（原稿単位と異なる場合の編集用）

  invoice_id uuid,              -- 納品書生成後にセット（invoices.id）

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_order_lines_date on order_lines(order_date);
create index if not exists idx_order_lines_destination on order_lines(destination);
create index if not exists idx_order_lines_invoice on order_lines(invoice_id);

-- 4. 納品書（ヘッダ）
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_date date not null default current_date,
  destination text not null default '',
  subtotal numeric not null default 0,   -- 商品合計
  tax numeric not null default 0,        -- 消費税（1円単位四捨五入後）
  total numeric not null default 0,      -- 税込合計
  image_path text,                       -- Supabase Storageのパス（PNG/JPEG）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_invoices_date on invoices(invoice_date);
create index if not exists idx_invoices_destination on invoices(destination);

-- 5. 納品書明細（生成時点のスナップショット。後から発注行を編集しても過去の納品書は変わらない）
create table if not exists invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  order_line_id uuid references order_lines(id) on delete set null,
  item_name text not null,
  origin text default '',
  quantity numeric,
  quantity_unit text default '',
  weight numeric,
  unit_price numeric,
  price_unit text,
  amount numeric not null default 0,
  delivery_category text,
  takkyu_ship_date date,
  takkyu_arrival_date date,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_invoice_line_items_invoice on invoice_line_items(invoice_id);

-- RLS: 社内利用のみ・ログイン機能なしのため、anon keyで読み書きできるよう無効化しておく。
-- （UMAMI stockと同じ運用。将来ログインを導入する場合はここにポリシーを追加する）
alter table manuscript_batches disable row level security;
alter table manuscript_items disable row level security;
alter table order_lines disable row level security;
alter table invoices disable row level security;
alter table invoice_line_items disable row level security;

-- 権限付与: RLSを無効化しても、anon/authenticatedロールに明示的なGRANTが無いと
-- 「permission denied for table ...」になることがあるため、ここで付与しておく。
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  manuscript_batches,
  manuscript_items,
  order_lines,
  invoices,
  invoice_line_items
to anon, authenticated;
