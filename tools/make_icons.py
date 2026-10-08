"""產生 PWA 圖示（純 Python，無第三方依賴）。
畫一個圓角方形背景 + 白色回收三角標誌。
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icons')
os.makedirs(OUT, exist_ok=True)

GREEN = (15, 157, 88)
TEAL = (38, 132, 168)
WHITE = (255, 255, 255)


def write_png(path, w, h, rgba):
    def chunk(typ, data):
        return (struct.pack('>I', len(data)) + typ + data +
                struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff))
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def tri_inside(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def rounded_rect_inside(x, y, w, h, r):
    if x < 0 or y < 0 or x > w or y > h:
        return False
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    return math.hypot(x - cx, y - cy) <= r + 1e-9


def build_geometry(S, maskable):
    """回傳 (圓角半徑, 三角形外接圓半徑, 線粗)。"""
    if maskable:
        return 0, S * 0.255, S * 0.072
    return S * 0.22, S * 0.315, S * 0.088


def render(S, maskable):
    radius, R, TH = build_geometry(S, maskable)
    cx = cy = S / 2.0

    # 三角形三個頂點（尖端朝上）
    angs = [-math.pi / 2, math.pi / 6, math.pi * 5 / 6]
    verts = [(cx + R * math.cos(a), cy + R * math.sin(a)) for a in angs]

    # 每條邊：由頂點 i 指向 i+1，頭尾各留空隙，末端加箭頭
    GAP = 0.20
    segs = []
    heads = []
    for i in range(3):
        a = verts[i]
        b = verts[(i + 1) % 3]
        ex, ey = b[0] - a[0], b[1] - a[1]
        L = math.hypot(ex, ey)
        ux, uy = ex / L, ey / L
        s = (a[0] + ux * L * GAP, a[1] + uy * L * GAP)
        e = (b[0] - ux * L * GAP, b[1] - uy * L * GAP)
        segs.append((s, e))
        # 箭頭：以 e 為尖端，向後張開
        hw = TH * 1.85
        hl = TH * 2.6
        base = (e[0] - ux * hl, e[1] - uy * hl)
        nx, ny = -uy, ux
        p1 = (base[0] + nx * hw, base[1] + ny * hw)
        p2 = (base[0] - nx * hw, base[1] - ny * hw)
        heads.append((e, p1, p2))

    SS = 3  # 超取樣倍率
    rgba = bytearray(S * S * 4)
    step = 1.0 / SS
    offs = [(i + 0.5) * step for i in range(SS)]

    for py in range(S):
        for px in range(S):
            bg_cov = 0
            fg_cov = 0
            for oy in offs:
                yy = py + oy
                for ox in offs:
                    xx = px + ox
                    if maskable:
                        inside_bg = True
                    else:
                        inside_bg = rounded_rect_inside(xx, yy, S, S, radius)
                    if inside_bg:
                        bg_cov += 1
                        hit = False
                        for (s, e) in segs:
                            if seg_dist(xx, yy, s[0], s[1], e[0], e[1]) <= TH / 2.0:
                                hit = True
                                break
                        if not hit:
                            for (a, b, c) in heads:
                                if tri_inside(xx, yy, a, b, c):
                                    hit = True
                                    break
                        if hit:
                            fg_cov += 1
            total = SS * SS
            i = (py * S + px) * 4
            if bg_cov == 0:
                rgba[i:i + 4] = b'\x00\x00\x00\x00'
                continue
            # 背景漸層（左上綠 → 右下青）
            k = (px + py) / (2.0 * S)
            br = int(GREEN[0] * (1 - k) + TEAL[0] * k)
            bg_ = int(GREEN[1] * (1 - k) + TEAL[1] * k)
            bb = int(GREEN[2] * (1 - k) + TEAL[2] * k)
            f = fg_cov / float(total)
            r = int(br * (1 - f) + WHITE[0] * f)
            g = int(bg_ * (1 - f) + WHITE[1] * f)
            b = int(bb * (1 - f) + WHITE[2] * f)
            a = int(255 * (bg_cov / float(total)))
            rgba[i] = r
            rgba[i + 1] = g
            rgba[i + 2] = b
            rgba[i + 3] = a
    return rgba


def main():
    for size, name, maskable in [
        (192, 'icon-192.png', False),
        (512, 'icon-512.png', False),
        (512, 'icon-maskable-512.png', True),
    ]:
        rgba = render(size, maskable)
        path = os.path.join(OUT, name)
        write_png(path, size, size, rgba)
        print('wrote', path, os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    main()
