# -*- coding: utf-8 -*-
"""把截图转成 Chrome / Edge 商店要求的 1280x800 —— **默认一个像素都不重采样**。

用法：
  1) 把原始截图丢进  screenshots/raw/
  2) python make_store_screenshots.py
  3) 成品在 screenshots/store/ ，可直接上传商店

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⭐ 2026-08-17 改掉了默认行为，原因写在这里，别改回去
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
旧默认是 MODE="fit"：等比缩放到装得进 1280x800，再补白居中。看着很讲道理
（不裁切、不变形），但它在 1918x1080 的截图上干的事是：

    字号 x0.667 → 16.5px 渲染的正文在成品里只有 11px，红波浪线从 2 物理像素
    掉到 1.3 像素、糊成灰色；再白送 80px 上下白边。

商店列表页还会把 1280 再显示成约 640px 宽 —— 于是「红波浪线」和「琥珀虚线框」
这两个本产品**唯一的视觉卖点**在缩略图上根本看不出来。
2026-08-17 第一批 3 张就是这么糊掉的，而脚本当时一句话都没说。

⚠️ 缩小是**丢像素**，不是压缩。没了就是没了，后处理造不回来。
   放大也不行（`fit()` 里 `if scale < 1` 就是为了这个：放大只会更糊）。

⇒ 正解不是「事后缩放调参」，而是**让截图一开始就是 1280x800**：
     · 把浏览器窗口调成 **1280x800**，并**挪到屏幕左上角 (0,0)**
       （SUBMIT_CHECKLIST.md 阶段 3 给了一条 PowerShell 一行命令，不用手拖）
     · 页面缩放保持 **100%**（不要用 133%，那是上一版的错方案）
     · 按 PrintScreen 截**全屏**（popup 是独立的气泡窗口，
       **Alt+PrintScreen 只截活动窗口，很可能只截到那个气泡**）
     · 本脚本裁左上角 1280x800 —— 正好就是那个窗口，零重采样，
       字号就是原生的 16.5px

   窗口调不准也没关系：只要 >=1280x800 就纯裁，< 就纯补白，都不重采样。

本项目要截哪 5 张、为什么是这 5 张，见 STORE_LISTING.md 第 8 节。
Edge 要求 1366x768 或 1280x800 —— 1280x800 两边通吃，不用出两套。

⚠️ 截图前把 popup 底部那三行耗时明细关掉：popup/popup.js 的 SHOW_TIMING
   临时改 false（带 __SCREENSHOT_OVERRIDE__ 标记，build.py 闸 ⑤ 会拦忘改回去）。
"""

from pathlib import Path

from PIL import Image

# ⚠️ 和 build.py 同一个坑（2026-08-15 实测踩到、2026-08-17 本脚本又踩了一次）：
#    Windows 控制台默认 GBK，编不了 emoji（⚠️ 之类）→ print 直接抛
#    UnicodeEncodeError 把脚本打崩。本脚本最要紧的那条输出恰恰是
#    「⚠️ 窗口没调到 1280 宽」—— **不修这一行，它就会在正要警告你的那一刻崩掉。**
#    errors="replace" 兜底：任何编码环境下都不会因为输出而崩。
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

TARGET = (1280, 800)  # Chrome 商店只接受 1280x800 或 640x400
BG = (255, 255, 255)  # 补白颜色。深色主题的截图改成 (32, 33, 36) 更自然

# "exact" = 只裁 / 只补白，永不重采样（默认，见上面那段）
# "fit"   = 旧行为：等比缩放 + 补白居中。只在「非要把一整个宽屏窗口塞进去」时才用，
#           并且它会把字缩小多少、直接打在输出里让你看见。
MODE = "exact"

# 裁的锚点。左上角是**故意**的：截全屏时把浏览器窗口挪到屏幕左上角，
# 裁 (0,0)-(1280,800) 就正好是那个窗口的上 800 行 ——
# 而 popup 气泡挂在工具栏下面，必须留在上面这 800 行里。
ANCHOR = ("left", "top")

# 源图比目标宽出这个倍数以上就多喊一声（说明窗口大概根本没调到 1280 宽）
TOO_WIDE_FACTOR = 1.25

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "screenshots" / "raw"
OUT = ROOT / "screenshots" / "store"
EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def _offset(src, dst, anchor):
    """按锚点算裁切/粘贴的起点。"""
    if anchor == "left" or anchor == "top":
        return 0
    if anchor == "right" or anchor == "bottom":
        return src - dst
    return (src - dst) // 2  # center


def exact(img, target, bg, anchor):
    """只裁 / 只补白，一个像素都不重采样。返回 (成品, 干了什么的人话说明)。"""
    tw, th = target
    notes = []

    # ---- 先裁掉多出来的
    if img.width > tw or img.height > th:
        x = _offset(img.width, tw, anchor[0]) if img.width > tw else 0
        y = _offset(img.height, th, anchor[1]) if img.height > th else 0
        cut_w = max(0, img.width - tw)
        cut_h = max(0, img.height - th)
        img = img.crop((x, y, x + min(tw, img.width), y + min(th, img.height)))
        bits = []
        if cut_w:
            bits.append(f"右侧 {cut_w}px")
        if cut_h:
            bits.append(f"底部 {cut_h}px")
        notes.append("裁掉 " + " + ".join(bits))

    # ---- 再补白不够的
    if img.width < tw or img.height < th:
        pad_w = tw - img.width
        pad_h = th - img.height
        canvas = Image.new("RGB", target, bg)
        canvas.paste(img.convert("RGB"),
                     (_offset(tw, img.width, anchor[0]) if pad_w else 0,
                      _offset(th, img.height, anchor[1]) if pad_h else 0))
        img = canvas
        bits = []
        if pad_w:
            bits.append(f"右侧 {pad_w}px")
        if pad_h:
            bits.append(f"底部 {pad_h}px")
        notes.append("补白 " + " + ".join(bits))

    if not notes:
        notes.append("尺寸正好，原样输出")
    return img.convert("RGB"), " · ".join(notes) + "（零重采样）"


def fit(img, target, bg):
    """旧行为：等比缩放到装得进 target，再补白居中。只缩不放（放大会糊）。"""
    tw, th = target
    scale = min(tw / img.width, th / img.height)
    note = "尺寸正好，原样输出"
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
        note = f"⚠️ 缩放到 {scale:.1%} —— 16.5px 的正文在成品里只剩 {16.5 * scale:.1f}px"
    canvas = Image.new("RGB", target, bg)
    canvas.paste(img.convert("RGB"), ((tw - img.width) // 2, (th - img.height) // 2))
    return canvas, note


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)

    files = sorted(p for p in RAW.iterdir() if p.suffix.lower() in EXTS)
    if not files:
        print(f"没找到图片。把原始截图放进这个目录再重跑：\n  {RAW}")
        return

    print(f"模式 MODE = {MODE!r}"
          + ("（只裁/只补白，永不重采样）" if MODE == "exact" else "（等比缩放 + 补白，会糊）"))
    print(f"目标 {TARGET[0]}x{TARGET[1]}，裁切锚点 {ANCHOR[0]}-{ANCHOR[1]}\n")

    too_wide = []
    for i, path in enumerate(files, 1):
        with Image.open(path) as im:
            src = f"{im.width}x{im.height}"
            if im.width > TARGET[0] * TOO_WIDE_FACTOR:
                too_wide.append((path.name, im.width))
            out, note = (exact(im, TARGET, BG, ANCHOR) if MODE == "exact"
                         else fit(im, TARGET, BG))
        dst = OUT / f"screenshot{i}-{TARGET[0]}x{TARGET[1]}.png"
        out.save(dst, "PNG", optimize=True)
        print(f"{path.name}  ({src})  ->  {dst.name}\n    {note}")

    print(f"\n完成 {len(files)} 张：\n  {OUT}")

    if too_wide and MODE == "exact":
        print("\n⚠️ 下面这几张比 1280 宽出一大截 —— 说明浏览器窗口没调到 1280 宽：")
        for name, w in too_wide:
            print(f"    {name}  宽 {w}px，右边 {w - TARGET[0]}px 被裁掉了")
        print("    **裁掉的那一条里很可能就有 popup**（它靠右挂在工具栏下面）。")
        print("    先把窗口调成 1280x800、挪到屏幕左上角，再重截。")
        print("    （别改成 MODE=\"fit\" 绕过去 —— 那会把字缩到 67%，正是上一批糊掉的原因。）")


if __name__ == "__main__":
    main()
