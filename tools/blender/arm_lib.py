"""장갑 팔(상완·전완·손·손가락) 공용 모듈: 레스트 관절 계산, 2본 IK 해석해, 지오메트리 생성.

build_arm의 G(bone)·XF(bone)으로 파트별 정점 그룹과 추가 변환을 정한다.
- 1인칭 리그처럼 본마다 따로 움직일 때: G=본 이름, XF=None
- 3인칭 봇처럼 팔 자세를 지오메트리에 구워 넣을 때: G=고정 그룹, XF=solve_arm 결과
"""
import math

from mathutils import Matrix, Quaternion, Vector

import lib_build as L

SIDE = {'L': 1.0, 'R': -1.0}  # 손바닥이 아래일 때 엄지 쪽 X 부호
FINGERS = [('index', 0.0315, 1.0), ('middle', 0.0105, 1.08), ('ring', -0.0105, 1.0), ('pinky', -0.0315, 0.82)]
SEG = [0.040, 0.027, 0.023]
THUMB_SEG = [0.036, 0.030, 0.026]


def orth(v, axis):
    v = Vector(v)
    w = v - axis * v.dot(axis)
    if w.length < 1e-5:
        w = Vector((0, 0, 1)) - axis * axis.z
    return w.normalized()


def hand_frame(pos_palm, fwd, back):
    """손바닥 중심·손가락 방향·손등 방향 → (손목 위치, f, u)."""
    f = Vector(fwd).normalized()
    u = orth(back, f)
    return (Vector(pos_palm) - f * 0.05, f, u)


def xf_frame(M, fr):
    W, f, u = fr
    r = M.to_3x3()
    return (M @ W, (r @ f).normalized(), (r @ u).normalized())


def arm_rest(sfx, base, L1, L2):
    s = SIDE[sfx]
    g = lambda n: f'{n}.{sfx}'  # noqa: E731
    rest = {}
    Sr = Vector(base)
    Er = Sr + Vector((0, L1, 0))
    Wr = Er + Vector((0, L2, 0))
    rest[g('upper')], rest[g('fore')], rest[g('hand')] = Sr, Er, Wr
    for name, xo, sc in FINGERS:
        y = Wr.y + 0.096
        for i, ln0 in enumerate(SEG):
            rest[g(f'{name}{i + 1}')] = Vector((Wr.x + s * xo, y, Wr.z))
            y += ln0 * sc
    dT = Vector((s * 0.62, 0.78, 0)).normalized()
    J = Wr + Vector((s * 0.036, 0.022, -0.006))
    for i, ln in enumerate(THUMB_SEG):
        rest[g(f'thumb{i + 1}')] = J.copy()
        J = J + dT * ln
    return rest


def build_arm(sfx, rest, L1, L2, mats, G=None, XF=None, thick=1.0, back=0.12):
    """mats: suit, glove, armor, trim, glow."""
    s = SIDE[sfx]
    g = lambda n: f'{n}.{sfx}'  # noqa: E731
    G = G or (lambda b: b)
    XF = XF or (lambda b: None)
    kw = lambda b: dict(group=G(g(b)), xform=XF(g(b)))  # noqa: E731
    Sr, Er, Wr = rest[g('upper')], rest[g('fore')], rest[g('hand')]
    t = thick
    L.cyl(g('upper_core'), Sr - Vector((0, back, 0)), Er, 0.06 * t, 0.05 * t, mats['suit'], segments=12, **kw('upper'))
    L.box(g('upper_plate'), Sr.lerp(Er, 0.45) + Vector((-s * 0.012, 0, 0.042 * t)), (0.075 * t, L1 * 0.62, 0.034), mats['armor'], bevel=0.008, **kw('upper'))
    L.sphere(g('elbow'), Er, 0.054 * t, mats['suit'], **kw('fore'))
    L.box(g('elbow_guard'), Er + Vector((0, -0.004, -0.044 * t)), (0.078 * t, 0.085, 0.036), mats['armor'], bevel=0.009, **kw('fore'))
    L.cyl(g('fore_core'), Er, Wr, 0.05 * t, 0.042 * t, mats['suit'], segments=12, **kw('fore'))
    L.cyl(g('gauntlet'), Er.lerp(Wr, 0.16), Er.lerp(Wr, 0.9), 0.072 * t, 0.057 * t, mats['armor'], segments=10, bevel=0.004, **kw('fore'))
    for zs in (1, -1):
        L.box(g(f'gauntlet_trim{zs}'), Er.lerp(Wr, 0.5) + Vector((-s * zs * 0.034 * t, 0, zs * 0.05 * t)), (0.04, L2 * 0.42, 0.016), mats['trim'],
              bevel=0.004, rot=Matrix.Rotation(-s * math.radians(34), 3, 'Y'), **kw('fore'))
        L.box(g(f'gauntlet_line{zs}'), Er.lerp(Wr, 0.52) + Vector((s * zs * 0.012, 0, zs * 0.0635 * t)), (0.009, L2 * 0.52, 0.006), mats['glow'], bevel=0.001, **kw('fore'))
    L.cyl(g('cuff'), Wr + Vector((0, -0.032, 0)), Wr + Vector((0, 0.004, 0)), 0.05 * t, 0.046 * t, mats['armor'], segments=12, bevel=0.003, **kw('fore'))
    L.box(g('palm'), Wr + Vector((0, 0.05, 0)), (0.086, 0.094, 0.034), mats['glove'], bevel=0.009, segments=3, **kw('hand'))
    L.box(g('back_plate'), Wr + Vector((0, 0.044, 0.019)), (0.064, 0.05, 0.01), mats['armor'], bevel=0.003, **kw('hand'))
    L.box(g('knuckle_guard'), Wr + Vector((0, 0.088, 0.015)), (0.084, 0.022, 0.016), mats['armor'], bevel=0.004, **kw('hand'))
    for name, _, sc in FINGERS:
        for i, ln0 in enumerate(SEG):
            ln = ln0 * sc
            bone = f'{name}{i + 1}'
            J = rest[g(bone)]
            L.box(g(bone) + '_seg', J + Vector((0, ln / 2, 0)), (0.019, ln + 0.004, 0.019), mats['glove'], bevel=0.0045, **kw(bone))
            if i < 2:
                L.box(g(bone) + '_plate', J + Vector((0, ln * 0.52, 0.0105)), (0.015, ln * 0.6, 0.005), mats['armor'], bevel=0.0015, **kw(bone))
    dT = Vector((s * 0.62, 0.78, 0)).normalized()
    rotT = Matrix.Rotation(-s * math.atan2(0.62, 0.78), 3, 'Z')
    for i, ln in enumerate(THUMB_SEG):
        bone = f'thumb{i + 1}'
        J = rest[g(bone)]
        L.box(g(bone) + '_seg', J + dT * (ln / 2), (0.021, ln + 0.004, 0.02), mats['glove'], bevel=0.0048, rot=rotT, **kw(bone))


def solve_arm(sfx, rest, shoulder, elbow_hint, L1, L2, fr, curls, thumb):
    """손 프레임 → 팔·손·손가락 본의 변환 X (레스트 → 포즈)."""
    s = SIDE[sfx]
    g = lambda n: f'{n}.{sfx}'  # noqa: E731
    W, f, u = fr
    S = Vector(shoulder)
    d = W - S
    dist = min(d.length, L1 + L2 - 0.002)
    n = d.normalized()
    a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(L1 * L1 - a * a, 1e-8))
    e = orth(Vector(elbow_hint), n)
    E = S + n * a + e * h
    Wc = S + n * dist
    X = {}
    du = (E - S).normalized()
    zu = orth(Vector((-s * 0.3, 0, 1)), du)
    X[g('upper')] = L.basis(du.cross(zu), du, zu, S) @ Matrix.Translation(-rest[g('upper')])
    df = (Wc - E).normalized()
    zf = orth(u, df)
    X[g('fore')] = L.basis(df.cross(zf), df, zf, E) @ Matrix.Translation(-rest[g('fore')])
    Xh = L.basis(f.cross(u), f, u, Wc) @ Matrix.Translation(-rest[g('hand')])
    X[g('hand')] = Xh
    for name, _, _ in FINGERS:
        c = curls[name] if isinstance(curls, dict) else curls
        Xp = Xh
        for i in range(3):
            bone = g(f'{name}{i + 1}')
            Xp = Xp @ L.rot_about(rest[bone], (1, 0, 0), -c[i])
            X[bone] = Xp
    opp, f1, f2, f3 = thumb
    dT = Vector((s * 0.62, 0.78, 0)).normalized()
    ax = Vector((dT.y, -dT.x, 0))
    Xp = Xh @ L.rot_about(rest[g('thumb1')], (0, 1, 0), s * opp) @ L.rot_about(rest[g('thumb1')], ax, -f1)
    X[g('thumb1')] = Xp
    Xp = Xp @ L.rot_about(rest[g('thumb2')], ax, -f2)
    X[g('thumb2')] = Xp
    Xp = Xp @ L.rot_about(rest[g('thumb3')], ax, -f3)
    X[g('thumb3')] = Xp
    return X


def frame_matrix(fr):
    W, f, u = fr
    return L.basis(f.cross(u), f, u, W)


def blend_frames(frames, weights):
    """손 프레임 여러 개를 가중 평균(위치 선형, 회전 쿼터니언)."""
    pos = Vector((0, 0, 0))
    q = None
    acc = Quaternion((0, 0, 0, 0))
    for fr, w in zip(frames, weights):
        if w <= 1e-6:
            continue
        m = frame_matrix(fr)
        pos += m.to_translation() * w
        qq = m.to_quaternion()
        if q is None:
            q = qq.copy()
        if qq.dot(q) < 0:
            qq.negate()
        acc = Quaternion((acc.w + qq.w * w, acc.x + qq.x * w, acc.y + qq.y * w, acc.z + qq.z * w))
    acc.normalize()
    rm = acc.to_matrix()
    return (pos, rm.col[1].copy(), rm.col[2].copy())


def mix_curls(sets, weights):
    return [sum(c[i] * w for c, w in zip(sets, weights)) for i in range(3)]
