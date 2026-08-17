"""打包成 Chrome Web Store / Edge Add-ons 可上传的 zip。

    python build.py

    -> dist/<name-from-manifest>-v<version>.zip

关键：manifest.json 必须在 zip 的**根目录**，不能套一层文件夹 —— 这是上传被拒的
头号原因。本脚本用显式白名单写入，天然保证结构正确。

改自 ext-template/build.py。相对模板加了四道闸（都是踩过的坑变成的）：

  ① 占位符硬闸 —— 包里只要还残留 `YOUR_`、`{{`、`TODO:` 就直接打不出包。
     ⚠️ 这条是有血的：上一个扩展 `Right-Click Search for DevDocs` 的提交包里，
        `homepage_url` 是字面量 `https://github.com/YOUR_GITHUB_USERNAME/...`，
        一个 404 链接连着 zip 一起交上去了。这类错误靠「记得填」是防不住的，
        只能靠机器拦。
  ② 描述长度闸 —— manifest.description 上限 132 字符，**用脚本数，别眼估**。
     (上一轮把 129 字符的短描述估成合规，实际 134，超了。)
  ③ 词典许可闸 —— 词典的唯一许可义务是把 SCOWL 的 license 原文照搬进包。
     漏了它就是许可违约，所以打包时验它在不在、有没有被截断。
  ④ 词典资产闸 —— index.aff / index.dic 必须在包里且大小对得上，
     否则装上去就是「扩展一点就报错」。
"""

import json
import os
import re
import sys
import zipfile

# ⚠️ Windows 上的输出编码有两个坑，2026-08-15 都实测踩到了：
#    ① 控制台默认 GBK，编不了 emoji（✅ ⚠️ 🛑）→ print 直接抛 UnicodeEncodeError
#       把打包脚本打崩（上一个扩展没踩到纯属运气：那次 permissions 只有一条，
#       走不到带 emoji 的那行 print）。
#    ② 反过来，若沿用 GBK 而终端是 UTF-8（Git Bash / Windows Terminal），
#       中文又会变成乱码。
#    本项目在 Git Bash（UTF-8）里跑，所以显式写 UTF-8；errors="replace" 兜底，
#    保证**任何**编码环境下脚本都不会因为输出而崩。
#    下面的 print 也一律用纯 ASCII 标记（[OK] / [!] / [FAIL]），双保险。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# 只打包运行时真正需要的文件。README / PRIVACY / STORE_LISTING / 各种脚本
# 属于仓库资产，不进扩展包 —— 包越小审核越快。
INCLUDE = [
    "manifest.json",
    "background.js",
    # 过滤逻辑单一真源：service worker 不用它，content script 当 classic script 注入
    "shared/pipeline.js",
    "content/scan.js",
    "popup/popup.html",
    "popup/popup.css",
    "popup/popup.js",
    # 移植版 nspell（CJS → ESM，见各文件头部注释）
    "src/nspell/index.js",
    "src/nspell/affix.js",
    "src/nspell/dictionary.js",
    "src/nspell/form.js",
    "src/nspell/suggest.js",
    "src/nspell/NSPELL-LICENSE.txt",
    # 词典资产（浏览器里 dictionary-en 的 index.js 不能用，只搬这两个数据文件）
    "src/dict/index.aff",
    "src/dict/index.dic",
    "src/dict/DICTIONARY-LICENSE.txt",   # ⚠️ 唯一的许可义务，不能漏
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
]

# 这三个字段一旦出现，就意味着扩展重新获得了「读取网页」的能力，
# 而商店文案和隐私政策是建立在「做不到」之上写的。硬拦。
#
# ⚠️ 特别说明 `content_scripts`：本扩展**故意不用**声明式注入。
#    声明式 content_scripts 必须写 matches，那等于要 host permissions，
#    用户安装时就会看到「读取您在所有网站上的数据」。
#    改成 activeTab + scripting.executeScript 按需注入 → 那句警告根本不出现。
#    这是对着在位者被 chrome-stats 标 Critical 打的差异点，也是文案卖点。
#
# ⚠️ 特别说明 `web_accessible_resources`：词典是 service worker 用
#    fetch(chrome.runtime.getURL(...)) 读的，**扩展读自己的包内资源不需要这个字段**。
#    这个字段是给「网页」读扩展资源用的，我们不给网页读任何东西。
FORBIDDEN_KEYS = [
    "content_scripts",
    "web_accessible_resources",
    "host_permissions",
]

# 这两个是本扩展**有意申请**的，打包时打印出来提醒核对文案，不拦。
EXPECTED_PERMISSIONS = {"activeTab", "scripting"}

# 出现这些权限说明隐私文案要重写了 —— 硬拦，别让它们悄悄溜进上架包。
FORBIDDEN_PERMISSIONS = {
    "tabs",          # 在位者就是因为它被标 Critical
    "history", "cookies", "webRequest", "webNavigation",
    "downloads", "management", "proxy", "<all_urls>",
}

# 占位符：包内任何文本文件里出现这些，直接失败。
PLACEHOLDER_PATTERNS = [
    r"YOUR_[A-Z_]+",
    r"\{\{[A-Z_]+\}\}",
    r"TODO:",
    r"FIXME",
    r"XXX_",
]

TEXT_EXTS = {".json", ".js", ".html", ".css", ".md", ".txt"}

DESCRIPTION_LIMIT = 132   # Chrome Web Store manifest.description 上限
NAME_LIMIT = 75           # manifest.name 上限


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "extension"


def check_placeholders(paths):
    """闸 ①：包内不许残留占位符。"""
    hits = []
    for p in paths:
        if os.path.splitext(p)[1].lower() not in TEXT_EXTS:
            continue
        with open(p, encoding="utf-8", errors="replace") as f:
            for lineno, line in enumerate(f, 1):
                for pat in PLACEHOLDER_PATTERNS:
                    m = re.search(pat, line)
                    if m:
                        hits.append(f"{p}:{lineno}  «{m.group(0)}»  {line.strip()[:70]}")
    return hits


def main() -> None:
    with open("manifest.json", encoding="utf-8") as f:
        manifest = json.load(f)

    version = manifest["version"]
    name = manifest.get("name", "extension")
    slug = slugify(name)

    problems = []

    # ---- 文件齐不齐
    missing = [p for p in INCLUDE if not os.path.isfile(p)]
    if missing:
        raise SystemExit(
            "缺文件，先跑 `python make_icons.py`？\n  -> " + "\n  -> ".join(missing)
        )

    # ---- 闸 ①：占位符
    hits = check_placeholders(INCLUDE)
    if hits:
        problems.append(
            "包内残留占位符（上一个扩展就是这样把 YOUR_GITHUB_USERNAME 交上去的）：\n    "
            + "\n    ".join(hits)
        )

    # ---- 闸 ②：字数（用脚本数，别眼估）
    desc = manifest.get("description", "")
    if len(desc) > DESCRIPTION_LIMIT:
        problems.append(
            f"description {len(desc)} 字符，超过上限 {DESCRIPTION_LIMIT}：\n    {desc!r}"
        )
    if len(name) > NAME_LIMIT:
        problems.append(f"name {len(name)} 字符，超过上限 {NAME_LIMIT}")

    # ---- 危险字段
    for key in FORBIDDEN_KEYS:
        if key in manifest:
            problems.append(
                f"manifest 里出现了 `{key}` —— 这会让扩展重新具备读取网页的能力。\n"
                f"    上架前请确认这是有意的，并同步改：\n"
                f"      · STORE_LISTING.md 权限理由 / Data usage 小节\n"
                f"      · PRIVACY.md 的权限表与「does NOT read」那一节\n"
                f"    改完再把 `{key}` 从 FORBIDDEN_KEYS 移出。"
            )

    # ---- 权限
    perms = set(manifest.get("permissions", []))
    bad_perms = perms & FORBIDDEN_PERMISSIONS
    if bad_perms:
        problems.append(
            f"出现了禁止的权限 {sorted(bad_perms)}。\n"
            f"    `tabs` 尤其不行 —— 在位者申请了它，chrome-stats 因此把它标成\n"
            f"    Critical 风险（\"can be used to track user browsing habits\"）。\n"
            f"    「我们不申请 tabs」是本产品的文案卖点。"
        )
    extra = perms - EXPECTED_PERMISSIONS
    if extra:
        print(f"[!] permissions 多出 {sorted(extra)} —— 隐私文案需要同步核对。")
    if perms != EXPECTED_PERMISSIONS:
        print(f"[!] permissions = {sorted(perms)}（预期 {sorted(EXPECTED_PERMISSIONS)}）")

    # ---- 闸 ③：词典许可（唯一的许可义务）
    lic = "src/dict/DICTIONARY-LICENSE.txt"
    lic_size = os.path.getsize(lic)
    if lic_size < 15000:
        problems.append(
            f"{lic} 只有 {lic_size} 字节，看着像被截断了。\n"
            f"    词典(dictionary-en, (MIT AND BSD))的**唯一**义务就是把这份 license\n"
            f"    原文照搬进包（正常约 15,731 字节）。漏了它 = 许可违约。"
        )

    # ---- 闸 ④：词典资产
    dic_size = os.path.getsize("src/dict/index.dic")
    aff_size = os.path.getsize("src/dict/index.aff")
    if dic_size < 500_000:
        problems.append(f"src/dict/index.dic 只有 {dic_size:,} 字节，正常约 551,762。")
    if aff_size < 2_000:
        problems.append(f"src/dict/index.aff 只有 {aff_size:,} 字节，正常约 3,086。")

    if problems:
        raise SystemExit("[FAIL] 打包被拦下：\n\n  " + "\n\n  ".join(problems) + "\n")

    # ---- 打包
    os.makedirs("dist", exist_ok=True)
    out = f"dist/{slug}-v{version}.zip"

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in INCLUDE:
            z.write(p, arcname=p.replace("\\", "/"))   # arcname 保持相对路径 = manifest 在根目录

    total_raw = sum(os.path.getsize(p) for p in INCLUDE)
    print(f"[OK] wrote {out}")
    print(f"   压缩后 {os.path.getsize(out):,} 字节 / 原始 {total_raw:,} 字节")
    print(f"   name        {name!r}  ({len(name)} 字符，上限 {NAME_LIMIT})")
    print(f"   description {len(desc)} 字符（上限 {DESCRIPTION_LIMIT}）")
    print(f"   permissions {sorted(perms)}")
    print(f"   词典 {dic_size:,} + {aff_size:,} 字节，license {lic_size:,} 字节 [OK]")
    with zipfile.ZipFile(out) as z:
        print("   contents:")
        for n in sorted(z.namelist()):
            print(f"     {n}")


if __name__ == "__main__":
    main()
