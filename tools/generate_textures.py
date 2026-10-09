#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
マルチプレイ建築支援アドオン テクスチャ生成スクリプト

アイテムのドット絵（16x16 / RGBA）と、BP・RP の pack_icon.png（256x256）を
コードから生成する。公式素材は一切使用していない。

使い方:
    pip install pillow
    python tools/generate_textures.py

各アイテムは「パレット辞書」+「16行 x 16文字のグリッド」で定義されている。
色や形を変えたい場合はここを書き換えて再実行するだけでよい。
行数が16でない／1行が16文字でない／パレットに無い文字が混じっている場合は
エラーで止まるので、壊れたPNGが出ることはない。
"""

from __future__ import annotations

import os
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("Pillow が必要です。`pip install pillow` を実行してください。")


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ITEMS_DIR = os.path.join(ROOT, "BuildHelperRP", "textures", "items")
SIZE = 16

# ---------------------------------------------------------------------------
# 設計図ツール — 方眼の入った青焼き図面
# ---------------------------------------------------------------------------

BLUEPRINT_PALETTE = {
    ".": None,                     # 透明
    "o": (18, 28, 54, 255),        # アウトライン（濃紺）
    "B": (38, 86, 158, 255),       # 図面の青
    "W": (198, 224, 255, 255),     # 方眼の線
    "Y": (240, 196, 76, 255),      # 選択マーカー（金）
}

BLUEPRINT_WAND = [
    "................",
    "..oooooooooooo..",
    ".oYYBBBBBBBBBBo.",
    ".oYYBBBWBBBWBBo.",
    ".oBBBBBWBBBWBBo.",
    ".oBBBBBWBBBWBBo.",
    ".oWWWWWWWWWWWWo.",
    ".oBBBBBWBBBWBBo.",
    ".oBBBBBWBBBWBBo.",
    ".oWWWWWWWWWWWWo.",
    ".oBBBBBWBBBWBBo.",
    ".oBBBBBWBBBWBBo.",
    ".oBBBBBWBBBWBBo.",
    ".oBBBBBBBBBBBBo.",
    "..oooooooooooo..",
    "................",
]

# ---------------------------------------------------------------------------
# 集合ビーコン — 金枠の中で光る青い結晶
# ---------------------------------------------------------------------------

BEACON_PALETTE = {
    ".": None,
    "o": (26, 22, 12, 255),        # アウトライン（焦げ茶）
    "Y": (226, 176, 58, 255),      # 金の枠
    "L": (168, 236, 245, 255),     # 明るい水色
    "C": (44, 138, 176, 255),      # 深い水色
}

RALLY_BEACON = [
    "................",
    "......oooo......",
    ".....oYYYYo.....",
    "....oYLLLLYo....",
    "...oYLCCCCLYo...",
    "..oYLCCCCCCLYo..",
    "..oYLCCLLCCLYo..",
    "..oYLCLLLLCLYo..",
    "..oYLCLLLLCLYo..",
    "..oYLCCLLCCLYo..",
    "..oYLCCCCCCLYo..",
    "...oYLCCCCLYo...",
    "....oYLLLLYo....",
    ".....oYYYYo.....",
    "......oooo......",
    "................",
]

# ---------------------------------------------------------------------------
# ガイドブック — 金の紋章が入った青い本
# ---------------------------------------------------------------------------

BOOK_PALETTE = {
    ".": None,
    "o": (20, 20, 34, 255),        # アウトライン
    "C": (46, 74, 140, 255),       # 表紙の青
    "Y": (226, 186, 84, 255),      # 金の紋章
    "W": (232, 226, 202, 255),     # ページの小口
}

GUIDE_BOOK = [
    "................",
    "...oooooooooo...",
    "..oCCCCCCCCCCo..",
    ".oCCCCCCCCCCCCo.",
    ".oCCYYYYYYCCCWo.",
    ".oCCYooooYCCCWo.",
    ".oCCYoCCoYCCCWo.",
    ".oCCYoCCoYCCCWo.",
    ".oCCYooooYCCCWo.",
    ".oCCYYYYYYCCCWo.",
    ".oCCCCCCCCCCCWo.",
    ".oCCCCCCCCCCCWo.",
    "..oCCCCCCCCCWo..",
    "...oooooooooo...",
    "................",
    "................",
]

ITEMS = {
    "blueprint_wand": (BLUEPRINT_PALETTE, BLUEPRINT_WAND),
    "rally_beacon": (BEACON_PALETTE, RALLY_BEACON),
    "guide_book": (BOOK_PALETTE, GUIDE_BOOK),
}


def validate(name: str, palette: dict, grid: list[str]) -> None:
    if len(grid) != SIZE:
        sys.exit(f"{name}: 行数が {len(grid)} です（期待値 {SIZE}）")
    for y, row in enumerate(grid):
        if len(row) != SIZE:
            sys.exit(f"{name}: {y} 行目の文字数が {len(row)} です（期待値 {SIZE}）")
        for ch in row:
            if ch not in palette:
                sys.exit(f"{name}: {y} 行目にパレット未定義の文字 '{ch}' があります")


def render(palette: dict, grid: list[str]) -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    px = img.load()
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            color = palette[ch]
            if color is not None:
                px[x, y] = color
    return img


def make_pack_icon(source: Image.Image) -> Image.Image:
    """アイテムのドット絵を拡大し、濃紺の背景に載せて 256x256 のパックアイコンにする。"""
    icon = Image.new("RGBA", (256, 256), (22, 32, 58, 255))
    art = source.resize((208, 208), Image.NEAREST)
    icon.alpha_composite(art, (24, 24))
    return icon


def main() -> int:
    os.makedirs(ITEMS_DIR, exist_ok=True)

    rendered: dict[str, Image.Image] = {}
    for name, (palette, grid) in ITEMS.items():
        validate(name, palette, grid)
        img = render(palette, grid)
        path = os.path.join(ITEMS_DIR, f"{name}.png")
        img.save(path)
        rendered[name] = img
        print(f"  生成: {os.path.relpath(path, ROOT)} ({img.size[0]}x{img.size[1]} {img.mode})")

    icon = make_pack_icon(rendered["blueprint_wand"])
    for pack in ("BuildHelperBP", "BuildHelperRP"):
        path = os.path.join(ROOT, pack, "pack_icon.png")
        icon.save(path)
        print(f"  生成: {os.path.relpath(path, ROOT)} (256x256 RGBA)")

    print(f"\n{len(ITEMS)} 個のアイテムテクスチャと 2 個のパックアイコンを生成しました。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
