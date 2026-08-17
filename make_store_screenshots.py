# -*- coding: utf-8 -*-
"""把任意尺寸的截图批量转成 Chrome / Edge 商店要求的 1280x800。

用法：
  1) 把原始截图（随便什么尺寸，PNG/JPG 都行）丢进  screenshots/raw/
  2) python make_store_screenshots.py
  3) 成品在 screenshots/store/ ，可直接上传商店

为什么不能用「画图」改画布：
  改画布 = 裁切（超出部分直接丢掉，容易被截断）
  调整大小 = 缩放（但 1920x1080 直接压到 1280x800 会变形，比例 1.78 -> 1.60）
本脚本 = 先等比缩放到装得进 1280x800，再用背景色补白居中 —— 既不裁切也不变形。

本项目要截哪 5 张、为什么是这 5 张，见 STORE_LISTING.md 第 8 节。
Edge 要求 1366x768 或 1280x800 —— 1280x800 两边通吃，不用出两套。

⚠️ 截图前把 popup 底部那三行耗时明细遮掉或裁掉。那是调试用的，
   用户不关心，而且数字会让人以为它慢。
"""

from pathlib import Path

from PIL import Image

TARGET = (1280, 800)  # Chrome 商店只接受 1280x800 或 640x400
BG = (255, 255, 255)  # 补白颜色。深色主题的截图改成 (32, 33, 36) 更自然

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "screenshots" / "raw"
OUT = ROOT / "screenshots" / "store"
EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def fit(img, target, bg):
    """等比缩放到装得进 target，再补白居中。只缩不放（放大会糊）。"""
    tw, th = target
    scale = min(tw / img.width, th / img.height)
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    canvas = Image.new("RGB", target, bg)
    canvas.paste(img.convert("RGB"), ((tw - img.width) // 2, (th - img.height) // 2))
    return canvas


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)

    files = sorted(p for p in RAW.iterdir() if p.suffix.lower() in EXTS)
    if not files:
        print(f"没找到图片。把原始截图放进这个目录再重跑：\n  {RAW}")
        return

    for i, path in enumerate(files, 1):
        with Image.open(path) as im:
            src = f"{im.width}x{im.height}"
            out = fit(im, TARGET, BG)
        dst = OUT / f"screenshot{i}-{TARGET[0]}x{TARGET[1]}.png"
        out.save(dst, "PNG", optimize=True)
        print(f"{path.name}  ({src})  ->  {dst.name}")

    print(f"\n完成 {len(files)} 张。可直接上传：\n  {OUT}")


if __name__ == "__main__":
    main()
