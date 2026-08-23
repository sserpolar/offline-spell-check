"""打包成 Chrome Web Store / Edge Add-ons / Firefox AMO 可上传的 zip。

    python build.py

    -> dist/<name-from-manifest>-v<version>.zip          （Chrome + Edge，manifest.json）
    -> dist/<name-from-manifest>-v<version>-firefox.zip  （AMO，manifest.firefox.json）

关键：manifest.json 必须在 zip 的**根目录**，不能套一层文件夹 —— 这是上传被拒的
头号原因。本脚本用显式白名单写入，天然保证结构正确。
Firefox 目标把 `manifest.firefox.json` 以 **arcname="manifest.json"** 写进包，
所以两个 zip 里都只有一个叫 manifest.json 的文件，浏览器侧无需知道源文件名。

⛔ **为什么是两份 manifest，而不是在一份里同时写两种 background**
   MV3 的 `background.service_worker`（Chrome）和 `background.scripts`（Firefox 事件页）
   看似可以共存，实际不行：**Chrome 121 之前遇到 `background.scripts` 会拒绝加载整个扩展**。
   本扩展声明 `minimum_chrome_version: 102`，合并 manifest 等于当场打死 102–120 的用户。
   （来源：MDN manifest.json/background）⇒ 两个文件、两个包，永不合并。

Firefox 侧 `strict_min_version = "112.0"` 的下界推导（三个门槛取最大值）：
   · 事件页（background.scripts 非持久化）           FF 106
   · MV3 + chrome.* 返回 Promise                     FF 109
   · background.type = "module"（bugzilla 1811443）  FF 112  ← 卡住的就是这条

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

⑤ 截图临时改动闸（见下方 SCREENSHOT_OVERRIDE_MARK）、
⑥ **双 manifest 一致性闸**（见 check_manifest_pair）、
⑦ **不覆盖已存在的 zip**（见 main 末尾）是后来加的。
   闸 ①–⑥ 对 Chrome 目标和 Firefox 目标**同样生效**，任一目标被拦下就整个脚本失败，
   两个包不会一个新一个旧。
   闸 ⑦ 默认只打**不存在**的包 —— 在审的 `...-v1.0.0.zip` 不会被动一个字节。
   要重打某个目标必须显式说出目标名：

       python build.py            # 只打缺的包（默认，安全）
       python build.py firefox    # 强制重打 Firefox 包
       python build.py --force-all
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
    # 建议补齐单一真源：service worker 直接 ESM import（background.type = module）
    # ⚠️ 漏了这个 = 装上后一点高亮就报错，而扫描本身是好的 —— 最难查的那种坏法
    "shared/suggest.js",
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

# 两个打包目标。除了 manifest 源文件与 zip 后缀，其余完全共用同一份 INCLUDE 白名单 ——
# 产品代码在两个浏览器上跑的是**同一批字节**。
#
# ⚠️ Firefox 目标写进 zip 的 arcname 仍是 "manifest.json"（见 build_target），
#    源文件叫 manifest.firefox.json 只是为了在仓库里能和 Chrome 那份并存。
TARGETS = [
    {
        "key": "chrome",
        "manifest": "manifest.json",
        "suffix": "",
        "stores": "Chrome Web Store + Edge Add-ons",
    },
    {
        "key": "firefox",
        "manifest": "manifest.firefox.json",
        "suffix": "-firefox",
        "stores": "Firefox AMO",
    },
]

# 闸 ⑥ 的期望值。改这里之前先读本文件头部那段「为什么是两份 manifest」。
GECKO_ID = "offline-spell-check@sserpolar.github.io"
GECKO_STRICT_MIN_VERSION = "112.0"

# gecko.id 长得像 email，但**一次定终身、且会公开在 AMO 页面与每个安装包里**。
# 它必须是我控制的域（github.io 用户页），绝不能是真实邮箱 —— 那等于把邮箱
# 永久钉在一个改不了的字段上。这里硬拦常见邮箱域，因为「记得别填邮箱」防不住。
FORBIDDEN_ID_DOMAINS = (
    "gmail.com", "googlemail.com", "qq.com", "163.com", "126.com",
    "foxmail.com", "outlook.com", "hotmail.com", "live.com",
    "yahoo.com", "icloud.com", "sina.com", "yeah.net", "aliyun.com",
)

# 闸 ⑥ 要求两份 manifest 在这些字段上逐字相同。任一字段漂移都意味着
# 两个商店上架的是两个不同的产品（文案 / 权限说明 / 版本号会当场对不上）。
SHARED_MANIFEST_KEYS = [
    "manifest_version",
    "name",
    "version",
    "description",
    "permissions",
    "action",
    "icons",
    "homepage_url",
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

# 闸 ⑤ 找的标记。出商店截图时会在 popup/popup.js 里临时写死 SHOW_TIMING=false,
# 那个改动带着这个标记 —— 只要它还在包里就不许打包。
SCREENSHOT_OVERRIDE_MARK = "__SCREENSHOT_OVERRIDE__"

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


def include_for(target) -> list:
    """把白名单里的 "manifest.json" 换成本目标的 manifest 源文件。

    其余 19 个文件两个目标完全共用 —— 这是「产品代码只有一份」的机械保证。
    """
    return [target["manifest"] if p == "manifest.json" else p for p in INCLUDE]


def check_manifest_pair(chrome, firefox) -> list:
    """闸 ⑥：两份 manifest 必须共享字段逐字一致、background 严格互斥。

    这道闸拦三类事故：
      ① **字段漂移** —— 只改了一份 manifest 的 version/description，
         于是两个商店上架的是两个不同的产品，而 zip 都能正常打出来。
      ② **background 串味** —— Firefox 那份要是混进 `service_worker`，
         或 Chrome 那份混进 `scripts`，就是本文件头部那条「Chrome <121 拒绝加载
         整个扩展」的坑。这条错误装上去才发现，而且只在旧 Chrome 上发现。
      ③ **gecko.id 被填成真实邮箱** —— 一次定终身，改不回来。
    """
    problems = []

    for key in SHARED_MANIFEST_KEYS:
        if chrome.get(key) != firefox.get(key):
            problems.append(
                f"闸 ⑥：两份 manifest 的 `{key}` 不一致 —— 两店会上架成两个不同的产品。\n"
                f"      manifest.json         {chrome.get(key)!r}\n"
                f"      manifest.firefox.json {firefox.get(key)!r}\n"
                f"    共享字段清单在 SHARED_MANIFEST_KEYS。"
            )

    # ---- Chrome 那份：service worker，且绝不许出现 scripts
    cbg = chrome.get("background", {})
    if cbg.get("service_worker") != "background.js":
        problems.append(
            "闸 ⑥：manifest.json 的 background.service_worker 不是 'background.js'。\n"
            f"    实际 {cbg!r}"
        )
    if "scripts" in cbg:
        problems.append(
            "闸 ⑥：manifest.json 里出现了 `background.scripts` —— **这会打死 Chrome 102–120**。\n"
            "    Chrome 121 之前遇到 background.scripts 会拒绝加载整个扩展，\n"
            "    而本扩展声明的 minimum_chrome_version 是 102。\n"
            "    Firefox 的 background 写在 manifest.firefox.json 里，不要合并这两份文件。\n"
            "    （来源：MDN manifest.json/background）"
        )
    if "browser_specific_settings" in chrome:
        problems.append(
            "闸 ⑥：manifest.json 里出现了 `browser_specific_settings` —— 那是 Firefox 侧的字段，\n"
            "    应该只写在 manifest.firefox.json 里。"
        )

    # ---- Firefox 那份：事件页 scripts，且绝不许出现 service_worker
    fbg = firefox.get("background", {})
    if fbg.get("scripts") != ["background.js"]:
        problems.append(
            "闸 ⑥：manifest.firefox.json 的 background.scripts 不是 ['background.js']。\n"
            f"    实际 {fbg!r}"
        )
    if fbg.get("type") != "module":
        problems.append(
            "闸 ⑥：manifest.firefox.json 的 background.type 必须是 'module' ——\n"
            "    background.js 用 ESM `import` 引 shared/suggest.js。\n"
            "    去掉 type 就是「装上后一点高亮就报错」那种坏法。\n"
            "    也正是这一条把 strict_min_version 顶到 112.0（bugzilla 1811443）。"
        )
    if "service_worker" in fbg:
        problems.append(
            "闸 ⑥：manifest.firefox.json 里出现了 `background.service_worker` ——\n"
            "    Firefox 不用它，而且这说明两份 manifest 正在被合并。别合并。"
        )
    if "minimum_chrome_version" in firefox:
        problems.append(
            "闸 ⑥：manifest.firefox.json 里残留 `minimum_chrome_version` —— Firefox 侧无意义，删掉。"
        )

    gecko = firefox.get("browser_specific_settings", {}).get("gecko", {})
    if gecko.get("id") != GECKO_ID:
        problems.append(
            f"闸 ⑥：browser_specific_settings.gecko.id 必须是 {GECKO_ID!r}。\n"
            f"    实际 {gecko.get('id')!r}\n"
            "    ⚠️ 这个值**一次定终身**：AMO 用它认「这是同一个扩展」，改了就是另一个新扩展，\n"
            "    已装用户收不到更新。首次提交前是唯一能改的窗口。"
        )
    gid = str(gecko.get("id", "")).lower()
    hit = [d for d in FORBIDDEN_ID_DOMAINS if gid.endswith("@" + d) or gid.endswith("." + d)]
    if hit:
        problems.append(
            f"闸 ⑥：gecko.id 用了真实邮箱域 {hit} —— ⛔ 不行。\n"
            "    这个字段会公开在 AMO 页面和每个安装包里，而且改不了。\n"
            "    用自己控制的域（本项目用 github.io 用户页）。"
        )
    if gecko.get("strict_min_version") != GECKO_STRICT_MIN_VERSION:
        problems.append(
            f"闸 ⑥：gecko.strict_min_version 必须是 {GECKO_STRICT_MIN_VERSION!r}。\n"
            f"    实际 {gecko.get('strict_min_version')!r}\n"
            "    下界是三个门槛取最大值：事件页 FF106 · MV3+Promise FF109 ·\n"
            "    background.type=module FF112 ← 卡住的是这条。往下调 = 装上去直接坏。"
        )

    return problems


def check_shared_assets() -> list:
    """闸 ③④：词典许可 + 词典资产。两个目标共用同一批文件，只查一次。"""
    problems = []

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

    return problems


def check_target(target, manifest) -> list:
    """闸 ①②⑤ + 危险字段 / 权限。每个打包目标各跑一遍。"""
    paths = include_for(target)
    tag = f"[{target['key']}]"
    problems = []

    # ---- 文件齐不齐
    missing = [p for p in paths if not os.path.isfile(p)]
    if missing:
        raise SystemExit(
            f"{tag} 缺文件，先跑 `python make_icons.py`？\n  -> " + "\n  -> ".join(missing)
        )

    # ---- 闸 ①：占位符
    hits = check_placeholders(paths)
    if hits:
        problems.append(
            f"{tag} 包内残留占位符（上一个扩展就是这样把 YOUR_GITHUB_USERNAME 交上去的）：\n    "
            + "\n    ".join(hits)
        )

    # ---- 闸 ②：字数（用脚本数，别眼估）
    desc = manifest.get("description", "")
    name = manifest.get("name", "extension")
    if len(desc) > DESCRIPTION_LIMIT:
        problems.append(
            f"{tag} description {len(desc)} 字符，超过上限 {DESCRIPTION_LIMIT}：\n    {desc!r}"
        )
    if len(name) > NAME_LIMIT:
        problems.append(f"{tag} name {len(name)} 字符，超过上限 {NAME_LIMIT}")

    # ---- 危险字段
    for key in FORBIDDEN_KEYS:
        if key in manifest:
            problems.append(
                f"{tag} manifest 里出现了 `{key}` —— 这会让扩展重新具备读取网页的能力。\n"
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
            f"{tag} 出现了禁止的权限 {sorted(bad_perms)}。\n"
            f"    `tabs` 尤其不行 —— 在位者申请了它，chrome-stats 因此把它标成\n"
            f"    Critical 风险（\"can be used to track user browsing habits\"）。\n"
            f"    「我们不申请 tabs」是本产品的文案卖点。"
        )
    extra = perms - EXPECTED_PERMISSIONS
    if extra:
        print(f"[!] {tag} permissions 多出 {sorted(extra)} —— 隐私文案需要同步核对。")
    if perms != EXPECTED_PERMISSIONS:
        print(f"[!] {tag} permissions = {sorted(perms)}（预期 {sorted(EXPECTED_PERMISSIONS)}）")

    # ---- 闸 ⑤：截图用的临时改动没改回来
    # 出商店截图时会把 popup 的 SHOW_TIMING 临时写死成 false（好让耗时明细不入镜）。
    # 那是**临时**的，忘了改回来就等于把开发诊断入口永久关掉。
    # 「临时的东西跟着交上去」正是上一个扩展 YOUR_GITHUB_USERNAME 那一类错误，
    # 靠记性防不住，只能靠机器拦。
    override_hits = []
    for p in paths:
        if os.path.splitext(p)[1].lower() not in TEXT_EXTS:
            continue
        with open(p, encoding="utf-8", errors="replace") as f:
            for lineno, line in enumerate(f, 1):
                if SCREENSHOT_OVERRIDE_MARK in line:
                    override_hits.append(f"{p}:{lineno}")
    if override_hits:
        problems.append(
            f"{tag} 包里还留着**截图用的临时改动**：\n    "
            + "\n    ".join(override_hits)
            + "\n\n    改回来的方法：把 popup/popup.js 里那个标记注释块连同\n"
            "      const SHOW_TIMING = false;\n"
            "    一起删掉，恢复成：\n"
            "      const SHOW_TIMING = !('update_url' in chrome.runtime.getManifest());\n"
            "    （商店安装的扩展 getManifest() 里才有 update_url，解压加载的没有，\n"
            "     所以那一行本身就已经做到「用户看不见、开发看得见」。）"
        )

    return problems


def out_path(target, manifest) -> str:
    slug = slugify(manifest.get("name", "extension"))
    return f"dist/{slug}-v{manifest['version']}{target['suffix']}.zip"


def write_zip(target, manifest) -> str:
    """把一个目标写成 zip。manifest 源文件一律以 arcname="manifest.json" 入包。"""
    paths = include_for(target)
    name = manifest.get("name", "extension")
    os.makedirs("dist", exist_ok=True)
    out = out_path(target, manifest)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in paths:
            # ⚠️ Firefox 目标：源文件 manifest.firefox.json，入包名必须是 manifest.json，
            #    否则浏览器根本认不出这是个扩展。
            arcname = "manifest.json" if p == target["manifest"] else p.replace("\\", "/")
            z.write(p, arcname=arcname)

    total_raw = sum(os.path.getsize(p) for p in paths)
    desc = manifest.get("description", "")
    print()
    print(f"[OK] wrote {out}   ({target['stores']})")
    print(f"   manifest 源  {target['manifest']}  ->  zip 内 manifest.json")
    print(f"   压缩后 {os.path.getsize(out):,} 字节 / 原始 {total_raw:,} 字节")
    print(f"   name        {name!r}  ({len(name)} 字符，上限 {NAME_LIMIT})")
    print(f"   description {len(desc)} 字符（上限 {DESCRIPTION_LIMIT}）")
    print(f"   permissions {sorted(manifest.get('permissions', []))}")
    bg = manifest.get("background", {})
    if "service_worker" in bg:
        print(f"   background  service_worker={bg['service_worker']!r} type={bg.get('type')!r}"
              f"  minimum_chrome_version={manifest.get('minimum_chrome_version')}")
    else:
        gecko = manifest.get("browser_specific_settings", {}).get("gecko", {})
        print(f"   background  scripts={bg.get('scripts')!r} type={bg.get('type')!r}")
        print(f"   gecko       id={gecko.get('id')!r} strict_min_version={gecko.get('strict_min_version')!r}")
    with zipfile.ZipFile(out) as z:
        print("   contents:")
        for n in sorted(z.namelist()):
            print(f"     {n}")
    return out


def main() -> None:
    # 先报这个：它跟打包成不成功无关，而且打包被闸拦下时你**更**需要看到它
    # （2026-08-17 就撞上过：闸 ⑤ 正拦着，而扩展同时装不进 Chrome）。
    check_unpacked_loadable()

    manifests = {}
    for t in TARGETS:
        if not os.path.isfile(t["manifest"]):
            raise SystemExit(f"缺 {t['manifest']} —— {t['stores']} 那个包没法打。")
        with open(t["manifest"], encoding="utf-8") as f:
            manifests[t["key"]] = json.load(f)

    # 五道闸全部先跑完再动手写任何 zip —— 否则会出现「Chrome 包是新的、
    # Firefox 包因为被闸拦下还是旧的」，而 dist/ 里两个文件看着都在。
    problems = check_shared_assets()
    problems += check_manifest_pair(manifests["chrome"], manifests["firefox"])
    for t in TARGETS:
        problems += check_target(t, manifests[t["key"]])

    if problems:
        raise SystemExit("[FAIL] 打包被拦下：\n\n  " + "\n\n  ".join(problems) + "\n")

    lic_size = os.path.getsize("src/dict/DICTIONARY-LICENSE.txt")
    dic_size = os.path.getsize("src/dict/index.dic")
    aff_size = os.path.getsize("src/dict/index.aff")
    print(f"[OK] 词典 {dic_size:,} + {aff_size:,} 字节，license {lic_size:,} 字节")

    # ---- 闸 ⑦：⛔ 不覆盖已经存在的 zip
    # dist/ 里已存在的 zip 就是**已经交出去或正在审核**的那一份。哪怕内容一字不改，
    # 重新打包也会换掉字节（zip 里存了时间戳），于是「提交的包」和「本地的包」
    # 对不上，HANDOFF 里那句「260,871 字节 / 20 个文件」当场失效，
    # 而重新上传会替换在审条目、**审核计时归零**。
    # ⇒ 默认只打不存在的包。要重打必须显式说出目标名。
    forced = {a.lower() for a in sys.argv[1:] if not a.startswith("-")}
    if "--force-all" in sys.argv:
        forced = {t["key"] for t in TARGETS}

    built, skipped = [], []
    for t in TARGETS:
        m = manifests[t["key"]]
        out = out_path(t, m)
        if os.path.exists(out) and t["key"] not in forced:
            skipped.append((t, out))
            continue
        built.append(write_zip(t, m))

    print()
    for t, out in skipped:
        print(f"[!] 跳过 {t['key']}：{out} 已存在，**没有重新打包**。")
        print(f"    这是保护在审 / 已提交的包（重新上传 = 审核计时归零）。")
        print(f"    真要重打：python build.py {t['key']}")
    if built:
        print(f"[OK] 本次新出 {len(built)} 个包：")
        for out in built:
            print(f"      {out}")
    else:
        print("[OK] 没有新包（全部已存在）。加目标名参数才会重打。")


def check_unpacked_loadable():
    """提醒 ⑥：解压加载（chrome://extensions → 加载已解压）会失败的东西。

    ⚠️ 这**不是打包闸**，是提醒 —— zip 只装 INCLUDE 白名单里那 18 个文件，
       所以这些垃圾永远进不了提交包，`raise` 是不对的。
       但 `chrome://extensions` 的「加载已解压」读的是**整个目录**，Chrome 对
       顶层带 `_` 前缀的条目会直接拒绝：

         Cannot load extension with file or directory name __pycache__.
         Filenames starting with "_" are reserved for use by the system.
         Could not load manifest.

    2026-08-17 实撞:拿 importlib 加载 make_store_screenshots.py 做裁切测试，
    Python 顺手在扩展根目录写了 `__pycache__/` —— 于是**扩展装不进去了**，
    而报错说的是 "Could not load manifest"，看着像 manifest.json 坏了，
    完全指错了方向。`.gitignore` 里早有 `__pycache__/`，所以 git 一声不响。

    ⇒ 只要跑过任何会 import 本目录 .py 文件的命令，就可能复现。
       想彻底免疫:那类命令前面加 `PYTHONDONTWRITEBYTECODE=1`。
    """
    bad = sorted(n for n in os.listdir(".") if n.startswith("_"))
    if bad:
        print()
        print("[!] 解压加载会失败 —— 顶层有 Chrome 保留的 `_` 前缀条目：")
        for n in bad:
            print(f"      {n}")
        print("    Chrome 会报 `Could not load manifest.`（**指错方向**，manifest 没坏）。")
        print("    删掉即可，提交包不受影响（zip 只装 INCLUDE 白名单）。")
        print("    多半是 __pycache__：跑 python 前加 PYTHONDONTWRITEBYTECODE=1 可免疫。")


if __name__ == "__main__":
    main()
