"""
拾光图标光栅化：SVG → PNG。

为什么自己画而不用现成转换器：
环境里没有 cairosvg / magick / rsvg。而且这个图标形状极简（圆角方块、
圆、椭圆、四角星），手写光栅化反而能精确控制超采样与描边磨角，
不必依赖外部工具的版本差异。

关键：**4× 超采样**。图标最终会被缩到16px 显示，直接按目标尺寸绘制
会让圆角边缘出现明显锯齿。先在 4 倍分辨率画好，再用 LANCZOS 缩小。
"""
import math
from PIL import Image, ImageDraw

# ---- 选定方案：星 38 · 右倾 22° ----
BG = (43, 182, 115, 255)      # 亮绿
INK = (17, 17, 17, 255)       # 近黑
WHITE = (255, 255, 255, 255)
CORNER = 112                  # 圆角半径（对应512 视口）
CX, CY, FACE = 256, 272, 150  # 脸：正中，半径 150

STAR_R, STAR_SW, STAR_INNER, STAR_TILT = 38, 19, 0.40, 22
SAFE = 474
STAR_CX = SAFE - (STAR_R + STAR_SW / 2)
STAR_CY = CY - FACE * 0.62 - STAR_R * 0.55

SS = 4  # 超采样倍数


def star_points(cx, cy, R, inner, tilt_deg, n=4):
    """四角星：n 个外顶点 + n 个内凹点，交替排列。"""
    rot = math.radians(tilt_deg)
    pts = []
    for i in range(n * 2):
        a = -math.pi / 2 + i * math.pi / n + rot
        r = R if i % 2 == 0 else R * inner
        pts.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
    return pts


def rounded_points(pts, radius, round_amt):
    """把多边形顶点向外扩成圆角。

    round_amt 必须基于**线宽**而不是星半径 —— 之前误用了半径的一半，
    退让量过大把整个星压扁成了一个小方块。
    """
    out = []
    m = len(pts)
    for i in range(m):
        p = pts[i]
        prev = pts[(i - 1) % m]
        nxt = pts[(i + 1) % m]
        for q in (prev, nxt):
            d = math.hypot(q[0] - p[0], q[1] - p[1])
            t = (round_amt / 2) / d if d else 0
            t = min(t, 0.45)   # 退让不能吃掉整条边，否则形状塌掉
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    return out


def render(size):
    s = size * SS
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = s / 512.0  # 视口缩放系数

    # 圆角底板：纯色填充
    d.rounded_rectangle(
        [0, 0, s - 1, s - 1], radius=int(CORNER * k), fill=BG)

    # 脸
    fx, fy, fr = CX * k, CY * k, FACE * k
    d.ellipse([fx - fr, fy - fr, fx + fr, fy + fr], fill=INK)

    # 眼睛：脸的**下半部**，间距约为脸宽 0.46
    eDx, eDy = fr * 0.23, fr * 0.16
    eRx, eRy = fr * 0.15, fr * 0.24
    for sign in (-1, 1):
        ex, ey = fx + sign * eDx, fy + eDy
        d.ellipse([ex - eRx, ey - eRy, ex + eRx, ey + eRy], fill=WHITE)

    # 星：描边向外扩 sw/2 用来磨圆角，round joint 用圆头线段近似
    R = STAR_R * k
    sw = STAR_SW * k
    sx, sy = STAR_CX * k, STAR_CY * k
    pts = star_points(sx, sy, R, STAR_INNER, STAR_TILT)
    rp = rounded_points(pts, R, sw)
    d.polygon(rp, fill=INK)
    m = len(rp)
    for i in range(m):
        d.line([rp[i], rp[(i + 1) % m]], fill=INK, width=int(round(sw)),
               joint='curve')
        # 圆头：每个端点补一个圆，模拟 stroke-linejoin:round
        r = sw / 2
        for p in (rp[i], rp[(i + 1) % m]):
            d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=INK)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    for size in (16, 32, 48, 128):
        render(size).save(f'icons/icon{size}.png')
        print(f'icon{size}.png')
    print('完成')