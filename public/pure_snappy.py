"""
純Pythonのsnappy展開(decompressのみ)。

Pyodide(ブラウザ内Python)には python-snappy(C拡張)が無いため、
numbers_parser が呼び出す snappy.uncompress() だけを純Pythonで肩代わりする。
圧縮(compress)は読み込み専用の用途では不要なので実装しない。

フォーマット定義: https://github.com/google/snappy/blob/main/format_description.txt
"""


class UncompressError(Exception):
    pass


def _read_varint(data, pos):
    result = 0
    shift = 0
    while True:
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, pos


def uncompress(data):
    if len(data) == 0:
        return b""
    length, pos = _read_varint(data, 0)
    out = bytearray()
    n = len(data)
    while pos < n:
        tag = data[pos]
        pos += 1
        kind = tag & 0x3
        if kind == 0:  # literal
            higher = tag >> 2
            if higher < 60:
                lit_len = higher + 1
            else:
                extra = higher - 59
                lit_len = int.from_bytes(data[pos:pos + extra], "little") + 1
                pos += extra
            out += data[pos:pos + lit_len]
            pos += lit_len
        elif kind == 1:  # copy, 1-byte offset
            lit_len = ((tag >> 2) & 0x7) + 4
            offset = ((tag >> 5) << 8) | data[pos]
            pos += 1
            _copy(out, offset, lit_len)
        elif kind == 2:  # copy, 2-byte offset
            lit_len = (tag >> 2) + 1
            offset = int.from_bytes(data[pos:pos + 2], "little")
            pos += 2
            _copy(out, offset, lit_len)
        else:  # kind == 3, copy, 4-byte offset
            lit_len = (tag >> 2) + 1
            offset = int.from_bytes(data[pos:pos + 4], "little")
            pos += 4
            _copy(out, offset, lit_len)

    if len(out) != length:
        # 長さが一致しなくても、呼び出し側(numbers_parser)は例外時に
        # 「圧縮されていないデータかもしれない」とみなして生データにフォールバックするため、
        # ここでは例外にしておく
        raise UncompressError(
            f"decompressed length mismatch: expected {length}, got {len(out)}"
        )
    return bytes(out)


def _copy(out, offset, length):
    start = len(out) - offset
    if start < 0:
        raise UncompressError("invalid copy offset")
    # snappyのcopyはoffset<lengthの場合(直前の繰り返しパターン)もあるので1バイトずつ追記する
    for i in range(length):
        out.append(out[start + i])


# numbers_parser 側は `snappy.uncompress(chunk)` としてしか呼ばないため、
# python-snappy 互換のエイリアスだけ用意しておく
decompress = uncompress
