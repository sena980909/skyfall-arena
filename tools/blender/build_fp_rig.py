# 1인칭 팔 + 펄스 라이플 리그 생성 → public/assets/models/fp_rig.glb
# 실행: blender -b --factory-startup --python tools/blender/build_fp_rig.py -- <abs_project_dir> [preview_only]
#
# 리그 공간 = 카메라 공간(원점이 눈, +Y가 정면, +Z가 위). glTF로 내보내면 정면이 -Z가 되어 게임 카메라에 그대로 붙는다.
# 본은 모두 부모 없는 평면 구조이고 파트는 본 하나에 가중치 1(리지드). 포즈는 여기서 직접 계산(2본 IK 해석해)해 매 프레임 키를 찍는다.
import math
import os
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib_build as L  # noqa: E402
import fp_rifle as R  # noqa: E402
import reload_timeline as TL  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else ['.']
PROJECT = os.path.abspath(argv[0])
PREVIEW = os.path.join(PROJECT, 'assets_src', '_preview')
os.makedirs(PREVIEW, exist_ok=True)
FPS = 30

# ---------------------------------------------------------------- 배치 상수 (카메라 공간)
GUN_POS = Vector((0.19, 0.50, -0.155))
GUN_YAW = math.radians(15.0)     # 총구가 화면 중앙 쪽(왼쪽)으로
GUN_PITCH = math.radians(3.0)
SHOULDER = {'L': Vector((-0.14, 0.10, -0.36)), 'R': Vector((0.36, 0.02, -0.34))}
ELBOW_HINT = {'L': Vector((-0.7, -0.2, -1.0)), 'R': Vector((0.6, -0.3, -1.0))}
L1, L2 = 0.31, 0.30
SIDE = {'L': 1.0, 'R': -1.0}    # 엄지 쪽 X 부호 (손바닥이 아래일 때)
REST_BASE = {'L': Vector((-0.35, -0.3, -0.6)), 'R': Vector((0.35, -0.3, -0.6))}
FINGERS = [('index', 0.0315, 1.0), ('middle', 0.0105, 1.08), ('ring', -0.0105, 1.0), ('pinky', -0.0315, 0.82)]
SEG = [0.040, 0.027, 0.023]
THUMB_SEG = [0.036, 0.030, 0.026]
REST = {}   # 본 이름 → 레스트 관절 위치(Vector)


def gun_matrix(offset=(0, 0, 0), pitch=0.0, yaw=0.0, roll=0.0):
    return (Matrix.Translation(GUN_POS + Vector(offset))
            @ Matrix.Rotation(GUN_YAW + yaw, 4, 'Z')
            @ Matrix.Rotation(GUN_PITCH + pitch, 4, 'X')
            @ Matrix.Rotation(roll, 4, 'Y'))


D_REST = gun_matrix()


# ---------------------------------------------------------------- 모델링
def build_arm(sfx):
    s = SIDE[sfx]
    navy = L.material('suit_navy', (0.025, 0.035, 0.11), rough=0.6, metal=0.1)
    glove = L.material('glove_navy', (0.02, 0.028, 0.085), rough=0.7)
    blue = R.materials()['blue']
    white = R.materials()['white']
    cyan = R.materials()['cyan']
    g = lambda n: f'{n}.{sfx}'  # noqa: E731
    Sr = REST_BASE[sfx].copy()
    Er = Sr + Vector((0, L1, 0))
    Wr = Er + Vector((0, L2, 0))
    REST[g('upper')], REST[g('fore')], REST[g('hand')] = Sr, Er, Wr

    # 상완 (어깨 뒤로 넉넉히 늘려 화면 밖까지 이어지게)
    L.cyl(g('upper_core'), Sr - Vector((0, 0.12, 0)), Er, 0.06, 0.05, navy, g('upper'), segments=12)
    L.box(g('upper_plate'), Sr.lerp(Er, 0.45) + Vector((-s * 0.012, 0, 0.042)), (0.075, L1 * 0.62, 0.034), blue, g('upper'), bevel=0.008)
    # 팔꿈치
    L.sphere(g('elbow'), Er, 0.054, navy, g('fore'))
    L.box(g('elbow_guard'), Er + Vector((0, -0.004, -0.044)), (0.078, 0.085, 0.036), blue, g('fore'), bevel=0.009)
    # 전완 + 건틀릿
    L.cyl(g('fore_core'), Er, Wr, 0.05, 0.042, navy, g('fore'), segments=12)
    L.cyl(g('gauntlet'), Er.lerp(Wr, 0.16), Er.lerp(Wr, 0.9), 0.072, 0.057, blue, g('fore'), segments=10, bevel=0.004)
    L.box(g('gauntlet_white'), Er.lerp(Wr, 0.5) + Vector((-s * 0.034, 0, 0.05)), (0.04, L2 * 0.42, 0.016), white, g('fore'),
          bevel=0.004, rot=Matrix.Rotation(-s * math.radians(34), 3, 'Y'))
    L.box(g('gauntlet_line'), Er.lerp(Wr, 0.52) + Vector((s * 0.012, 0, 0.0635)), (0.009, L2 * 0.52, 0.006), cyan, g('fore'), bevel=0.001)
    # 손바닥 쪽(아랫면)에도 장식: 왼팔은 손바닥이 위를 향해 카메라가 이 면을 본다
    L.box(g('gauntlet_white_b'), Er.lerp(Wr, 0.5) + Vector((s * 0.03, 0, -0.052)), (0.042, L2 * 0.44, 0.016), white, g('fore'),
          bevel=0.004, rot=Matrix.Rotation(-s * math.radians(30), 3, 'Y'))
    L.box(g('gauntlet_line_b'), Er.lerp(Wr, 0.52) + Vector((-s * 0.014, 0, -0.0635)), (0.009, L2 * 0.52, 0.006), cyan, g('fore'), bevel=0.001)
    L.box(g('gauntlet_ridge'), Er.lerp(Wr, 0.5) + Vector((-s * 0.066, 0, 0)), (0.014, L2 * 0.5, 0.05), navy, g('fore'), bevel=0.004)
    L.cyl(g('cuff'), Wr + Vector((0, -0.032, 0)), Wr + Vector((0, 0.004, 0)), 0.05, 0.046, blue, g('fore'), segments=12, bevel=0.003)
    # 손
    L.box(g('palm'), Wr + Vector((0, 0.05, 0)), (0.086, 0.094, 0.034), glove, g('hand'), bevel=0.009, segments=3)
    L.box(g('back_plate'), Wr + Vector((0, 0.044, 0.019)), (0.064, 0.05, 0.01), blue, g('hand'), bevel=0.003)
    L.box(g('knuckle_guard'), Wr + Vector((0, 0.088, 0.015)), (0.084, 0.022, 0.016), blue, g('hand'), bevel=0.004)
    for name, xo, sc in FINGERS:
        y = Wr.y + 0.096
        for i, ln0 in enumerate(SEG):
            ln = ln0 * sc
            J = Vector((Wr.x + s * xo, y, Wr.z))
            bone = g(f'{name}{i + 1}')
            REST[bone] = J
            L.box(bone + '_seg', J + Vector((0, ln / 2, 0)), (0.019, ln + 0.004, 0.019), glove, bone, bevel=0.0045)
            L.cyl(bone + '_joint', J - Vector((0.0092, 0, 0)), J + Vector((0.0092, 0, 0)), 0.0098, 0.0098, glove, bone, segments=10)
            if i < 2:
                L.box(bone + '_plate', J + Vector((0, ln * 0.52, 0.0105)), (0.015, ln * 0.6, 0.005), blue, bone, bevel=0.0015)
            y += ln
    # 엄지
    dT = Vector((s * 0.62, 0.78, 0)).normalized()
    rotT = Matrix.Rotation(-s * math.atan2(0.62, 0.78), 3, 'Z')
    J = Wr + Vector((s * 0.036, 0.022, -0.006))
    for i, ln in enumerate(THUMB_SEG):
        bone = g(f'thumb{i + 1}')
        REST[bone] = J.copy()
        L.box(bone + '_seg', J + dT * (ln / 2), (0.021, ln + 0.004, 0.02), glove, bone, bevel=0.0048, rot=rotT)
        if i > 0:
            L.box(bone + '_plate', J + dT * (ln * 0.5) + Vector((0, 0, 0.011)), (0.016, ln * 0.6, 0.005), blue, bone, bevel=0.0015, rot=rotT)
        J = J + dT * ln


# ---------------------------------------------------------------- 포즈 계산
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


def frame_matrix(fr):
    W, f, u = fr
    return L.basis(f.cross(u), f, u, W)


def blend_frames(frames, weights):
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


def solve_arm(sfx, fr, curls, thumb):
    """손 프레임(카메라 공간) → 팔·손·손가락 본의 변환 X (레스트 → 포즈)."""
    s = SIDE[sfx]
    g = lambda n: f'{n}.{sfx}'  # noqa: E731
    W, f, u = fr
    S = SHOULDER[sfx]
    d = W - S
    dist = min(d.length, L1 + L2 - 0.002)
    n = d.normalized()
    a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(L1 * L1 - a * a, 1e-8))
    e = orth(ELBOW_HINT[sfx], n)
    E = S + n * a + e * h
    Wc = S + n * dist  # 팔이 닿지 않으면 손목은 최대 도달 지점
    X = {}
    du = (E - S).normalized()
    zu = orth(Vector((-s * 0.3, 0, 1)), du)
    X[g('upper')] = L.basis(du.cross(zu), du, zu, S) @ Matrix.Translation(-REST[g('upper')])
    df = (Wc - E).normalized()
    zf = orth(u, df)
    X[g('fore')] = L.basis(df.cross(zf), df, zf, E) @ Matrix.Translation(-REST[g('fore')])
    Xh = L.basis(f.cross(u), f, u, Wc) @ Matrix.Translation(-REST[g('hand')])
    X[g('hand')] = Xh
    for name, _, _ in FINGERS:
        c = curls[name] if isinstance(curls, dict) else curls
        Xp = Xh
        for i in range(3):
            bone = g(f'{name}{i + 1}')
            Xp = Xp @ L.rot_about(REST[bone], (1, 0, 0), -c[i])
            X[bone] = Xp
    opp, f1, f2, f3 = thumb
    dT = Vector((s * 0.62, 0.78, 0)).normalized()
    ax = Vector((dT.y, -dT.x, 0))
    Xp = Xh @ L.rot_about(REST[g('thumb1')], (0, 1, 0), s * opp) @ L.rot_about(REST[g('thumb1')], ax, -f1)
    X[g('thumb1')] = Xp
    Xp = Xp @ L.rot_about(REST[g('thumb2')], ax, -f2)
    X[g('thumb2')] = Xp
    Xp = Xp @ L.rot_about(REST[g('thumb3')], ax, -f3)
    X[g('thumb3')] = Xp
    return X


def ramp(t, t0, t1):
    if t <= t0:
        return 0.0
    if t >= t1:
        return 1.0
    k = (t - t0) / (t1 - t0)
    return k * k * (3 - 2 * k)


def lerp3(a, b, k):
    return tuple(x + (y - x) * k for x, y in zip(a, b))


def mix_curls(sets, weights):
    return [sum(c[i] * w for c, w in zip(sets, weights)) for i in range(3)]


# 손 자세 (라이플 로컬)
def grip_right():
    pc = R.GRIP_CENTER + Vector((0.036, -0.012, 0.012))
    return hand_frame(pc, (0.0, 1.0, -0.12), (1.0, 0.0, 0.0))


def grip_left():
    pc = R.HANDGUARD_BOTTOM + Vector((-0.004, 0.0, -0.02))
    return hand_frame(pc, (0.86, 0.48, 0.16), (0.0, 0.0, -1.0))


def hold_mag():
    pc = R.MAG_BOTTOM + Vector((-0.004, 0.0, -0.02))
    return hand_frame(pc, (0.9, 0.3, 0.12), (0.0, 0.0, -1.0))


def xf_frame(M, fr):
    W, f, u = fr
    r = M.to_3x3()
    return (M @ W, (r @ f).normalized(), (r @ u).normalized())


CURL_R = {'index': [0.35, 0.95, 0.5], 'middle': [1.3, 1.45, 0.8], 'ring': [1.35, 1.45, 0.8], 'pinky': [1.4, 1.45, 0.8]}
THUMB_R = (1.0, 0.25, 0.35, 0.3)
CURL_L_GRIP = [1.15, 1.0, 0.55]
CURL_L_RELAX = [0.35, 0.4, 0.3]
CURL_L_MAG = [0.9, 0.9, 0.5]
THUMB_L_GRIP = (0.9, 0.5, 0.3, 0.2)
THUMB_L_RELAX = (0.4, 0.2, 0.2, 0.1)
# 왼손이 새 탄창을 꺼내러 가는 곳: 3인칭 몸의 왼쪽 골반 앞 탄창 주머니를 카메라 공간으로 옮긴 위치.
# (몸 공간 주머니 (-0.15, 0.10, 1.02) / 0.95배 몸의 눈 (0, 0.09, 1.60) 기준. 예전에는 배 앞 허공 (-0.10, 0.34, -0.58)이었다)
AWAY_L = hand_frame((-0.14, 0.03, -0.60), (0.15, 0.25, -0.95), (-0.9, 0.3, 0.0))
RELOAD_LEN = TL.RELOAD_LEN


def pose(clip, t):
    """clip 시각 t의 모든 본 변환 X."""
    if clip == 'reload':
        cant = TL.cant(t)
        # 총구를 왼쪽 위로 들고, 윗면을 오른쪽으로 굴려 왼쪽 면과 탄창 구멍이 카메라를 향하게. 앞으로 내밀어 탄창이 화면 안에 들어오게
        D = gun_matrix(offset=(-0.13 * cant, 0.10 * cant, 0.13 * cant), pitch=0.5 * cant, yaw=0.3 * cant, roll=0.75 * cant)
        # 탄창: 빠짐 → (화면 밖에서 새 탄창) → 삽입
        mag_off = TL.mag_offset(t, (0.0, -0.02, -0.42), (0.0, -0.08, -0.40))
        wA, wM, wAway = TL.hand_weights(t)
    else:
        breathe = math.sin(t / 2.0 * math.tau) if clip == 'idle' else 0.0
        D = gun_matrix(offset=(0, 0, 0.0015 * breathe), pitch=0.004 * breathe)
        mag_off = (0, 0, 0)
        wA, wM, wAway = 1.0, 0.0, 0.0
    Dm = D @ Matrix.Translation(mag_off)
    Dinv = D_REST.inverted()
    X = {'gun': D @ Dinv, 'muzzle': D @ Dinv, 'mag': Dm @ Dinv}
    X.update(solve_arm('R', xf_frame(D, grip_right()), CURL_R, THUMB_R))
    frL = blend_frames([xf_frame(D, grip_left()), xf_frame(Dm, hold_mag()), AWAY_L], [wA, wM, wAway])
    curlL = mix_curls([CURL_L_GRIP, CURL_L_MAG, CURL_L_RELAX], [wA, wM, wAway])
    thumbL = tuple(a * wA + b * (wM + wAway) for a, b in zip(THUMB_L_GRIP, THUMB_L_RELAX))
    X.update(solve_arm('L', frL, curlL, thumbL))
    return X


# ---------------------------------------------------------------- 빌드
L.reset_scene()
bpy.context.scene.render.fps = FPS
R.build_rifle(D_REST)
build_arm('L')
build_arm('R')
REST['gun'] = D_REST @ Vector((0, 0, 0))
REST['mag'] = D_REST @ R.MAG_CENTER
REST['muzzle'] = D_REST @ R.MUZZLE
mesh_ob = L.join_parts('FPRigMesh')
L.box_uv(mesh_ob, 0.22)
tris = sum(len(p.vertices) - 2 for p in mesh_ob.data.polygons)
print('TRIS', tris, 'VERTS', len(mesh_ob.data.vertices), 'MATS', len(mesh_ob.data.materials))

arm_data = bpy.data.armatures.new('FPRig')
arm = bpy.data.objects.new('FPRig', arm_data)
bpy.context.scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
for name, head in REST.items():
    eb = arm_data.edit_bones.new(name)
    eb.head = head
    eb.tail = head + Vector((0, 0.04, 0))
    eb.roll = 0.0
    eb.use_deform = name != 'muzzle'
bpy.ops.object.mode_set(mode='OBJECT')
mesh_ob.parent = arm
mod = mesh_ob.modifiers.new('Armature', 'ARMATURE')
mod.object = arm
REST_M = {b.name: b.matrix_local.copy() for b in arm_data.bones}
for pb in arm.pose.bones:
    pb.rotation_mode = 'QUATERNION'
LAST_Q = {}


def apply_pose(X, key_frame=None):
    for pb in arm.pose.bones:
        rest = REST_M[pb.name]
        mb = rest.inverted() @ X[pb.name] @ rest
        loc, rot, _ = mb.decompose()
        prev = LAST_Q.get(pb.name)
        if prev is not None and rot.dot(prev) < 0:
            rot.negate()
        LAST_Q[pb.name] = rot.copy()
        pb.location = loc
        pb.rotation_quaternion = rot
        if key_frame is not None:
            pb.keyframe_insert('location', frame=key_frame)
            pb.keyframe_insert('rotation_quaternion', frame=key_frame)


# ---------------------------------------------------------------- 미리보기 렌더
cam = L.setup_preview(res=(1280, 720), fov_deg=56)


def shot(name, clip, t, loc=None, look=None, fov=None):
    LAST_Q.clear()
    apply_pose(pose(clip, t))
    bpy.context.view_layer.update()
    if loc is None:
        cam.location = (0, 0, 0)
        cam.rotation_euler = (math.radians(90), 0, 0)
        cam.data.angle_y = math.radians(56)
        L.render(os.path.join(PREVIEW, name + '.png'))
    else:
        L.render(os.path.join(PREVIEW, name + '.png'), loc=loc, look_at=look, fov_deg=fov or 40)


shot('fp_idle', 'idle', 0.0)
shot('ext_left', 'idle', 0.0, loc=(-0.9, 0.35, 0.15), look=(0.08, 0.45, -0.2))
shot('ext_right_low', 'idle', 0.0, loc=(0.75, 0.75, -0.55), look=(0.1, 0.42, -0.2))
for tt in (0.3, 0.7, 0.95, 1.2):
    shot(f'fp_reload_{int(tt * 100):03d}', 'reload', tt)
if len(argv) > 1 and argv[1] == 'preview_only':
    print('PREVIEW_ONLY_DONE')
    sys.exit(0)

# ---------------------------------------------------------------- 애니메이션 키 + NLA
arm.animation_data_create()


def bake(clip, length):
    LAST_Q.clear()
    act = bpy.data.actions.new(clip)
    arm.animation_data.action = act
    n = max(1, round(length * FPS))
    for fi in range(n + 1):
        apply_pose(pose(clip, fi / FPS), key_frame=fi)
    return act, n


acts = [bake('idle', 2.0), bake('reload', RELOAD_LEN)]
slot_of = {}
for act, _ in acts:
    slots = getattr(act, 'slots', None)
    slot_of[act.name] = slots[0] if slots else None
arm.animation_data.action = None
for act, n in acts:
    tr = arm.animation_data.nla_tracks.new()
    tr.name = act.name
    st = tr.strips.new(act.name, 0, act)
    if slot_of[act.name] is not None and hasattr(st, 'action_slot'):
        try:
            st.action_slot = slot_of[act.name]
        except Exception as ex:  # noqa: BLE001
            print('SLOT_WARN', ex)
LAST_Q.clear()
apply_pose(pose('idle', 0.0))

out = os.path.join(PROJECT, 'public', 'assets', 'models', 'fp_rig.glb')
want = dict(filepath=out, export_format='GLB', use_selection=False, export_yup=True, export_apply=False,
            export_skins=True, export_animations=True, export_animation_mode='NLA_TRACKS', export_force_sampling=True,
            export_def_bones=False, export_optimize_animation_size=False, export_frame_range=False,
            export_materials='EXPORT', export_cameras=False, export_lights=False, export_extras=False)
props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
kw = {k: v for k, v in want.items() if k in props}
print('EXPORT_SKIPPED_ARGS', sorted(set(want) - set(kw)))
for o in bpy.context.scene.objects:
    o.select_set(o in (arm, mesh_ob))
cam.hide_viewport = True
bpy.ops.export_scene.gltf(**kw)
print('EXPORTED', out, os.path.getsize(out))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(PROJECT, 'assets_src', 'fp_rig.blend'))
print('BUILD_DONE')
