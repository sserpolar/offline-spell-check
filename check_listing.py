"""核对商店文案的字数限制。**字数一律用脚本数，别眼估。**

    python check_listing.py

为什么要有这个脚本：2026-08-14 起草短描述时把它标成「129 字符」，
实际 **134**，超了 Chrome 的 132 上限。眼估在 130 字符这个量级上根本不可靠。

本脚本从 STORE_LISTING.md 里把三段代码块抽出来核对，
并与 manifest.json 交叉比对（防止两边说的不是同一句话）。
"""

import json
import re
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# Chrome Web Store / Edge Add-ons 的硬上限
LIMITS = {
    "name": 75,
    "summary": 132,          # Chrome 叫 Summary，Edge 叫 Short description
    "description": 16000,     # 详细描述
    "single_purpose": 1000,
}

# Edge Add-ons 的短描述上限更松，但没必要用满 —— 两边用同一句更好维护
EDGE_SUMMARY_LIMIT = 200


def blocks(md: str):
    """按 '## N. 标题' 分段，取每段里第一个 ``` 代码块。"""
    out = {}
    parts = re.split(r"\n## ", md)
    for p in parts:
        head = p.split("\n", 1)[0]
        m = re.search(r"```\n(.*?)\n```", p, re.S)
        if m:
            out[head] = m.group(1)
    return out


def check(label: str, text: str, limit: int) -> bool:
    n = len(text)
    ok = n <= limit
    mark = "[OK]  " if ok else "[FAIL]"
    print(f"  {mark} {label:<22} {n:>6} / {limit}")
    if not ok:
        print(f"         超了 {n - limit} 个字符，必须删")
    return ok


def main() -> None:
    with open("STORE_LISTING.md", encoding="utf-8") as f:
        md = f.read()
    with open("manifest.json", encoding="utf-8") as f:
        manifest = json.load(f)

    b = blocks(md)
    allok = True

    def find(keyword):
        for k, v in b.items():
            if keyword.lower() in k.lower():
                return k, v
        return None, None

    print("STORE_LISTING.md 字数核对")
    print("-" * 52)

    _, name = find("Name")
    _, summary = find("Summary")
    _, desc = find("Description")
    _, purpose = find("Single purpose")

    if name is None or summary is None or desc is None:
        raise SystemExit("[FAIL] STORE_LISTING.md 里没找到 Name / Summary / Description 代码块")

    allok &= check("name", name, LIMITS["name"])
    allok &= check("summary", summary, LIMITS["summary"])
    allok &= check("description", desc, LIMITS["description"])
    if purpose:
        allok &= check("single purpose", purpose, LIMITS["single_purpose"])

    print()
    print("与 manifest.json 交叉比对（两边必须是同一句话）")
    print("-" * 52)
    for field, listing in (("name", name), ("description", summary)):
        mv = manifest.get(field, "")
        same = mv.strip() == listing.strip()
        print(f"  {'[OK]  ' if same else '[FAIL]'} manifest.{field:<12} "
              f"{'一致' if same else '不一致'}")
        if not same:
            allok = False
            print(f"         manifest : {mv!r}")
            print(f"         listing  : {listing.strip()!r}")

    print()
    print("Edge Add-ons 复用同一句短描述")
    print("-" * 52)
    allok &= check("summary (Edge)", summary, EDGE_SUMMARY_LIMIT)

    print()
    # 描述里绝对不能出现的话 —— 都是实测证伪过的过度承诺
    print("过度承诺自查（这些话实测支撑不住，出现即失败）")
    print("-" * 52)
    banned = [
        ("all spelling mistakes", "真词错误实测 0/6，抓不到。只能写 misspelled words"),
        ("all typos", "同上"),
        ("understands derived forms", "派生词靠术语表覆盖，不是形态学分析；剥后缀已实测否掉"),
        ("grammar check", "不做语法"),
        ("fixes", "不改页面，只标出来"),
        ("100% accurate", "误报率 0.05%，不是 0"),
    ]
    for phrase, why in banned:
        hit = phrase.lower() in desc.lower()
        print(f"  {'[FAIL]' if hit else '[OK]  '} {phrase:<28} {why if hit else ''}")
        if hit:
            allok = False

    print()
    if allok:
        print("[OK] 全部通过，可以往商店表单里粘了。")
    else:
        raise SystemExit("[FAIL] 有不通过项，先改 STORE_LISTING.md。")


if __name__ == "__main__":
    main()
