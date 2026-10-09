#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
マルチプレイ建築支援アドオン パッケージングスクリプト

BuildHelperBP / BuildHelperRP を1つの zip にまとめ、拡張子を .mcaddon にして
dist/build_support_addon.mcaddon を出力する。

使い方:
    python tools/build_mcaddon.py

ビルド前に以下を検証し、1つでも問題があれば中断する:
  - 全 JSON が構文的に妥当か
  - manifest の UUID がすべて異なるか / BP の dependencies が RP を正しく指しているか
  - ベータAPI（x.y.z-beta）を使っていないか
  - item_texture.json の全キーに対応する PNG があり、正方形・RGBA か
  - アイテムJSONの minecraft:icon が item_texture.json のキーと一致するか
  - 全アイテムの表示名が ja_JP.lang / en_US.lang の両方にあり、内容が一致するか
    （仕様書 第11章「部分的な言語対応を行わない」の担保）
  - スクリプトが禁止事項（fill/clone コマンド・StructureManager.place による
    無償ブロック生成）に抵触していないか
"""

from __future__ import annotations

import json
import os
import re
import sys
import zipfile

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("Pillow が必要です。`pip install pillow` を実行してください。")


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BP = "BuildHelperBP"
RP = "BuildHelperRP"
PACKS = [BP, RP]
DIST = os.path.join(ROOT, "dist")
OUTPUT = os.path.join(DIST, "build_support_addon.mcaddon")

ALLOWED_TEXTURE_SIDES = {16, 32, 64, 128, 256}

# 仕様書 第11章 の禁止事項。スクリプト内に現れてはいけない書き方。
FORBIDDEN_SCRIPT_PATTERNS = [
    (r"structureManager\s*\.\s*place", "StructureManager.place による無償ブロック生成"),
    (r"\bfill\s+[~\-\d]", "fill コマンド"),
    (r"\bclone\s+[~\-\d]", "clone コマンド"),
    (r"runCommand", "runCommand 経由のコマンド実行"),
]

errors: list[str] = []


def fail(msg: str) -> None:
    errors.append(msg)


def load_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        fail(f"JSON 構文エラー: {os.path.relpath(path, ROOT)}: {exc}")
        return None


def iter_files():
    for pack in PACKS:
        base = os.path.join(ROOT, pack)
        for dirpath, _dirnames, filenames in os.walk(base):
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                arc = os.path.relpath(full, ROOT).replace(os.sep, "/")
                yield full, arc


def check_json_syntax() -> list[str]:
    checked = []
    for full, arc in iter_files():
        if full.lower().endswith(".json"):
            load_json(full)
            checked.append(arc)
    return checked


def check_manifests() -> None:
    bp = load_json(os.path.join(ROOT, BP, "manifest.json"))
    rp = load_json(os.path.join(ROOT, RP, "manifest.json"))
    if not bp or not rp:
        return

    uuids = [bp["header"]["uuid"], rp["header"]["uuid"]]
    uuids += [m["uuid"] for m in bp["modules"]]
    uuids += [m["uuid"] for m in rp["modules"]]
    if len(set(uuids)) != len(uuids):
        fail(f"manifest の UUID が重複しています: {uuids}")

    deps = bp.get("dependencies", [])
    if not any(d.get("uuid") == rp["header"]["uuid"] for d in deps):
        fail("BP の dependencies が RP の header UUID を参照していません")

    module_names = {d.get("module_name") for d in deps}
    for needed in ("@minecraft/server", "@minecraft/server-ui"):
        if needed not in module_names:
            fail(f"BP の dependencies に {needed} がありません")

    for dep in deps:
        version = dep.get("version")
        if dep.get("module_name") and isinstance(version, str) and "beta" in version:
            fail(f"ベータAPIが指定されています: {dep['module_name']} {version}")


def item_identifiers() -> dict[str, dict]:
    """items/*.json を読み、識別子 -> components の対応を返す。"""
    items_dir = os.path.join(ROOT, BP, "items")
    result: dict[str, dict] = {}
    for fn in sorted(os.listdir(items_dir)):
        if not fn.endswith(".json"):
            continue
        data = load_json(os.path.join(items_dir, fn))
        if not data:
            continue
        item = data["minecraft:item"]
        result[item["description"]["identifier"]] = item["components"]
    return result


def check_textures(items: dict[str, dict]) -> None:
    tex = load_json(os.path.join(ROOT, RP, "textures", "item_texture.json"))
    if not tex:
        return

    texture_data = tex["texture_data"]
    for key, entry in texture_data.items():
        rel = entry["textures"] + ".png"
        png = os.path.join(ROOT, RP, rel.replace("/", os.sep))
        if not os.path.isfile(png):
            fail(f"item_texture.json のキー {key} に対応する PNG がありません: {rel}")
            continue
        with Image.open(png) as im:
            im.load()
            w, h = im.size
            if w != h or w not in ALLOWED_TEXTURE_SIDES:
                fail(f"{rel}: サイズが {im.size}（正方形で辺 {sorted(ALLOWED_TEXTURE_SIDES)} のいずれか）")
            if im.mode != "RGBA":
                fail(f"{rel}: モードが {im.mode}（期待値 RGBA）")

    for identifier, components in items.items():
        icon = components.get("minecraft:icon")
        if icon not in texture_data:
            fail(f"{identifier}: minecraft:icon '{icon}' が item_texture.json にありません")

    if len(items) != len(texture_data):
        fail(f"アイテム数({len(items)})と item_texture.json のキー数({len(texture_data)})が一致しません")

    for pack in PACKS:
        icon = os.path.join(ROOT, pack, "pack_icon.png")
        if not os.path.isfile(icon):
            fail(f"{pack}/pack_icon.png がありません")
            continue
        with Image.open(icon) as im:
            im.load()
            if im.size != (256, 256):
                fail(f"{pack}/pack_icon.png: サイズが {im.size}（期待値 (256, 256)）")


def read_lang(path: str) -> dict[str, str]:
    entries: dict[str, str] = {}
    if not os.path.isfile(path):
        fail(f"{os.path.relpath(path, ROOT)} がありません")
        return entries
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            entries[key.strip()] = value.strip()
    return entries


def check_languages(items: dict[str, dict]) -> None:
    """
    UI表記を日本語で統一するという要件のため、ja_JP と en_US に同じ日本語を入れている。
    片方だけ英語に戻ってしまう事故を防ぐため、両者が完全一致することを検証する。
    """
    for pack in PACKS:
        ja = read_lang(os.path.join(ROOT, pack, "texts", "ja_JP.lang"))
        en = read_lang(os.path.join(ROOT, pack, "texts", "en_US.lang"))
        if ja != en:
            diff = sorted(set(ja.items()) ^ set(en.items()))
            fail(f"{pack}: ja_JP.lang と en_US.lang の内容が一致しません（UI表記は日本語で統一）: {diff}")

    ja_bp = read_lang(os.path.join(ROOT, BP, "texts", "ja_JP.lang"))
    for identifier in items:
        key = f"item.{identifier}.name"
        if key not in ja_bp:
            fail(f"{BP}/texts/ja_JP.lang に {key} がありません")

    for pack in PACKS:
        langs = load_json(os.path.join(ROOT, pack, "texts", "languages.json"))
        if langs is not None and sorted(langs) != ["en_US", "ja_JP"]:
            fail(f"{pack}/texts/languages.json の内容が想定と違います: {langs}")


def check_recipes(items: dict[str, dict]) -> None:
    """レシピ識別子の重複、結果アイテムの実在、pattern と key の整合を確認する。"""
    recipes_dir = os.path.join(ROOT, BP, "recipes")
    if not os.path.isdir(recipes_dir):
        fail(f"{BP}/recipes がありません")
        return

    seen: dict[str, str] = {}
    results: set[str] = set()
    for fn in sorted(os.listdir(recipes_dir)):
        if not fn.endswith(".json"):
            continue
        data = load_json(os.path.join(recipes_dir, fn))
        if not data:
            continue
        kind = next((k for k in data if k.startswith("minecraft:recipe")), None)
        if kind is None:
            fail(f"recipes/{fn}: minecraft:recipe_* が見つかりません")
            continue
        recipe = data[kind]

        identifier = recipe["description"]["identifier"]
        if identifier in seen:
            fail(f"レシピ識別子が重複: {identifier}（{seen[identifier]} と {fn}）")
        seen[identifier] = fn

        result = recipe["result"]["item"]
        results.add(result)
        if result not in items:
            fail(f"recipes/{fn}: 結果アイテム {result} が items/ に存在しません")

        if kind == "minecraft:recipe_shaped":
            pattern = recipe["pattern"]
            if len({len(row) for row in pattern}) != 1:
                fail(f"recipes/{fn}: pattern の各行の文字数が揃っていません: {pattern}")
            keys = set(recipe["key"])
            used = {ch for row in pattern for ch in row if ch != " "}
            if used - keys:
                fail(f"recipes/{fn}: pattern に key 未定義の文字があります: {sorted(used - keys)}")
            if keys - used:
                fail(f"recipes/{fn}: key に未使用の定義があります: {sorted(keys - used)}")

    missing = set(items) - results
    if missing:
        fail(f"レシピが無いアイテムがあります: {sorted(missing)}")


def check_scripts() -> None:
    scripts_dir = os.path.join(ROOT, BP, "scripts")
    found = False
    for dirpath, _dirnames, filenames in os.walk(scripts_dir):
        for fn in filenames:
            if not fn.endswith(".js"):
                continue
            found = True
            path = os.path.join(dirpath, fn)
            with open(path, "r", encoding="utf-8") as f:
                source = f.read()
            rel = os.path.relpath(path, ROOT)
            # コメント行に説明として書いてある分は除外して判定する。
            code = "\n".join(
                line for line in source.splitlines()
                if not line.lstrip().startswith(("*", "//", "/*"))
            )
            for pattern, label in FORBIDDEN_SCRIPT_PATTERNS:
                if re.search(pattern, code):
                    fail(f"{rel}: 禁止事項に抵触する可能性があります（{label}）")
            if "-beta" in code:
                fail(f"{rel}: ベータAPI（-beta）を参照しています")
    if not found:
        fail(f"{BP}/scripts に .js がありません")


def stamp_version_into_name() -> str:
    """
    manifest のバージョンを各 .lang の pack.name 末尾へ「 vX.Y.Z」として書き込む。
    統合版は同じUUIDでもバージョンが違うと別コピーとして取り込まれるため、
    パック一覧で最新版を名前で見分けられるようにしておく。
    """
    bp = load_json(os.path.join(ROOT, BP, "manifest.json"))
    if not bp:
        return "?"
    version = ".".join(str(x) for x in bp["header"]["version"])

    for pack in PACKS:
        for name in ("ja_JP.lang", "en_US.lang"):
            path = os.path.join(ROOT, pack, "texts", name)
            if not os.path.isfile(path):
                continue
            with open(path, "r", encoding="utf-8") as f:
                lines = f.readlines()
            for i, line in enumerate(lines):
                if line.startswith("pack.name="):
                    value = line.split("=", 1)[1].rstrip("\r\n")
                    base = re.sub(r"\s*v\d+\.\d+\.\d+\s*$", "", value)
                    lines[i] = f"pack.name={base} v{version}\n"
                    break
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.writelines(lines)

    print(f"  パック名にバージョンを刻印: v{version}")
    return version


def build() -> None:
    os.makedirs(DIST, exist_ok=True)
    if os.path.exists(OUTPUT):
        os.remove(OUTPUT)

    count = 0
    with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as z:
        for full, arc in sorted(iter_files(), key=lambda t: t[1]):
            z.write(full, arc)
            count += 1
    size_kb = os.path.getsize(OUTPUT) / 1024
    print(f"\n出力: {OUTPUT}")
    print(f"  ファイル数: {count} / サイズ: {size_kb:.1f} KB")


def main() -> int:
    print("検証中...")
    checked = check_json_syntax()
    print(f"  JSON 構文: {len(checked)} ファイル")

    items = item_identifiers()
    print(f"  アイテム: {len(items)} 種")
    check_manifests()
    check_textures(items)
    check_languages(items)
    check_recipes(items)
    check_scripts()

    if errors:
        print(f"\n検証に失敗しました（{len(errors)} 件）:")
        for e in errors:
            print(f"  - {e}")
        return 1

    print("  すべての検証を通過しました。")
    stamp_version_into_name()
    build()
    return 0


if __name__ == "__main__":
    sys.exit(main())
