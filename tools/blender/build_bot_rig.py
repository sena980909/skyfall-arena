# 적 봇(레이븐형 장갑 병사) 리그 생성 → public/assets/models/bot_rig.glb
# 실행: blender -b --factory-startup --python tools/blender/build_bot_rig.py -- <abs_project_dir> [preview_only]
#
# 봇 공간(Blender): 원점 = 발 사이 바닥, +Y 정면, +X 오른쪽, +Z 위. 키 1.8m.
# 본 구조: hips → torso → (head, armsgun → muzzle), 다리(thigh/shin/foot.L/R)는 부모 없음(매 프레임 IK로 계산해 구움).
# - 팔과 라이플은 조준 자세 그대로 armsgun 본 하나에 묶었다. 게임은 torso를 돌려 상체를 조준 방향으로 틀고
#   armsgun을 어깨 축으로 돌려 상하 조준·로우레디를 만든다. 손이 총에서 떨어질 수 없다.
# - 이동 클립은 제자리(in-place)이고 접지한 발이 정확히 SPEED m/s로 뒤로 움직이게 만든다.
#   게임은 재생 속도 = 실제 이동 속도 / SPEED 로 맞춰 발이 미끄러지지 않는다.
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib_build as L  # noqa: E402
import arm_lib as A  # noqa: E402
import reload_timeline as TL  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else ['.']
PROJECT = os.path.abspath(argv[0])
PREVIEW = os.path.join(PROJECT, 'assets_src', '_preview')
os.makedirs(PREVIEW, exist_ok=True)
FPS = 30
# 'player' 인자를 주면 주인공 3인칭 리그(player_rig.glb)를 만든다: 같은 몸·보행에 팔 관절(상완·전완·손)과 총·탄창 본,
# 재장전 클립이 더해지고 색이 파란색이 된다. 인자가 없으면 적 봇(bot_rig.glb).
# 'fpref' = 1인칭용 팔·총만 정면·좌·후·우 직교 렌더(상세 디자인 이미지의 자세 기준), 'fp' = 그 상세 메시를 1인칭 모델로 내보내기
MODE = next((m for m in ('player', 'fpref', 'fp') if m in argv), 'bot')
ARMS_ONLY = MODE in ('fpref', 'fp')
OUT_NAME = 'player_rig' if MODE == 'player' else 'bot_rig'
PFX = 'player' if MODE == 'player' else 'bot'

# ---------------------------------------------------------------- 치수
HIP_X, HIP_Z = 0.105, 0.92
THIGH, SHIN, ANKLE_H = 0.43, 0.405, 0.085
HIPS_PIVOT = Vector((0, 0, 0.95))
TORSO_PIVOT = Vector((0, 0, 1.06))
NECK = Vector((0, 0, 1.57))
ARMS_PIVOT = Vector((0, 0, 1.44))
SHOULDER = {'L': Vector((-0.20, 0.10, 1.42)), 'R': Vector((0.235, 0.0, 1.43))}
ELBOW_HINT = {'L': Vector((-0.6, -0.1, -1.0)), 'R': Vector((0.8, -0.4, -0.8))}
L1, L2 = 0.31, 0.29
GUN_POS = Vector((0.15, 0.40, 1.41))
REST = {}

# ---------------------------------------------------------------- 재질 (게임이 이름으로 팀 색을 바꾼다)
L.reset_scene()
L.SEG_OVERRIDE = 1
bpy.context.scene.render.fps = FPS
M = {
    'suit': L.material('bot_suit', (0.03, 0.034, 0.045), rough=0.6, metal=0.2),
    'dark': L.material('bot_dark', (0.012, 0.013, 0.018), rough=0.7, metal=0.3),
    'armor': L.material('bot_armor', (0.85, 0.26, 0.06) if MODE == 'bot' else (0.018, 0.075, 0.5), rough=0.42, metal=0.25),
    'trim': L.material('bot_trim', (0.03, 0.2, 0.24), rough=0.4, metal=0.3),
    'glow': L.material('bot_glow', (0.6, 0.3, 0.05), rough=0.3, emit=(1.0, 0.5, 0.12), emit_strength=2.5),
    'visor': L.material('bot_visor', (0.8, 0.6, 0.2), rough=0.2, emit=(1.0, 0.82, 0.4), emit_strength=2.5),
}
# 라이플 패널·발광을 적 색으로 (fp_rifle이 이름으로 재질을 찾으므로 먼저 등록)
if MODE == 'bot':
    L.material('armor_blue', (0.5, 0.13, 0.04), rough=0.4, metal=0.3)
    L.material('glow_cyan', (0.6, 0.3, 0.05), rough=0.3, emit=(1.0, 0.5, 0.12), emit_strength=2.5)
import fp_rifle as R  # noqa: E402

D_GUN = Matrix.Translation(GUN_POS)


# ---------------------------------------------------------------- 모델링
def build_body():
    b = L.box
    # 골반
    b('pelvis', (0, 0, 0.96), (0.30, 0.19, 0.16), M['suit'], 'hips', bevel=0.03, segments=3)
    b('belt', (0, 0, 1.035), (0.32, 0.21, 0.05), M['dark'], 'hips', bevel=0.01)
    b('belt_buckle', (0, 0.105, 1.035), (0.07, 0.02, 0.04), M['glow'], 'hips', bevel=0.004)
    b('groin_plate', (0, 0.092, 0.93), (0.13, 0.04, 0.15), M['armor'], 'hips', bevel=0.012)
    for sx in (-1, 1):
        b(f'hip_plate{sx}', (sx * 0.168, 0, 0.94), (0.045, 0.17, 0.17), M['armor'], 'hips', bevel=0.012)
    # 몸통
    b('abdomen', (0, 0, 1.15), (0.27, 0.17, 0.2), M['suit'], 'torso', bevel=0.03, segments=3)
    for i in range(2):
        b(f'ab_plate{i}', (0, 0.082, 1.105 + i * 0.075), (0.16, 0.03, 0.06), M['dark'], 'torso', bevel=0.008)
    b('chest', (0, 0.0, 1.34), (0.39, 0.2, 0.26), M['suit'], 'torso', bevel=0.045, segments=3)
    L.prism('chest_plate', [(0.075, 1.24), (0.125, 1.29), (0.125, 1.41), (0.085, 1.46), (0.06, 1.46), (0.06, 1.24)], 0.25, M['armor'], 'torso', bevel=0.008)
    b('chest_core', (0, 0.127, 1.35), (0.07, 0.012, 0.07), M['glow'], 'torso', bevel=0.004)
    for sx in (-1, 1):
        b(f'chest_line{sx}', (sx * 0.085, 0.127, 1.39), (0.05, 0.01, 0.014), M['trim'], 'torso', bevel=0.002)
    b('backpack', (0, -0.135, 1.33), (0.25, 0.1, 0.27), M['dark'], 'torso', bevel=0.025)
    for sx in (-1, 1):
        b(f'pack_vent{sx}', (sx * 0.07, -0.188, 1.36), (0.05, 0.012, 0.12), M['glow'], 'torso', bevel=0.003)
    L.cyl('collar', (0, 0, 1.46), (0, 0, 1.575), 0.07, 0.06, M['suit'], 'torso', segments=12)
    b('collar_guard', (0, -0.035, 1.5), (0.2, 0.13, 0.07), M['armor'], 'torso', bevel=0.02)
    # 큰 견장
    for sx in (-1, 1):
        rot = Matrix.Rotation(-sx * math.radians(14), 3, 'Y')
        b(f'pauldron{sx}', (sx * 0.285, 0.0, 1.475), (0.18, 0.24, 0.13), M['armor'], 'torso', bevel=0.04, segments=3, rot=rot)
        b(f'pauldron_rim{sx}', (sx * 0.3, 0.0, 1.415), (0.17, 0.25, 0.03), M['dark'], 'torso', bevel=0.01, rot=rot)
        b(f'pauldron_line{sx}', (sx * 0.305, 0.0, 1.545), (0.06, 0.2, 0.012), M['trim'], 'torso', bevel=0.003, rot=rot)
    # 머리
    b('helmet', (0, 0.0, 1.69), (0.2, 0.235, 0.225), M['dark'], 'head', bevel=0.06, segments=3)
    L.prism('crest', [(-0.125, 1.775), (0.07, 1.812), (0.125, 1.75), (0.11, 1.735), (-0.12, 1.75)], 0.045, M['armor'], 'head', bevel=0.006)
    b('visor', (0, 0.108, 1.7), (0.165, 0.035, 0.06), M['visor'], 'head', bevel=0.012)
    b('brow', (0, 0.112, 1.745), (0.185, 0.04, 0.03), M['armor'], 'head', bevel=0.01)
    b('jaw', (0, 0.1, 1.625), (0.12, 0.06, 0.065), M['armor'], 'head', bevel=0.016)
    for sx in (-1, 1):
        L.cyl(f'ear{sx}', (sx * 0.095, -0.005, 1.685), (sx * 0.118, -0.005, 1.685), 0.04, 0.034, M['armor'], 'head', segments=10, bevel=0.004)
        b(f'cheek{sx}', (sx * 0.085, 0.075, 1.645), (0.035, 0.09, 0.07), M['dark'], 'head', bevel=0.01)


def build_leg(sfx, sx):
    g = lambda n: f'{n}.{sfx}'  # noqa: E731
    x = sx * HIP_X
    H = Vector((x, 0, HIP_Z))
    K = Vector((x, 0, HIP_Z - THIGH))
    Ak = Vector((x, 0, HIP_Z - THIGH - SHIN))
    REST[g('thigh')], REST[g('shin')], REST[g('foot')] = H, K, Ak
    L.sphere(g('hip_ball'), H, 0.085, M['suit'], g('thigh'))
    L.cyl(g('thigh_core'), H, K, 0.088, 0.068, M['suit'], g('thigh'), segments=12)
    L.box(g('thigh_plate'), (x + sx * 0.012, 0.058, 0.715), (0.125, 0.05, 0.27), M['armor'], g('thigh'), bevel=0.02)
    L.box(g('thigh_side'), (x + sx * 0.072, 0.0, 0.73), (0.03, 0.12, 0.2), M['dark'], g('thigh'), bevel=0.01)
    L.sphere(g('knee'), K, 0.07, M['suit'], g('shin'))
    L.box(g('knee_guard'), (x, 0.068, K.z + 0.005), (0.1, 0.055, 0.11), M['armor'], g('shin'), bevel=0.02)
    L.cyl(g('shin_core'), K, Ak, 0.068, 0.052, M['suit'], g('shin'), segments=12)
    L.box(g('shin_guard'), (x, 0.045, 0.3), (0.105, 0.06, 0.27), M['armor'], g('shin'), bevel=0.022)
    L.box(g('shin_line'), (x, 0.078, 0.3), (0.016, 0.008, 0.18), M['trim'], g('shin'), bevel=0.002)
    L.box(g('calf'), (x, -0.042, 0.33), (0.09, 0.06, 0.2), M['dark'], g('shin'), bevel=0.02)
    L.sphere(g('ankle'), Ak, 0.055, M['suit'], g('foot'))
    L.box(g('boot'), (x, 0.055, 0.045), (0.108, 0.27, 0.09), M['dark'], g('foot'), bevel=0.025, segments=3)
    L.box(g('toe_cap'), (x, 0.155, 0.052), (0.114, 0.085, 0.082), M['armor'], g('foot'), bevel=0.02)
    L.box(g('heel'), (x, -0.07, 0.05), (0.1, 0.05, 0.1), M['armor'], g('foot'), bevel=0.015)


ARM_LAYOUT = {}      # sfx → 팔 레스트 배치(arm_rest)
ARM_SOLVE_REST = {}  # 팔 본 → 레스트(총을 든) 자세의 solve 변환
GRIP = {}            # sfx → (손 프레임(총 로컬), 손가락 굽힘, 엄지)
ARM_PARTS = [f'{p}.{s}' for s in 'LR' for p in ('upper', 'fore', 'hand')]


def arm_group(b):
    """주인공: 팔 파트를 상완·전완·손 본으로 나눈다(손가락은 손에 묶음). 봇: 전부 armsgun."""
    if MODE == 'bot':
        return 'armsgun'
    part, sfx = b.split('.')
    return f"{part if part in ('upper', 'fore') else 'hand'}.{sfx}"


def build_arms_and_gun():
    gun_bone = 'armsgun' if MODE == 'bot' else 'gun'
    R.build_rifle(D_GUN, gun=gun_bone, mag=gun_bone)
    arm_mats = {'suit': M['suit'], 'glove': M['dark'], 'armor': M['armor'], 'trim': M['trim'], 'glow': M['glow']}
    grip_r = A.hand_frame(R.GRIP_CENTER + Vector((0.036, -0.012, 0.012)), (0.0, 1.0, -0.12), (1.0, 0.0, 0.0))
    hold = Vector((0.0, (430 - 285) * R.S, (140 - 214) * R.S))
    grip_l = A.hand_frame(hold + Vector((-0.004, 0.0, -0.02)), (0.86, 0.48, 0.16), (0.0, 0.0, -1.0))
    curl_r = {'index': [0.35, 0.95, 0.5], 'middle': [1.3, 1.45, 0.8], 'ring': [1.35, 1.45, 0.8], 'pinky': [1.4, 1.45, 0.8]}
    for sfx, fr, curls, thumb in (('R', grip_r, curl_r, (1.0, 0.25, 0.35, 0.3)), ('L', grip_l, [1.15, 1.0, 0.55], (0.9, 0.5, 0.3, 0.2))):
        rest = A.arm_rest(sfx, (0.6 if sfx == 'R' else -0.6, -0.3, 0.3), L1, L2)
        X = A.solve_arm(sfx, rest, SHOULDER[sfx], ELBOW_HINT[sfx], L1, L2, A.xf_frame(D_GUN, fr), curls, thumb)
        ARM_LAYOUT[sfx] = rest
        GRIP[sfx] = (fr, curls, thumb)
        ARM_SOLVE_REST.update(X)
        reach = (A.xf_frame(D_GUN, fr)[0] - SHOULDER[sfx]).length
        print(f'ARM_REACH {sfx} {reach:.3f} / {L1 + L2:.3f}')
        A.build_arm(sfx, rest, L1, L2, arm_mats, G=arm_group, XF=lambda b, X=X: X[b], thick=1.12, back=0.03)


if not ARMS_ONLY:
    build_body()
    build_leg('L', -1)
    build_leg('R', 1)
build_arms_and_gun()
EYE = Vector((0.0, 0.09, 1.69))  # 몸 모델의 눈 위치 (1인칭 모델의 원점)
if MODE == 'fpref':
    L.join_parts('FpRef')
    sc = bpy.context.scene
    cd = bpy.data.cameras.new('ortho')
    cd.type = 'ORTHO'
    cd.ortho_scale = 1.08
    cd.clip_start, cd.clip_end = 0.1, 30
    cam_o = bpy.data.objects.new('ortho', cd)
    sc.collection.objects.link(cam_o)
    sc.camera = cam_o
    wd = bpy.data.worlds.new('flat')
    wd.use_nodes = True
    wbg = next(n for n in wd.node_tree.nodes if n.type == 'BACKGROUND')
    wbg.inputs[0].default_value = (0.82, 0.82, 0.82, 1)
    sc.world = wd
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x = sc.render.resolution_y = 1024
    try:
        sc.view_settings.view_transform = 'Standard'
    except Exception:  # noqa: BLE001
        pass
    key = bpy.data.objects.new('key', bpy.data.lights.new('key', 'SUN'))
    key.data.energy = 2.5
    sc.collection.objects.link(key)
    center = Vector((0.03, 0.36, 1.33))
    for vname, d in (('front', Vector((0, 1, 0))), ('left', Vector((-1, 0, 0))), ('back', Vector((0, -1, 0))), ('right', Vector((1, 0, 0)))):
        cam_o.location = center + d * 8
        cam_o.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        key.rotation_euler = (-d + Vector((0.25, 0, -0.45))).normalized().to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = os.path.join(PROJECT, 'assets_src', 'reference', f'fp_arms_view_{vname}.png')
        bpy.ops.render.render(write_still=True)
        print('RENDERED', sc.render.filepath)
    sys.exit(0)
REST['hips'] = HIPS_PIVOT
REST['torso'] = TORSO_PIVOT
REST['head'] = NECK
REST['armsgun'] = ARMS_PIVOT
REST['muzzle'] = D_GUN @ R.MUZZLE
PARENT = {'torso': 'hips', 'head': 'torso', 'armsgun': 'torso', 'muzzle': 'armsgun'}
EXTRA = []  # 주인공 전용 본(armsgun의 자식): 보행 클립에서는 armsgun에 붙어 다니고 재장전 클립만 따로 움직인다
if MODE == 'player':
    REST['gun'] = D_GUN @ Vector((0, 0, 0))
    REST['mag'] = D_GUN @ R.MAG_CENTER
    for b in ARM_PARTS:
        REST[b] = ARM_SOLVE_REST[b] @ ARM_LAYOUT[b[-1]][b]
    EXTRA = ['gun', 'mag'] + ARM_PARTS
    PARENT.update({b: 'armsgun' for b in ARM_PARTS})
    PARENT.update({'gun': 'armsgun', 'mag': 'gun', 'muzzle': 'gun'})
mesh_ob = L.join_parts('BotMesh')
L.box_uv(mesh_ob, 0.45)
# 힉스필드 상세 메시가 있으면 겉모습을 그것으로 바꾼다(본·애니메이션은 그대로). 인자에 no_detail을 주면 절차 모델로 빌드
DETAIL = os.path.join(PROJECT, 'assets_src', 'higgs', 'fp_arms_detail.glb' if MODE == 'fp' else 'bot_detail.glb')
USE_DETAIL = os.path.exists(DETAIL) and 'no_detail' not in argv
if USE_DETAIL:
    import bot_detail as BD  # noqa: E402
    if MODE == 'player':
        PART = {'upper.L': 'UL', 'upper.R': 'UR', 'fore.L': 'LL', 'hand.L': 'LL', 'fore.R': 'RG', 'hand.R': 'RG', 'gun': 'RG'}
        JOINED = {frozenset(p) for p in (('BODY', 'UL'), ('BODY', 'UR'), ('UL', 'LL'), ('UR', 'RG'))}
        mesh_ob = BD.swap_in(mesh_ob, DETAIL, part_of=lambda b: PART.get(b, 'BODY'), joined=JOINED)
        BD.recolor_blue(mesh_ob)
    elif MODE == 'fp':
        # 팔·총만 따로 만든 상세 메시(파란색으로 생성)를 절차 팔·총에 정렬한다. 본은 쓰지 않는다(한 덩어리)
        mesh_ob = BD.swap_in(mesh_ob, DETAIL, tex_size=2048, aux_tex_size=1024, visor_material=None, align_mode='object')
        mesh_ob.vertex_groups.clear()
        mesh_ob.data.transform(Matrix.Translation(-EYE))
        mesh_ob.name = 'FPDetail'
        mz = bpy.data.objects.new('muzzle', None)
        bpy.context.scene.collection.objects.link(mz)
        mz.location = (D_GUN @ R.MUZZLE) - EYE
        fp_out = os.path.join(PROJECT, 'public', 'assets', 'models', 'fp_detail.glb')
        fp_want = dict(filepath=fp_out, export_format='GLB', use_selection=False, export_yup=True, export_apply=False, export_animations=False,
                       export_materials='EXPORT', export_cameras=False, export_lights=False, export_extras=False,
                       export_image_format='JPEG', export_image_quality=88, export_jpeg_quality=88)
        fp_props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
        bpy.ops.export_scene.gltf(**{k: v for k, v in fp_want.items() if k in fp_props})
        print('EXPORTED', fp_out, os.path.getsize(fp_out))
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(PROJECT, 'assets_src', 'fp_detail.blend'))
        print('BUILD_DONE')
        sys.exit(0)
    else:
        mesh_ob = BD.swap_in(mesh_ob, DETAIL)
    L.PARTS.clear()
    L.PARTS.append(mesh_ob)
if MODE == 'player':
    # 재장전 때 빠졌다 들어가는 탄창 소품. 평소에는 총의 탄창 안에 숨어 있다(상세 메시의 탄창은 총과 한 덩어리라 따로 못 뺀다)
    prop = L.box('mag_prop', D_GUN @ R.MAG_CENTER, (0.034, 0.10, 0.10), L.material('player_mag', (0.03, 0.035, 0.045), rough=0.5, metal=0.5), 'mag', bevel=0.006)
    mesh_ob = L.join_parts('BotMesh')
print('TRIS', sum(len(p.vertices) - 2 for p in mesh_ob.data.polygons), 'VERTS', len(mesh_ob.data.vertices), 'MATS', len(mesh_ob.data.materials))

arm_data = bpy.data.armatures.new('BotRig')
arm = bpy.data.objects.new('BotRig', arm_data)
bpy.context.scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
for name, head in REST.items():
    eb = arm_data.edit_bones.new(name)
    eb.head = head
    eb.tail = head + Vector((0, 0.05, 0))
    eb.roll = 0.0
    eb.use_deform = name != 'muzzle'
for child, parent in PARENT.items():
    arm_data.edit_bones[child].parent = arm_data.edit_bones[parent]
    arm_data.edit_bones[child].use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')
mesh_ob.parent = arm
mesh_ob.modifiers.new('Armature', 'ARMATURE').object = arm
REST_M = {b.name: b.matrix_local.copy() for b in arm_data.bones}
ORDER = (['hips', 'torso', 'head', 'armsgun'] + [b for b in EXTRA if b != 'mag'] + ['muzzle'] + [b for b in EXTRA if b == 'mag']
         + [f'{n}.{s}' for s in 'LR' for n in ('thigh', 'shin', 'foot')])
for pb in arm.pose.bones:
    pb.rotation_mode = 'QUATERNION'
LAST_Q = {}


def apply_pose(X, key_frame=None, only=None):
    pose_m = {n: X[n] @ REST_M[n] for n in ORDER}
    for n in ORDER:
        pb = arm.pose.bones[n]
        p = PARENT.get(n)
        if p:
            basis = (REST_M[p].inverted() @ REST_M[n]).inverted() @ (pose_m[p].inverted() @ pose_m[n])
        else:
            basis = REST_M[n].inverted() @ pose_m[n]
        loc, rot, _ = basis.decompose()
        prev = LAST_Q.get(n)
        if prev is not None and rot.dot(prev) < 0:
            rot.negate()
        LAST_Q[n] = rot.copy()
        pb.location = loc
        pb.rotation_quaternion = rot
        if key_frame is not None and (only is None or n in only):
            pb.keyframe_insert('location', frame=key_frame)
            pb.keyframe_insert('rotation_quaternion', frame=key_frame)


# ---------------------------------------------------------------- 보행 생성
def frames(T):
    return max(2, round(T * FPS))


GAITS = {
    # speed m/s, 주기 프레임 수, 접지 비율, 발 들기, 앞기울기(rad), 방향, 골반 좌우 흔들림, 골반 요, 뒤꿈치 닿기/발끝 떼기 각, 발 간격, 접지 중심 이동
    'walk': dict(v=1.6, n=26, beta=0.60, lift=0.07, lean=0.04, dir=1, sway=0.022, yaw=0.09, hs=0.28, to=0.55, fx=0.10, ys=0.0, crouch=0.02),
    'jog': dict(v=2.8, n=20, beta=0.44, lift=0.13, lean=0.10, dir=1, sway=0.016, yaw=0.11, hs=0.2, to=0.75, fx=0.085, ys=-0.02, crouch=0.035),
    'run': dict(v=4.7, n=17, beta=0.32, lift=0.2, lean=0.19, dir=1, sway=0.012, yaw=0.13, hs=0.1, to=0.95, fx=0.07, ys=-0.05, crouch=0.045),
    'back': dict(v=3.2, n=19, beta=0.46, lift=0.1, lean=-0.03, dir=-1, sway=0.016, yaw=0.08, hs=0.2, to=0.6, fx=0.10, ys=0.03, crouch=0.04),
}
for cfg in GAITS.values():
    cfg['T'] = cfg['n'] / FPS
    cfg['s'] = cfg['v'] * cfg['beta'] * cfg['T']
LEG_MAX = (THIGH + SHIN) * 0.985


def foot_target(cfg, t, off, sx):
    """(발목 위치, 발 피치)"""
    T, beta, s, d = cfg['T'], cfg['beta'], cfg['s'], cfg['dir']
    ph = (t / T + off) % 1.0
    if ph < beta:
        u = ph / beta
        y = s / 2 - s * u
        if u < 0.15:
            pitch = cfg['hs'] * (1 - u / 0.15)
        elif u > 0.72:
            k = (u - 0.72) / 0.28
            pitch = -cfg['to'] * k * k
        else:
            pitch = 0.0
        z = 0.13 * math.sin(max(0.0, -pitch))
    else:
        w = (ph - beta) / (1 - beta)
        e = 0.5 - 0.5 * math.cos(math.pi * w)
        y = -s / 2 + s * e
        z = cfg['lift'] * math.sin(math.pi * w) + 0.13 * math.sin(cfg['to']) * (1 - w) ** 2
        pitch = -cfg['to'] * (1 - w) ** 2 + cfg['hs'] * w * w
    if d < 0:
        pitch *= -0.5
        z *= 0.6
    return Vector((sx * cfg['fx'], d * y + cfg['ys'], ANKLE_H + z)), pitch


def hip_heights(cfg):
    n = cfg['n']
    raw = []
    for i in range(n):
        t = i / FPS
        h = HIP_Z - cfg['crouch']
        for off, sx in ((0.0, -1), (0.5, 1)):
            a, _ = foot_target(cfg, t, off, sx)
            reach = math.sqrt(max(1e-4, LEG_MAX ** 2 - a.y ** 2 - (abs(a.x) - HIP_X) ** 2))
            h = min(h, a.z + reach)
        raw.append(h)
    for _ in range(2):  # 원형 평활화
        raw = [(raw[(i - 1) % n] + 2 * raw[i] + raw[(i + 1) % n]) / 4 for i in range(n)]
    return raw


for cfg in GAITS.values():
    cfg['H'] = hip_heights(cfg)
    print('GAIT v=%.2f T=%.3f stride=%.3f hip %.3f..%.3f' % (cfg['v'], cfg['T'], cfg['s'], min(cfg['H']), max(cfg['H'])))


def frame_xf(rest_o, rest_d, rest_u, new_o, new_d, new_u):
    def F(d, u):
        d = Vector(d).normalized()
        u = A.orth(u, d)
        return L.basis(d.cross(u), d, u)
    return Matrix.Translation(new_o) @ F(new_d, new_u) @ F(rest_d, rest_u).inverted() @ Matrix.Translation(-Vector(rest_o))


def solve_leg(sfx, sx, Hj, target, pitch, X):
    g = lambda n: f'{n}.{sfx}'  # noqa: E731
    d = target - Hj
    dist = min(d.length, THIGH + SHIN - 0.004)
    n = d.normalized()
    a = (THIGH * THIGH - SHIN * SHIN + dist * dist) / (2 * dist)
    h = math.sqrt(max(THIGH * THIGH - a * a, 1e-8))
    e = A.orth(Vector((sx * 0.12, 1.0, 0.0)), n)
    K = Hj + n * a + e * h
    Ac = Hj + n * dist
    X[g('thigh')] = frame_xf(REST[g('thigh')], (0, 0, -1), (0, 1, 0), Hj, K - Hj, e)
    X[g('shin')] = frame_xf(REST[g('shin')], (0, 0, -1), (0, 1, 0), K, Ac - K, e)
    X[g('foot')] = Matrix.Translation(Ac) @ Matrix.Rotation(pitch, 4, 'X') @ Matrix.Translation(-REST[g('foot')])


def pose(clip, t):
    X = {}
    if clip == 'idle':
        br = math.sin(t / 3.0 * math.tau)
        hipsX = Matrix.Translation((0.0, 0.0, -0.03 + 0.004 * br)) @ L.rot_about(HIPS_PIVOT, (1, 0, 0), -0.03)
        feet = {'L': (Vector((-0.125, 0.06, ANKLE_H)), 0.0), 'R': (Vector((0.125, -0.06, ANKLE_H)), 0.0)}
        lean, hyaw, bob = 0.03, -0.06, 0.003 * br
    else:
        cfg = GAITS[clip]
        T = cfg['T']
        fi = (t * FPS) % cfg['n']
        i0 = int(fi) % cfg['n']
        k = fi - int(fi)
        H = cfg['H'][i0] * (1 - k) + cfg['H'][(i0 + 1) % cfg['n']] * k
        w = t / T * math.tau
        # 왼발(off 0) 접지 중간에 골반이 왼쪽(-X)으로
        mid = cfg['beta'] / 2 * math.tau
        sway = -cfg['sway'] * math.cos(w - mid)
        hyaw = cfg['yaw'] * math.sin(w - mid) * cfg['dir']
        lean = cfg['lean']
        hipsX = (Matrix.Translation((sway, 0.0, H - HIP_Z)) @ L.rot_about(HIPS_PIVOT, (0, 0, 1), hyaw)
                 @ L.rot_about(HIPS_PIVOT, (1, 0, 0), -lean))
        feet = {'L': foot_target(cfg, t, 0.0, -1), 'R': foot_target(cfg, t, 0.5, 1)}
        bob = 0.006 * math.sin(2 * w)
    X['hips'] = hipsX
    # 상체는 골반 요를 상쇄하고 기울기를 일부만 따라간다. 팔·총·머리는 나머지 기울기도 상쇄해 수평 유지
    torsoX = hipsX @ L.rot_about(TORSO_PIVOT, (0, 0, 1), -hyaw) @ L.rot_about(TORSO_PIVOT, (1, 0, 0), lean * 0.4)
    X['torso'] = torsoX
    rest_lean = lean * 0.6
    X['head'] = torsoX @ L.rot_about(NECK, (1, 0, 0), rest_lean * 0.85)
    X['armsgun'] = torsoX @ Matrix.Translation((0, 0, bob)) @ L.rot_about(ARMS_PIVOT, (1, 0, 0), rest_lean)
    X['muzzle'] = X['armsgun']
    for b in EXTRA:
        X[b] = X['armsgun']
    for sfx, sx in (('L', -1), ('R', 1)):
        Hj = hipsX @ Vector((sx * HIP_X, 0, HIP_Z))
        tgt, pitch = feet[sfx]
        solve_leg(sfx, sx, Hj, tgt, pitch, X)
    return X


# ---------------------------------------------------------------- 재장전 (주인공)
POUCH = Vector((-0.15, 0.10, 1.02))  # 왼쪽 골반 앞 탄창 주머니
HOLD_MAG = A.hand_frame(R.MAG_BOTTOM + Vector((-0.004, 0.0, -0.02)), (0.9, 0.3, 0.12), (0.0, 0.0, -1.0))
AWAY_L = A.hand_frame(POUCH + Vector((0.0, 0.03, 0.04)), (0.15, 0.25, -0.95), (-0.9, 0.3, 0.0))


def reload_gun(c):
    """기울임 c(0..1)일 때의 총 행렬. 회전량은 1인칭과 같고(요 0.3·피치 0.5·롤 0.75), 이동은 몸 앞 공간에 맞춰 줄였다."""
    return (Matrix.Translation(GUN_POS + Vector((-0.08, -0.03, 0.10)) * c) @ Matrix.Rotation(0.3 * c, 4, 'Z')
            @ Matrix.Rotation(0.5 * c, 4, 'X') @ Matrix.Rotation(0.75 * c, 4, 'Y'))


def pose_reload(t):
    """몸은 idle 첫 프레임에 두고 총·탄창·양팔만 움직인다. 구간은 1인칭과 같은 시간표(reload_timeline)."""
    X = pose('idle', 0.0)
    Xa = X['armsgun']
    D = reload_gun(TL.cant(t))
    D1 = reload_gun(1.0)
    # 빈 탄창은 아래로 떨어지고, 새 탄창은 주머니에서 출발한다 (총 로컬 좌표로 환산)
    out_end = tuple(D1.to_3x3().inverted() @ Vector((0.0, 0.0, -1.05)))
    in_start = tuple((D1.inverted() @ POUCH) - R.MAG_CENTER)
    Dm = D @ Matrix.Translation(TL.mag_offset(t, out_end, in_start))
    wA, wM, wAway = TL.hand_weights(t)
    frL, curlL0, thumbL0 = GRIP['L']
    frR, curlR, thumbR = GRIP['R']
    fr = A.blend_frames([A.xf_frame(D, frL), A.xf_frame(Dm, HOLD_MAG), AWAY_L], [wA, wM, wAway])
    curl = A.mix_curls([curlL0, [0.9, 0.9, 0.5], [0.35, 0.4, 0.3]], [wA, wM, wAway])
    thumb = tuple(a * wA + b * (wM + wAway) for a, b in zip(thumbL0, (0.4, 0.2, 0.2, 0.1)))
    XL = A.solve_arm('L', ARM_LAYOUT['L'], SHOULDER['L'], ELBOW_HINT['L'], L1, L2, fr, curl, thumb)
    XR = A.solve_arm('R', ARM_LAYOUT['R'], SHOULDER['R'], ELBOW_HINT['R'], L1, L2, A.xf_frame(D, frR), curlR, thumbR)
    for b in ARM_PARTS:
        X[b] = Xa @ (XL if b.endswith('L') else XR)[b] @ ARM_SOLVE_REST[b].inverted()
    X['gun'] = Xa @ D @ D_GUN.inverted()
    X['muzzle'] = X['gun']
    X['mag'] = Xa @ Dm @ D_GUN.inverted()
    return X


def pose_any(clip, t):
    return pose_reload(t) if clip == 'reload' else pose(clip, t)


# ---------------------------------------------------------------- 미리보기
cam = L.setup_preview(res=(900, 900), fov_deg=32)


def shot(name, clip, t, loc, look=(0, 0, 0.95)):
    LAST_Q.clear()
    apply_pose(pose_any(clip, t))
    bpy.context.view_layer.update()
    L.render(os.path.join(PREVIEW, name + '.png'), loc=loc, look_at=look, fov_deg=32)


shot(f'{PFX}_idle_front', 'idle', 0.0, (1.6, 3.2, 1.5))
shot(f'{PFX}_idle_side', 'idle', 0.0, (3.8, 0.2, 1.1))
shot(f'{PFX}_idle_back', 'idle', 0.0, (-1.8, -3.0, 1.6))
if MODE == 'player':
    for tt in (0.25, 0.42, 0.62, 0.9, 1.15):
        shot(f'player_reload_{int(tt * 100):03d}', 'reload', tt, (-1.5, 2.6, 1.55), look=(0, 0.1, 1.25))
        shot(f'player_reload_back_{int(tt * 100):03d}', 'reload', tt, (0.7, -2.2, 1.9), look=(0, 0.3, 1.3))
for clip in ('walk', 'run', 'back'):
    T = GAITS[clip]['T']
    for q in (0, 1):
        shot(f'{PFX}_{clip}_{q}', clip, T * q / 4, (3.8, 0.2, 1.0))
shot(f'{PFX}_run_front', 'run', GAITS['run']['T'] * 0.1, (1.6, 3.2, 1.3))
if 'preview_only' in argv:
    print('PREVIEW_ONLY_DONE')
    sys.exit(0)

# ---------------------------------------------------------------- 클립 굽기 + 내보내기
arm.animation_data_create()


def bake(clip, n, only=None):
    LAST_Q.clear()
    act = bpy.data.actions.new(clip)
    arm.animation_data.action = act
    for fi in range(n + 1):
        apply_pose(pose_any(clip, fi / FPS), key_frame=fi, only=only)
    return act


# 주인공: 보행 클립은 몸 본만, 재장전 클립은 팔·총·탄창 본만 키를 찍는다 → 게임에서 보행 위에 재장전을 겹쳐 재생할 수 있다
BODY = None if MODE != 'player' else set(ORDER) - set(EXTRA)
acts = [bake('idle', 90, BODY)] + [bake(name, cfg['n'], BODY) for name, cfg in GAITS.items()]
if MODE == 'player':
    acts.append(bake('reload', round(TL.RELOAD_LEN * FPS), set(EXTRA)))
slot_of = {a.name: (a.slots[0] if getattr(a, 'slots', None) else None) for a in acts}
arm.animation_data.action = None
for act in acts:
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

out = os.path.join(PROJECT, 'public', 'assets', 'models', OUT_NAME + '.glb')
want = dict(filepath=out, export_format='GLB', use_selection=False, export_yup=True, export_apply=False,
            export_skins=True, export_animations=True, export_animation_mode='NLA_TRACKS', export_force_sampling=True,
            export_def_bones=False, export_optimize_animation_size=False, export_frame_range=False,
            export_materials='EXPORT', export_cameras=False, export_lights=False, export_extras=False,
            export_image_format='JPEG', export_image_quality=86, export_jpeg_quality=86)
props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in props})
print('EXPORTED', out, os.path.getsize(out))
print('CLIP_SPEEDS', {k: v['v'] for k, v in GAITS.items()})
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(PROJECT, 'assets_src', OUT_NAME + '.blend'))
print('BUILD_DONE')
