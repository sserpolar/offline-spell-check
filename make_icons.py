"""生成扩展图标（16/48/128）＋ Edge 商店要求的 300×300 logo。纯 Pillow，零外部素材、零字体依赖。

    python make_icons.py

图形语义：深色圆角底 + 两条白色「文字行」+ 最后一行下面一道**红色波浪线**。
波浪下划线是全球通用的「拼写错误」视觉符号（每个文字编辑器都用它），
所以不需要写字、不需要字体、16px 下也认得出来。

⚠️ 不用文字（"A" / "abc"）的原因：ImageDraw.text 要么依赖系统字体（跨机器不可复现），
   要么用 PIL 内置点阵字体（16px 下糊成一团）。画几何形状是唯一可复现的做法。

⚠️ 300×300 那张（icons/logo300.png）**不进扩展包**（build.py 白名单不含它），
   它只是 Edge Add-ons 的 Store listing 必填项：官方要求 1:1、推荐 300×300、最小 128×128。
   Chrome 商店那边用 icon128.png 就够。
"""

import math
import os

from PIL import Image, ImageDraw

BG = (30, 36, 48, 255)        # 深蓝灰底（与 popup 的 --bg 同色系）
FG = (236, 240, 246, 255)     # 文字行：近白
FG_DIM = (150, 162, 180, 255) # 次要文字行：灰
RED = (232, 62, 62, 255)      # 波浪线：红 —— 「这里有个拼写错误」

SS = 8  # 超采样倍率，先大画再缩，边缘才平滑


def wavy(d, x0, x1, y, amp, width, fill):
    """画一条正弦波浪线。用密集采样点 + joint="curve" 让缩小后仍然平滑。"""
    pts = []
    n = 96
    # 每个周期的长度定成振幅的 4 倍左右，看起来最像编辑器里的拼写波浪线
    period = amp * 4.0
    for i in range(n + 1):
        x = x0 + (x1 - x0) * i / n
        pts.append((x, y + amp * math.sin(2 * math.pi * (x - x0) / period)))
    d.line(pts, fill=fill, width=width, joint="curve")


def draw_icon(size: int) -> Image.Image:
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角底
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG)

    bar_h = max(2, int(s * 0.078))
    left = s * 0.21
    radius = bar_h / 2

    # 第一行文字（灰、较长）
    y1 = s * 0.29
    d.rounded_rectangle([left, y1, s * 0.79, y1 + bar_h], radius=radius, fill=FG_DIM)

    # 第二行文字（白、较短）—— 这一行「有错」
    y2 = s * 0.49
    right2 = s * 0.60
    d.rounded_rectangle([left, y2, right2, y2 + bar_h], radius=radius, fill=FG)

    # 波浪下划线：紧贴第二行下方。
    # ⚠️ 振幅和线宽都要压住：第一版 amp=0.038 / width=0.055 时，波浪占了约 17px 高，
    #    视觉上变成「第三行独立元素」而不是下划线，16px 缩放后糊成一团。
    wavy(
        d,
        x0=left,
        x1=right2,
        y=y2 + bar_h + s * 0.075,
        amp=s * 0.024,
        width=max(2, int(s * 0.040)),
        fill=RED,
    )

    # 第三行文字（灰、最短）—— 让整体读作「一段文字，其中一行被标了错」，
    # 而不是「两条杠加一条波浪」。同时把重心拉回中间。
    y3 = s * 0.70
    d.rounded_rectangle([left, y3, s * 0.70, y3 + bar_h], radius=radius, fill=FG_DIM)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    os.makedirs("icons", exist_ok=True)
    for n in (16, 48, 128):
        p = f"icons/icon{n}.png"
        draw_icon(n).save(p)
        print("wrote", p)

    draw_icon(300).save("icons/logo300.png")
    print("wrote icons/logo300.png  (Edge store listing only, not shipped)")
