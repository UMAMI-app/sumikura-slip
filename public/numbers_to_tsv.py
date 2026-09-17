"""
.numbers ファイルを、既存の案内文生成アプリ(index.html)がそのまま食べられる
タブ区切りテキスト(TSVグリッド)に変換する。

やること:
1. 非表示行(Numbers上で手動で隠した行)を除外する
   -> コピペなら自動的に除外されるが、ファイルから直接読む場合は明示的に除く必要がある
2. セル結合(新カテゴリー・キャンペーンの見出しバナー等)は、先頭セルにのみ値を残し、
   結合の他のセルは空にする(コピペした場合と同じ見た目にする)
3. 1行バナー(4列ブロックいっぱいに結合されたセル)については、背景色を見て
   「そのバナーと同じ色が続く範囲」を特定し、色が変わったところ以降の行を
   バナーより前に並べ替える。これにより、キャンペーン対象外の品目が
   誤ってそのカテゴリーに巻き込まれるのを防ぐ(色情報が無いコピペでは出来なかった改善点)。
"""
import re

import numbers_parser


def col_letters_to_index(s):
    n = 0
    for ch in s:
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n - 1


def parse_range(range_str):
    m = re.match(r"^([A-Z]+)(\d+):([A-Z]+)(\d+)$", range_str)
    c1, r1, c2, r2 = m.group(1), int(m.group(2)), m.group(3), int(m.group(4))
    return (r1 - 1, col_letters_to_index(c1), r2 - 1, col_letters_to_index(c2))


def get_hidden_rows(model, table_obj):
    """Numbers内部のオブジェクトモデルを読み、ユーザーが手動で非表示にした行の
    0始まり行インデックスの集合を返す。"""
    hidden = set()
    bcru_ref = table_obj.base_column_row_uids
    bcru = model.objects[bcru_ref.identifier]
    uid_to_index = {}
    for i, uid in enumerate(bcru.sorted_row_uids):
        uid_to_index[(uid.lower, uid.upper)] = bcru.row_index_for_uid[i]

    hso = table_obj.hidden_states_owner
    for hs in hso.hidden_states:
        for bh in hs.row_hidden_state_extent.base_hidden_states:
            if bh.user_hidden:
                key = (bh.row_or_column_uid.lower, bh.row_or_column_uid.upper)
                if key in uid_to_index:
                    hidden.add(uid_to_index[key])
    return hidden


def color_key(bg):
    """背景色を比較可能な値に変換する。単色は(r,g,b)、グラデーション(複数色のリスト)は
    その色のタプルのタプルにする。どちらでも「同じ色かどうか」の比較に使えれば良い。"""
    if bg is None:
        return None
    if isinstance(bg, list):
        return tuple((c.r, c.g, c.b) for c in bg)
    return (bg.r, bg.g, bg.b)


def find_target_table(doc):
    """ファイル内には無関係な表(ピボットテーブルや別の取引先向けの表など)が
    複数含まれていることがあるため、「魚種」「サイズ」の見出しが並んでいる表を
    全シート・全テーブルから探して、それを解析対象にする。
    見つからない場合は先頭の表にフォールバックする。"""
    for sheet in doc.sheets:
        for table in sheet.tables:
            for r in range(table.num_rows):
                for c in range(table.num_cols - 1):
                    if table.cell(r, c).value == "魚種" and table.cell(r, c + 1).value == "サイズ":
                        return table
    return doc.sheets[0].tables[0]


def build_tsv_from_numbers(path):
    doc = numbers_parser.Document(path)
    table = find_target_table(doc)
    model = doc._model
    tobj = model.objects[table._table_id]

    num_rows = table.num_rows
    num_cols = table.num_cols

    hidden_rows = get_hidden_rows(model, tobj)

    # マスターセルの位置 -> 結合範囲の終端(行,列)
    merge_spans = {}
    for rng in table.merge_ranges:
        r1, c1, r2, c2 = parse_range(rng)
        merge_spans[(r1, c1)] = (r2, c2)

    covered = set()
    for (r1, c1), (r2, c2) in merge_spans.items():
        for rr in range(r1, r2 + 1):
            for cc in range(c1, c2 + 1):
                if (rr, cc) != (r1, c1):
                    covered.add((rr, cc))

    raw_rows = []  # [(元の行番号, [各列の値]), ...] 非表示行は除外済み
    for r in range(num_rows):
        if r in hidden_rows:
            continue
        row_vals = []
        for c in range(num_cols):
            if (r, c) in covered:
                row_vals.append("")
            else:
                v = table.cell(r, c).value
                row_vals.append("" if v is None else str(v))
        raw_rows.append((r, row_vals))

    # 4列区切りでブロック化(魚種/サイズ/産地/単価 の繰り返し)
    if num_cols % 4 == 0 and num_cols > 0:
        blocks = [(i, i + 4) for i in range(0, num_cols, 4)]
    else:
        blocks = [(0, num_cols)]

    block_row_lists = []
    for (cs, ce) in blocks:
        rows_in_block = []
        for (orig_r, vals) in raw_rows:
            cell0 = table.cell(orig_r, cs)
            bg = color_key(cell0.style.bg_color) if cell0.style else None
            span = merge_spans.get((orig_r, cs))
            is_banner = bool(span and span == (orig_r, ce - 1))
            rows_in_block.append(
                {"orig_r": orig_r, "vals": vals[cs:ce], "bg": bg, "is_banner": is_banner}
            )

        # 「バナー行」であっても、直後の行が同じ色で続いていない(=単発の注記であって
        # 複数行にまたがるキャンペーン区画ではない)場合は並べ替えの対象にしない。
        # そうしないと、単発の注記(見出し直後の説明文など)まで「境界探し」の対象になり、
        # ブロック全体を無意味にシャッフルしてしまう。
        reordered = list(rows_in_block)
        i = 0
        while i < len(reordered):
            if reordered[i]["is_banner"] and i + 1 < len(reordered) and reordered[i + 1]["bg"] == reordered[i]["bg"]:
                banner_bg = reordered[i]["bg"]
                boundary = None
                j = i + 1
                while j < len(reordered):
                    if reordered[j]["bg"] != banner_bg:
                        boundary = j
                        break
                    j += 1
                if boundary is not None:
                    tail = reordered[boundary:]
                    reordered = reordered[:i] + tail + reordered[i:boundary]
                    i += len(tail)
                    continue
            i += 1

        block_row_lists.append([item["vals"] for item in reordered])

    max_len = max((len(b) for b in block_row_lists), default=0)
    combined_lines = []
    for i in range(max_len):
        row_cells = []
        for bi, block in enumerate(block_row_lists):
            width = blocks[bi][1] - blocks[bi][0]
            if i < len(block):
                row_cells.extend(block[i])
            else:
                row_cells.extend([""] * width)
        combined_lines.append("\t".join(row_cells))

    return "\n".join(combined_lines)
