"""펄스 라이플 모델 (assets_src/reference/rifle_ortho.png의 LEFT 도면 기준).

도면 픽셀 좌표를 그대로 적고 P()로 미터 단위 라이플 로컬 좌표(y=총구 방향, z=위)로 바꾼다.
원점 = 권총손잡이 위, 총열 축선 높이.
"""
from mathutils import Matrix, Vector

from lib_build import box, cyl, material, prism

S = 0.72 / 670.0  # m per px (도면에서 총 길이 670px → 0.72m)


def P(x, y):
    return ((430 - x) * S, (140 - y) * S)


def PL(*pts):
    return [P(x, y) for x, y in pts]


# 라이플 로컬 주요 지점
MUZZLE = Vector((0.0, (430 - 33) * S, 0.0))
GRIP_CENTER = Vector((0.0, P(432, 250)[0], P(432, 250)[1]))
HANDGUARD_BOTTOM = Vector((0.0, P(215, 212)[0], P(215, 212)[1]))
MAG_CENTER = Vector((0.0, P(575, 250)[0], P(575, 250)[1]))
MAG_BOTTOM = Vector((0.0, P(578, 298)[0], P(578, 298)[1]))
TRIGGER = Vector((0.0, P(390, 224)[0], P(390, 224)[1]))


def materials():
    return {
        'metal': material('gun_metal', (0.035, 0.04, 0.05), rough=0.45, metal=0.7),
        'dark': material('gun_dark', (0.02, 0.022, 0.028), rough=0.6, metal=0.3),
        'blue': material('armor_blue', (0.018, 0.075, 0.5), rough=0.38, metal=0.3),
        'white': material('armor_white', (0.6, 0.63, 0.68), rough=0.4, metal=0.1),
        'cyan': material('glow_cyan', (0.05, 0.5, 0.6), rough=0.3, emit=(0.15, 0.9, 1.0), emit_strength=3.0),
    }


def build_rifle(D=None, gun='gun', mag='mag'):
    """D: 라이플 로컬 → 리그 공간(레스트 포즈) 행렬."""
    D = D or Matrix.Identity(4)
    m = materials()
    k = dict(xform=D)

    # --- 몸통 코어
    prism('core', PL((122, 96), (250, 80), (520, 80), (548, 98), (548, 198), (470, 214), (292, 214), (126, 190)),
          0.054, m['metal'], gun, bevel=0.003, **k)
    # 상단 레일 + 톱니
    prism('rail', PL((255, 70), (440, 70), (444, 82), (251, 82)), 0.03, m['dark'], gun, bevel=0.0015, **k)
    for i in range(9):
        x0 = 262 + i * 19.5
        prism(f'rail_t{i}', PL((x0, 64), (x0 + 11, 64), (x0 + 11, 72), (x0, 72)), 0.034, m['dark'], gun, bevel=0.001, **k)

    # --- 파란 장갑 패널
    prism('shroud_f', PL((104, 94), (120, 84), (168, 72), (178, 100), (178, 172), (150, 192), (108, 186)),
          0.068, m['blue'], gun, bevel=0.004, **k)
    prism('panel_top', PL((166, 73), (258, 72), (268, 84), (186, 95), (172, 100)), 0.064, m['blue'], gun, bevel=0.003, **k)
    prism('lower_trim', PL((106, 182), (150, 192), (282, 218), (276, 230), (122, 202)), 0.062, m['blue'], gun, bevel=0.003, **k)
    prism('rear_top', PL((470, 84), (522, 76), (540, 98), (470, 128)), 0.062, m['blue'], gun, bevel=0.003, **k)

    # --- 흰색 프레임 (에너지 셀 창 둘레)
    prism('frame_top', PL((166, 113), (182, 98), (392, 91), (404, 104), (188, 112)), 0.07, m['white'], gun, bevel=0.002, **k)
    prism('frame_rear', PL((392, 91), (476, 127), (458, 174), (440, 172), (455, 131), (386, 104)), 0.07, m['white'], gun, bevel=0.002, **k)
    prism('frame_low', PL((458, 174), (440, 166), (300, 196), (288, 190), (284, 204), (300, 212), (452, 186)),
          0.07, m['white'], gun, bevel=0.002, **k)

    # --- 하부 핸드가드 + 슬롯
    prism('handguard', PL((126, 166), (290, 166), (300, 200), (280, 216), (136, 196)), 0.058, m['metal'], gun, bevel=0.003, **k)
    for i in range(3):
        x0 = 168 + i * 30
        prism(f'slot{i}', PL((x0, 176), (x0 + 12, 176), (x0 + 22, 198), (x0 + 10, 198)), 0.06, m['dark'], gun, bevel=0.001, **k)

    # --- 방아쇠울 (각진 고리)
    prism('guard_front', PL((284, 204), (300, 212), (346, 292), (328, 300)), 0.026, m['white'], gun, bevel=0.002, **k)
    prism('guard_bottom', PL((328, 288), (438, 288), (446, 300), (328, 300)), 0.026, m['white'], gun, bevel=0.002, **k)

    # --- 에너지 셀 (양옆으로 튀어나온 발광 원통)
    y0, z0 = P(308, 137)
    y1, _ = P(438, 137)
    cyl('cell', D @ Vector((0, y1, z0)), D @ Vector((0, y0, z0)), 0.0245, 0.0245, m['cyan'], gun, segments=16)
    for nm, xa, xb in (('cell_cap_f', 296, 312), ('cell_cap_r', 432, 448)):
        ya, _ = P(xa, 137)
        yb, _ = P(xb, 137)
        cyl(nm, D @ Vector((0, yb, z0)), D @ Vector((0, ya, z0)), 0.0285, 0.0285, m['dark'], gun, segments=16, bevel=0.0015)
    # 셀 양옆 유리 느낌의 밝은 띠
    box('cell_glow_l', (-0.0, (y0 + y1) / 2, z0), (0.074, abs(y1 - y0) * 0.72, 0.022), m['cyan'], gun, bevel=0.003, **k)

    # --- 총열·소염기
    yb0, zb = P(126, 142)
    yb1, _ = P(60, 142)
    cyl('barrel', D @ Vector((0, yb0, zb)), D @ Vector((0, yb1, zb)), 0.015, 0.015, m['dark'], gun, segments=14)
    ym0, _ = P(104, 142)
    ym1, _ = P(33, 142)
    cyl('muzzle_brake', D @ Vector((0, ym0, zb)), D @ Vector((0, ym1, zb)), 0.0195, 0.0195, m['metal'], gun, segments=10, bevel=0.002)
    for i in range(3):
        x0 = 48 + i * 17
        prism(f'brake_slot{i}', PL((x0, 133), (x0 + 8, 133), (x0 + 4, 151), (x0 - 4, 151)), 0.042, m['dark'], gun, bevel=0.0008, **k)
    cyl('bore_glow', D @ Vector((0, ym1 - 0.004, zb)), D @ Vector((0, ym1 + 0.001, zb)), 0.011, 0.011, m['cyan'], gun, segments=10)

    # --- 조준기
    prism('sight_base', PL((364, 62), (500, 62), (506, 84), (358, 84)), 0.046, m['metal'], gun, bevel=0.003, **k)
    prism('sight_house', PL((376, 62), (384, 20), (428, 10), (446, 22), (450, 62)), 0.058, m['blue'], gun, bevel=0.004, **k)
    prism('sight_frame', PL((382, 60), (388, 24), (426, 16), (440, 26), (444, 60)), 0.06, m['dark'], gun, bevel=0.002, **k)
    # 렌즈: 사수 쪽(뒤)과 앞쪽 면에 발광판
    ly, lz = P(447, 40)
    box('lens_rear', (0, ly - 0.0005, lz), (0.042, 0.004, 0.034), m['cyan'], gun, bevel=0.001, **k)
    fy, fz = P(381, 42)
    box('lens_front', (0, fy + 0.0005, fz), (0.04, 0.004, 0.03), m['cyan'], gun, bevel=0.001, **k)
    prism('sight_strip', PL((456, 66), (492, 66), (492, 73), (456, 73)), 0.049, m['cyan'], gun, bevel=0.0008, **k)

    # --- 개머리판
    prism('stock', PL((522, 78), (660, 70), (690, 82), (690, 204), (660, 214), (540, 204)), 0.072, m['blue'], gun, bevel=0.005, **k)
    prism('butt', PL((680, 78), (706, 86), (706, 206), (680, 212)), 0.08, m['dark'], gun, bevel=0.004, **k)
    prism('stock_strip', PL((586, 136), (666, 136), (666, 145), (586, 145)), 0.075, m['cyan'], gun, bevel=0.0008, **k)
    prism('front_strip', PL((140, 136), (272, 138), (272, 147), (140, 145)), 0.071, m['cyan'], gun, bevel=0.0008, **k)
    prism('mid_strip', PL((470, 180), (502, 178), (502, 188), (470, 190)), 0.058, m['cyan'], gun, bevel=0.0008, **k)

    # --- 권총손잡이·방아쇠
    prism('grip', PL((396, 210), (446, 210), (490, 300), (456, 314), (430, 300)), 0.036, m['dark'], gun, bevel=0.005, **k)
    prism('grip_heel', PL((448, 224), (470, 220), (506, 300), (490, 314), (478, 300)), 0.04, m['blue'], gun, bevel=0.004, **k)
    prism('trigger', PL((384, 208), (392, 208), (397, 238), (389, 242)), 0.008, m['blue'], gun, bevel=0.001, **k)

    # --- 탄창 (별도 본)
    prism('magazine', PL((530, 196), (620, 198), (628, 290), (600, 300), (520, 282)), 0.042, m['metal'], mag, bevel=0.004, **k)
    for i in range(3):
        y0p = 222 + i * 22
        prism(f'mag_rib{i}', PL((540, y0p), (616, y0p + 2), (616, y0p + 9), (540, y0p + 7)), 0.045, m['dark'], mag, bevel=0.0008, **k)
