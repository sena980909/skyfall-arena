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
OUT_NAME = {'player': 'player_rig', 'fp': 'fp_detail'}.get(MODE, 'bot_rig')
PFX = {'player': 'player', 'fp': 'fp'}.get(MODE, 'bot')

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
GUN_MARK = 'GUNPART'


def arm_group(b):
    """주인공: 팔 파트를 상완·전완·손 본으로 나눈다(손가락은 손에 묶음). 봇: 전부 armsgun."""
    if MODE == 'bot':
        return 'armsgun'
    part, sfx = b.split('.')
    # 1인칭: 오른팔은 총과 한 덩어리로 움직인다. 전완이 총 뒷부분과 붙어 있어 따로 움직이면 총 뒤쪽 면이 팔꿈치에 남는다
    if MODE == 'fp' and sfx == 'R' and part != 'upper':
        return 'gun'
    return f"{part if part in ('upper', 'fore') else 'hand'}.{sfx}"


def build_arms_and_gun():
    gun_bone = 'armsgun' if MODE == 'bot' else 'gun'
    n_before = len(L.PARTS)
    R.build_rifle(D_GUN, gun=gun_bone, mag=gun_bone)
    # Mark the rifle's parts (weight below the bone weights, so it never counts as a bone): the detail swap uses the
    # mark to tell the rifle from the right arm, which shares the 'gun' bone in first person.
    for ob in L.PARTS[n_before:]:
        ob.vertex_groups.new(name=GUN_MARK).add(range(len(ob.data.vertices)), 0.5, 'REPLACE')
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
if ARMS_ONLY:
    # 1인칭: 몸 본 없이 armsgun(고정) 아래에 팔·총·탄창만 둔다
    REST['armsgun'] = ARMS_PIVOT
    REST['muzzle'] = D_GUN @ R.MUZZLE
    PARENT = {'muzzle': 'armsgun'}
else:
    REST['hips'] = HIPS_PIVOT
    REST['torso'] = TORSO_PIVOT
    REST['head'] = NECK
    REST['armsgun'] = ARMS_PIVOT
    REST['muzzle'] = D_GUN @ R.MUZZLE
    PARENT = {'torso': 'hips', 'head': 'torso', 'armsgun': 'torso', 'muzzle': 'armsgun'}
EXTRA = []  # 주인공 전용 본(armsgun의 자식): 보행 클립에서는 armsgun에 붙어 다니고 재장전 클립만 따로 움직인다
if MODE in ('player', 'fp'):
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
GUN_DETAIL = os.path.join(PROJECT, 'assets_src', 'higgs', 'rifle_detail.glb')
USE_GUN = MODE == 'fp' and USE_DETAIL and os.path.exists(GUN_DETAIL) and 'no_gun' not in argv
GUN_OB = None
if USE_DETAIL:
    import bot_detail as BD  # noqa: E402
    if MODE == 'player':
        PART = {'upper.L': 'UL', 'upper.R': 'UR', 'fore.L': 'LL', 'hand.L': 'LL', 'fore.R': 'RG', 'hand.R': 'RG', 'gun': 'RG'}
        # Arms are cut free from the body as well: the left arm lies across the chest and is fused to it in the generated
        # mesh, so any shared surface stretches into a sheet when the arm moves. The pauldrons (body) cover the shoulder gap.
        JOINED = {frozenset(p) for p in (('UL', 'LL'), ('UR', 'RG'))}
        mesh_ob = BD.swap_in(mesh_ob, DETAIL, part_of=lambda b: PART.get(b, 'BODY'), joined=JOINED, weld=True)
        BD.recolor_blue(mesh_ob)
    elif MODE == 'fp':
        # 팔·총만 따로 만든 상세 메시(파란색으로 생성)를 절차 팔·총에 정렬한다.
        # 상완은 버리고(화면 귀퉁이에 보인다), 왼팔(전완+손)은 총에서 잘라 따로 움직이게 한다. 오른팔은 총과 한 덩어리(gun 본)로 둔다
        FP_PART = {'upper.L': 'DROP', 'upper.R': 'DROP', 'fore.L': 'LL', 'hand.L': 'LL'}
        mesh_ob = BD.swap_in(mesh_ob, DETAIL, tex_size=2048, aux_tex_size=1024, visor_material=None, align_mode='object',
                             part_of=lambda b: FP_PART.get(b, 'RG'), joined=set(), keep_parts={'LL', 'RG'}, weld=True,
                             plane_cuts={'upper.L': 'fore.L', 'upper.R': 'gun'},
                             strip=GUN_MARK if USE_GUN else None)
        if USE_GUN:
            # The rifle generated on its own (one clean rear three-quarter picture, 150k faces) replaces the rifle part of
            # the arms-and-rifle mesh: fused with the arms it came out lumpy, worst from the shooter's side.
            GUN_OB = BD.fit_prop(GUN_DETAIL, 'gun_prop', 'gun', BD.swap_in.stripped, tex_size=2048, max_tris=55000, thin_end=D_GUN @ R.MUZZLE, drop=0.012,
                                 uv_name=mesh_ob.data.uv_layers[0].name if mesh_ob.data.uv_layers else None)
    else:
        mesh_ob = BD.swap_in(mesh_ob, DETAIL)
    L.PARTS.clear()
    L.PARTS.append(mesh_ob)
    if GUN_OB is not None:
        L.PARTS.append(GUN_OB)
if MODE in ('player', 'fp'):
    # 재장전 때 빠졌다 들어가는 탄창. 평소에는 총의 탄창 안에 숨어 있다(상세 메시의 탄창은 총과 한 덩어리라 따로 못 뺀다)
    MAG_DETAIL = os.path.join(PROJECT, 'assets_src', 'higgs', 'mag_detail.glb')
    if MODE == 'fp' and USE_DETAIL and os.path.exists(MAG_DETAIL):
        # 1인칭: 총과 같은 방식으로 만든 상세 메시(총 그림을 참고로 그린 탄창 → 이미지→3D). 단순한 상자는 총 옆에서 따로 놀았다.
        # 생성 메시의 축은 리그와 같다(X 두께, Y 길이, Z 높이, 바닥판이 -Z). 3인칭은 화면에서 몇 픽셀이라 상자 그대로 둔다
        L.PARTS.append(BD.import_prop(MAG_DETAIL, 'mag_prop', 'mag', D_GUN @ R.MAG_CENTER, (0.036, 0.105, 0.10), Matrix.Identity(3),
                                      uv_name=mesh_ob.data.uv_layers[0].name if mesh_ob.data.uv_layers else None))
    else:
        L.box('mag_prop', D_GUN @ R.MAG_CENTER, (0.034, 0.10, 0.10), L.material('player_mag', (0.03, 0.035, 0.045), rough=0.5, metal=0.5), 'mag', bevel=0.006)
        L.box('mag_prop_glow', D_GUN @ (R.MAG_CENTER + Vector((0, 0, -0.01))), (0.036, 0.07, 0.012), L.material('player_mag_glow', (0.05, 0.3, 0.4), rough=0.3, emit=(0.2, 0.85, 1.0), emit_strength=2.0), 'mag', bevel=0.002)
    mesh_ob = L.join_parts('BotMesh')
if GUN_MARK in mesh_ob.vertex_groups:
    mesh_ob.vertex_groups.remove(mesh_ob.vertex_groups[GUN_MARK])
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
ORDER = ((['armsgun'] if ARMS_ONLY else ['hips', 'torso', 'head', 'armsgun'])
         + [b for b in EXTRA if b != 'mag'] + ['muzzle'] + [b for b in EXTRA if b == 'mag']
         + ([] if ARMS_ONLY else [f'{n}.{s}' for s in 'LR' for n in ('thigh', 'shin', 'foot')]))
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


# 앉았을 때 골반이 내려가는 높이(m). 머리 꼭대기가 1.8 → 1.29(게임 배율 0.95를 곱하면 1.23)로 내려와 1.25m 충돌 상자에 들어간다
CROUCH_DROP = 0.48
GAITS = {
    # speed m/s, 주기 프레임 수, 접지 비율, 발 들기, 앞기울기(rad), 방향, 골반 좌우 흔들림, 골반 요, 뒤꿈치 닿기/발끝 떼기 각, 발 간격, 접지 중심 이동
    'walk': dict(v=1.6, n=18, beta=0.60, lift=0.07, lean=0.04, dir=1, sway=0.022, yaw=0.09, hs=0.28, to=0.55, fx=0.10, ys=0.0, crouch=0.02),
    'jog': dict(v=2.8, n=18, beta=0.44, lift=0.13, lean=0.10, dir=1, sway=0.016, yaw=0.11, hs=0.2, to=0.75, fx=0.085, ys=-0.02, crouch=0.035),
    'run': dict(v=4.7, n=17, beta=0.32, lift=0.2, lean=0.19, dir=1, sway=0.012, yaw=0.13, hs=0.1, to=0.95, fx=0.07, ys=-0.05, crouch=0.045),
    'back': dict(v=3.2, n=15, beta=0.46, lift=0.1, lean=-0.03, dir=-1, sway=0.016, yaw=0.08, hs=0.2, to=0.6, fx=0.10, ys=0.03, crouch=0.04),
}
if MODE == 'player':
    # 주인공은 봇보다 빠르다(기본 5.5, 질주 8.25, 뒷걸음도 5.5m/s). 봇 클립을 빨리 감으면 다리만 바쁘게 돌아서 전용 걸음을 만든다
    GAITS['run'].update(v=5.5, n=16, beta=0.30)
    GAITS['back'].update(v=5.5, n=13, beta=0.36, lift=0.12)
    GAITS['sprint'] = dict(v=8.25, n=13, beta=0.25, lift=0.24, lean=0.26, dir=1, sway=0.010, yaw=0.14, hs=0.05, to=1.05, fx=0.065, ys=-0.07, crouch=0.05)
    # 앉아 걷기(2.75m/s = 기본 속도의 절반): 골반을 CROUCH_DROP만큼 낮추고 허리를 숙인다. 게임의 CROUCH_SPEED_MULT와 맞아야 한다
    GAITS['crouchWalk'] = dict(v=2.75, n=12, beta=0.50, lift=0.07, lean=0.42, dir=1, sway=0.02, yaw=0.07, hs=0.12, to=0.35, fx=0.12, ys=0.04, crouch=CROUCH_DROP)
    GAITS['crouchBack'] = dict(v=2.75, n=12, beta=0.50, lift=0.06, lean=0.36, dir=-1, sway=0.018, yaw=0.06, hs=0.12, to=0.3, fx=0.12, ys=0.06, crouch=CROUCH_DROP)
# 옆걸음: 몸은 정면(+Y)을 본 채 발이 좌우(X)로 디딘다. side = +1 오른쪽(+X), -1 왼쪽으로 이동.
# 보폭이 발 간격보다 커서 두 발이 엇갈리므로, 한 발은 앞줄·한 발은 뒷줄로 디뎌 다리가 서로 뚫지 않게 한다.
# 느린 것(2.8m/s, 봇의 교전 옆걸음)과 빠른 것(5.5m/s, 주인공 기본 속도) 두 가지를 좌우로 만든다.
STRAFE = dict(lean=0.0, dir=1, sway=0.0, yaw=0.0, hs=0.0, to=0.0, fx=0.13, ys=0.0)
for _nm, _side in (('L', -1), ('R', 1)):
    GAITS['strafe' + _nm] = dict(STRAFE, v=2.8, n=12, beta=0.42, lift=0.09, crouch=0.03, side=_side)
    GAITS['strafeFast' + _nm] = dict(STRAFE, v=5.5, n=10, beta=0.30, lift=0.13, crouch=0.04, side=_side)
    if MODE == 'player':
        GAITS['crouchStrafe' + _nm] = dict(STRAFE, v=2.75, n=10, beta=0.46, lift=0.06, crouch=CROUCH_DROP, side=_side, lean=0.36, fx=0.2)
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
    side = cfg.get('side', 0)
    if side:
        # 접지한 발은 몸이 가는 반대쪽으로 밀린다(전진 걸음의 y를 x로 옮긴 것). 발끝은 정면 그대로
        lane = -sx * side * 0.075
        return Vector((sx * cfg['fx'] + side * y, lane, ANKLE_H + z)), 0.0
    return Vector((sx * cfg['fx'], d * y + cfg['ys'], ANKLE_H + z)), pitch


def hip_heights(cfg):
    n = cfg['n']
    raw = []
    for i in range(n):
        t = i / FPS
        h = HIP_Z - cfg['crouch']
        for off, sx in ((0.0, -1), (0.5, 1)):
            a, _ = foot_target(cfg, t, off, sx)
            reach = math.sqrt(max(1e-4, LEG_MAX ** 2 - a.y ** 2 - (a.x - sx * HIP_X) ** 2))
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


def solve_leg(sfx, sx, Hj, target, pitch, X, hint=None, yaw=0.0):
    g = lambda n: f'{n}.{sfx}'  # noqa: E731
    d = target - Hj
    dist = min(d.length, THIGH + SHIN - 0.004)
    n = d.normalized()
    a = (THIGH * THIGH - SHIN * SHIN + dist * dist) / (2 * dist)
    h = math.sqrt(max(THIGH * THIGH - a * a, 1e-8))
    if hint is None:
        # 발끝이 돌아가면 무릎도 그쪽으로 절반쯤 따라간다
        hint = Matrix.Rotation(yaw * 0.6, 3, 'Z') @ Vector((sx * 0.12, 1.0, 0.0))
    e = A.orth(Vector(hint), n)
    K = Hj + n * a + e * h
    Ac = Hj + n * dist
    X[g('thigh')] = frame_xf(REST[g('thigh')], (0, 0, -1), (0, 1, 0), Hj, K - Hj, e)
    X[g('shin')] = frame_xf(REST[g('shin')], (0, 0, -1), (0, 1, 0), K, Ac - K, e)
    X[g('foot')] = (Matrix.Translation(Ac) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(pitch, 4, 'X')
                    @ Matrix.Translation(-REST[g('foot')]))


# 제자리 돌기: 몸(그룹)은 게임이 TURN_ANGLE·turn_progress(u)만큼 돌린다. 클립은 그 회전을 발에서 되돌려, 디딘 발이 바닥에 붙어 있게 한다.
# 도는 쪽 발을 먼저 떼어 새 자리에 놓고(앞 절반), 이어서 반대쪽 발을 옮긴다(뒤 절반). 처음과 끝 자세는 idle과 같다.
# 더 작은 각은 게임에서 idle과 섞어 쓴다(GaitDir.ts의 startTurnStep). turn_progress는 GaitDir.turnYawProgress와 같은 식이어야 한다.
TURN_N = 12
TURN_ANGLE = math.pi / 2
TURNS = {'turnL': 1, 'turnR': -1}
IDLE_FEET = {'L': Vector((-0.125, 0.06, ANKLE_H)), 'R': Vector((0.125, -0.06, ANKLE_H))}


def turn_progress(u):
    return TL.ramp(u, 0.06, 0.94)


def turn_feet(sg, u):
    s = turn_progress(u)
    first, second = ('L', 'R') if sg > 0 else ('R', 'L')
    win = {first: (0.03, 0.50), second: (0.50, 0.97)}
    feet = {}
    for sfx in 'LR':
        a0, a1 = win[sfx]
        k = TL.ramp(u, a0, a1)
        lin = min(1.0, max(0.0, (u - a0) / (a1 - a0)))
        ang = sg * TURN_ANGLE * (k - s)
        p0 = IDLE_FEET[sfx]
        pos = Matrix.Rotation(ang, 3, 'Z') @ Vector((p0.x, p0.y, 0.0))
        up = math.sin(math.pi * lin)
        feet[sfx] = (Vector((pos.x, pos.y, ANKLE_H + 0.07 * up)), -0.22 * up, ang)
    return feet


def pose(clip, t):
    if ARMS_ONLY:
        return {n: Matrix.Identity(4) for n in ORDER}
    X = {}
    if clip == 'idle':
        br = math.sin(t / 3.0 * math.tau)
        hipsX = Matrix.Translation((0.0, 0.0, -0.03 + 0.004 * br)) @ L.rot_about(HIPS_PIVOT, (1, 0, 0), -0.03)
        feet = {'L': (Vector((-0.125, 0.06, ANKLE_H)), 0.0), 'R': (Vector((0.125, -0.06, ANKLE_H)), 0.0)}
        lean, hyaw, bob, roll = 0.03, -0.06, 0.003 * br, 0.0
    elif clip == 'crouch':
        # 앉은 자세(무릎앉아): 왼발은 앞에 평평하게 딛고, 오른쪽 무릎을 바닥 가까이 내린 채 오른발은 뒤에서 발끝으로 딛는다
        br = math.sin(t / 3.0 * math.tau)
        hipsX = Matrix.Translation((0.0, -0.02, -CROUCH_DROP - 0.02 + 0.004 * br)) @ L.rot_about(HIPS_PIVOT, (1, 0, 0), -0.40)
        feet = {'L': (Vector((-0.14, 0.24, ANKLE_H)), 0.0), 'R': (Vector((0.14, -0.20, ANKLE_H + 0.09)), -0.85)}
        lean, hyaw, bob, roll = 0.40, -0.06, 0.003 * br, 0.0
    elif clip in TURNS:
        sg = TURNS[clip]
        u = min(1.0, max(0.0, t / (TURN_N / FPS)))
        # 골반은 디딘 발 쪽으로 살짝 옮기고, 발을 옮기는 동안 조금 낮춘다
        shift = 0.02 * sg * math.sin(math.tau * u)
        dip = 0.022 * math.sin(math.pi * u)
        hipsX = Matrix.Translation((shift, 0.0, -0.03 - dip)) @ L.rot_about(HIPS_PIVOT, (1, 0, 0), -0.03)
        feet = turn_feet(sg, u)
        lean, hyaw, bob, roll = 0.03, -0.06, 0.0, 0.0
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
        # 옆걸음은 가는 쪽으로 몸을 살짝 기울인다
        roll = cfg.get('side', 0) * 0.05
        hipsX = (Matrix.Translation((sway, 0.0, H - HIP_Z)) @ L.rot_about(HIPS_PIVOT, (0, 0, 1), hyaw)
                 @ L.rot_about(HIPS_PIVOT, (1, 0, 0), -lean) @ L.rot_about(HIPS_PIVOT, (0, 1, 0), roll))
        feet = {'L': foot_target(cfg, t, 0.0, -1), 'R': foot_target(cfg, t, 0.5, 1)}
        bob = 0.006 * math.sin(2 * w)
    X['hips'] = hipsX
    # 상체는 골반 요를 상쇄하고 기울기를 일부만 따라간다. 팔·총·머리는 나머지 기울기도 상쇄해 수평 유지
    torsoX = (hipsX @ L.rot_about(TORSO_PIVOT, (0, 0, 1), -hyaw) @ L.rot_about(TORSO_PIVOT, (1, 0, 0), lean * 0.4)
              @ L.rot_about(TORSO_PIVOT, (0, 1, 0), -roll * 0.7))
    X['torso'] = torsoX
    rest_lean = lean * 0.6
    X['head'] = torsoX @ L.rot_about(NECK, (1, 0, 0), rest_lean * 0.85)
    X['armsgun'] = torsoX @ Matrix.Translation((0, 0, bob)) @ L.rot_about(ARMS_PIVOT, (1, 0, 0), rest_lean)
    X['muzzle'] = X['armsgun']
    for b in EXTRA:
        X[b] = X['armsgun']
    for sfx, sx in (('L', -1), ('R', 1)):
        Hj = hipsX @ Vector((sx * HIP_X, 0, HIP_Z))
        ft = feet[sfx]
        solve_leg(sfx, sx, Hj, ft[0], ft[1], X, yaw=ft[2] if len(ft) > 2 else 0.0)
    return X


# ---------------------------------------------------------------- 재장전 (주인공)
POUCH = Vector((-0.15, 0.10, 1.02))  # 왼쪽 골반 앞 탄창 주머니
HOLD_MAG = A.hand_frame(R.MAG_BOTTOM + Vector((-0.004, 0.0, -0.02)), (0.9, 0.3, 0.12), (0.0, 0.0, -1.0))
AWAY_L = A.hand_frame(POUCH + Vector((0.0, 0.03, 0.04)), (0.15, 0.25, -0.95), (-0.9, 0.3, 0.0))


# 1인칭 재장전 때의 총 자세: (오른쪽, 앞, 위) 이동 m + (Z 왼쪽으로 돌림, X 총구 들기, Y 옆으로 눕힘) rad.
# 총을 높이 들면 조준점을 가린다(전에는 1.4초 중 1.05초 동안 화면 한가운데를 덮었다). 오른쪽 아래에 둔 채 66° 눕혀
# 탄창 구멍이 왼쪽 아래를 보게 하면, 빈 탄창이 빠지고 새 탄창이 들어오는 모습이 화면 아래쪽에서 보인다.
# 맞출 때는 환경 변수로 바꿔 가며 미리보기만 뽑는다: FP_RELOAD="dx,dy,dz,rz,rx,ry" PREVIEW_TAG=_a ... fp preview_only
FP_RELOAD = (0.06, 0.03, 0.075, 0.14, 0.16, 1.15)
if 'FP_RELOAD' in os.environ:
    FP_RELOAD = tuple(float(v) for v in os.environ['FP_RELOAD'].split(','))
PREVIEW_TAG = os.environ.get('PREVIEW_TAG', '')
# 총이 한 자세로 굳어 있지 않게 하는 작은 움직임(시작, 정점, 끝): 빈 탄창을 털어 내는 손목 꺾기, 새 탄창을 밀어 넣을 때 들썩임,
# 그 사이 왼손이 탄창을 가지러 간 동안 천천히 내려앉기
FP_FLICK = (0.10, 0.19, 0.36)
FP_SEAT = (0.89, 0.95, 1.10)
FP_SETTLE = (0.30, 0.86)


def reload_gun(c, t=None):
    """기울임 c(0..1)일 때의 총 행렬. 3인칭에서는 총을 가슴 앞에 둔 채 살짝 숙이고 옆으로 눕힌다(1인칭처럼 들어 올리면 얼굴을 가린다)."""
    if MODE == 'fp':
        # 1인칭: 윗면을 오른쪽으로 굴려 왼쪽 면과 탄창 구멍이 카메라를 향하게 한다. 수치와 이유는 FP_RELOAD 주석
        dx, dy, dz, rz, rx, ry = FP_RELOAD
        flick = seat = settle = 0.0
        if t is not None:
            settle = TL.ramp(t, *FP_SETTLE) * (1 - TL.ramp(t, *TL.CANT_OUT))
            flick = TL.ramp(t, *FP_FLICK[:2]) * (1 - TL.ramp(t, *FP_FLICK[1:]))
            seat = TL.ramp(t, *FP_SEAT[:2]) * (1 - TL.ramp(t, *FP_SEAT[1:]))
        return (Matrix.Translation(GUN_POS + Vector((dx, dy, dz)) * c + Vector((0, 0, -0.014 * flick + 0.016 * seat - 0.008 * settle)))
                @ Matrix.Rotation(rz * c, 4, 'Z') @ Matrix.Rotation(rx * c + 0.045 * seat, 4, 'X')
                @ Matrix.Rotation(ry * c + 0.10 * flick - 0.07 * settle, 4, 'Y'))
    return (Matrix.Translation(GUN_POS + Vector((-0.03, -0.03, -0.03)) * c) @ Matrix.Rotation(0.18 * c, 4, 'Z')
            @ Matrix.Rotation(-0.12 * c, 4, 'X') @ Matrix.Rotation(0.5 * c, 4, 'Y'))


def pose_reload(t):
    """몸은 idle 첫 프레임에 두고 총·탄창·양팔만 움직인다. 구간은 1인칭과 같은 시간표(reload_timeline)."""
    X = pose('idle', 0.0)
    Xa = X['armsgun']
    D = reload_gun(TL.cant(t), t)
    D1 = reload_gun(1.0)
    # 빈 탄창은 아래로 떨어지고, 새 탄창은 주머니에서 출발한다 (총 로컬 좌표로 환산)
    out_end = tuple(D1.to_3x3().inverted() @ Vector((0.0, 0.0, -1.05)))
    in_start = tuple((D1.inverted() @ POUCH) - R.MAG_CENTER)
    if MODE == 'fp':
        # 1인칭: 빈 탄창은 화면 아래로 빠지고 새 탄창은 화면 아래에서 올라온다(총 로컬)
        out_end, in_start = (0.0, -0.02, -0.42), (0.0, -0.08, -0.40)
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


DEATH_LEN = 26 / FPS


def pose_special(clip, t):
    """사망(무릎이 꺾이며 뒤로 쓰러져 눕는다)과 공중 자세(한 다리 앞, 한 다리 뒤). 발은 IK로 푼다."""
    X = {}
    if clip == 'air':
        hipsX = Matrix.Translation((0.0, 0.0, -0.02)) @ L.rot_about(HIPS_PIVOT, (1, 0, 0), -0.08)
        torsoX = hipsX @ L.rot_about(TORSO_PIVOT, (1, 0, 0), 0.04)
        headX = torsoX
        armsX = torsoX @ L.rot_about(ARMS_PIVOT, (1, 0, 0), 0.04)
        feet = {'L': (Vector((-0.11, 0.20, 0.30)), -0.25, None), 'R': (Vector((0.11, -0.17, 0.20)), -0.55, None)}
    else:
        u = min(1.0, t / DEATH_LEN)
        c = TL.ramp(u, 0.0, 0.35)             # 무릎이 꺾이고 팔이 풀린다
        f = TL.ramp(u, 0.12, 0.92) ** 1.5     # 뒤로 넘어간다(가속)
        th = f * (math.pi / 2 - 0.05)
        hipsX = (Matrix.Translation((0.0, -0.08 * c - 0.47 * f, -0.28 * c * (1 - f) - 0.75 * f))
                 @ L.rot_about(HIPS_PIVOT, (1, 0, 0), th))
        torsoX = hipsX @ L.rot_about(TORSO_PIVOT, (1, 0, 0), 0.3 * c * (1 - f))
        headX = torsoX @ L.rot_about(NECK, (1, 0, 0), 0.35 * c * (1 - 0.6 * f))
        armsX = (torsoX @ L.rot_about(ARMS_PIVOT, (0, 0, 1), 0.3 * c)
                 @ L.rot_about(ARMS_PIVOT, (1, 0, 0), -1.05 * TL.ramp(u, 0.04, 0.5)))
        k = TL.ramp(u, 0.45, 0.95)
        fl = Vector(TL.lerp3((-0.125, 0.06, ANKLE_H), (-0.14, 0.24, 0.09), k))
        fr = Vector(TL.lerp3((0.125, -0.06, ANKLE_H), (0.14, 0.02, 0.09), k))
        feet = {'L': (fl, 1.0 * k, TL.lerp3((-0.12, 1.0, 0.0), (-0.25, 0.0, 1.0), f)),
                'R': (fr, 1.1 * k, TL.lerp3((0.12, 1.0, 0.0), (0.25, 0.0, 1.0), f))}
    X['hips'] = hipsX
    X['torso'] = torsoX
    X['head'] = headX
    X['armsgun'] = armsX
    X['muzzle'] = armsX
    for b in EXTRA:
        X[b] = armsX
    for sfx, sx in (('L', -1), ('R', 1)):
        tgt, pitch, hint = feet[sfx]
        solve_leg(sfx, sx, hipsX @ Vector((sx * HIP_X, 0, HIP_Z)), tgt, pitch, X, hint)
    return X


def pose_any(clip, t):
    if clip in ('death', 'air'):
        return pose_special(clip, t)
    return pose_reload(t) if clip == 'reload' else pose(clip, t)


# ---------------------------------------------------------------- 미리보기
cam = L.setup_preview(res=(1280, 720) if ARMS_ONLY else (900, 900), fov_deg=32)


def shot(name, clip, t, loc, look=(0, 0, 0.95)):
    LAST_Q.clear()
    apply_pose(pose_any(clip, t))
    bpy.context.view_layer.update()
    L.render(os.path.join(PREVIEW, name + '.png'), loc=loc, look_at=look, fov_deg=32)


if ARMS_ONLY:
    # 게임에서는 리그를 앞으로 0.19m·위로 0.125m 옮겨 붙인다(Player.FP_DETAIL_BASE) → 카메라를 그만큼 뒤·아래에 둔 것과 같다
    FP_CAM = (EYE.x, EYE.y - 0.19, EYE.z - 0.125)
    for tt in (0.0, 0.15, 0.22, 0.3, 0.42, 0.6, 0.72, 0.82, 0.92, 1.0, 1.1, 1.22):
        LAST_Q.clear()
        apply_pose(pose_any('reload', tt))
        bpy.context.view_layer.update()
        L.render(os.path.join(PREVIEW, f'fpd_reload{PREVIEW_TAG}_{int(tt * 100):03d}.png'), loc=FP_CAM, look_at=(FP_CAM[0], FP_CAM[1] + 5, FP_CAM[2]), fov_deg=56)
else:
    shot(f'{PFX}_idle_front', 'idle', 0.0, (1.6, 3.2, 1.5))
    shot(f'{PFX}_idle_side', 'idle', 0.0, (3.8, 0.2, 1.1))
    shot(f'{PFX}_idle_back', 'idle', 0.0, (-1.8, -3.0, 1.6))
    if MODE == 'player':
        for tt in (0.25, 0.42, 0.62, 0.9, 1.15):
            shot(f'player_reload_{int(tt * 100):03d}', 'reload', tt, (-1.5, 2.6, 1.55), look=(0, 0.1, 1.25))
            shot(f'player_reload_back_{int(tt * 100):03d}', 'reload', tt, (0.7, -2.2, 1.9), look=(0, 0.3, 1.3))
        shot('player_crouch_side', 'crouch', 0.0, (3.8, 0.2, 0.8), look=(0, 0, 0.65))
        shot('player_crouch_front', 'crouch', 0.0, (1.6, 3.2, 1.1), look=(0, 0, 0.65))
        for clip in ('crouchWalk', 'crouchBack'):
            for q in (0, 1):
                shot(f'player_{clip}_{q}', clip, GAITS[clip]['T'] * q / 4, (3.8, 0.2, 0.8), look=(0, 0, 0.65))
        for q in (0, 1):
            shot(f'player_crouchStrafeR_{q}', 'crouchStrafeR', GAITS['crouchStrafeR']['T'] * q / 4, (0.4, 4.0, 0.8), look=(0, 0, 0.65))
    for clip in ('walk', 'run', 'back'):
        T = GAITS[clip]['T']
        for q in (0, 1):
            shot(f'{PFX}_{clip}_{q}', clip, T * q / 4, (3.8, 0.2, 1.0))
    shot(f'{PFX}_run_front', 'run', GAITS['run']['T'] * 0.1, (1.6, 3.2, 1.3))
    for clip in ('strafeR', 'strafeFastR', 'strafeL'):
        T = GAITS[clip]['T']
        for q in range(4):
            shot(f'{PFX}_{clip}_{q}', clip, T * q / 4, (0.4, 4.0, 1.0))
if not ARMS_ONLY:
    for tt in (0.15, 0.35, 0.55, 0.85):
        shot(f'{PFX}_death_{int(tt * 100):03d}', 'death', tt, (4.4, -0.5, 1.0), look=(0, -0.5, 0.6))
    shot(f'{PFX}_air', 'air', 0.0, (3.8, 0.2, 1.0))
    for q in (1, 2, 3):
        shot(f'{PFX}_turnL_{q}', 'turnL', TURN_N / FPS * q / 4, (1.2, 3.0, 2.6), look=(0, 0, 0.5))
    # 다리가 닿는지 확인: 골반 관절에서 발목까지의 거리 / 다리 길이
    worst = 0.0
    for i in range(TURN_N + 1):
        for sg in (1, -1):
            u = i / TURN_N
            hx = Matrix.Translation((0.02 * sg * math.sin(math.tau * u), 0.0, -0.03 - 0.022 * math.sin(math.pi * u))) @ L.rot_about(HIPS_PIVOT, (1, 0, 0), -0.03)
            for sfx, sx in (('L', -1), ('R', 1)):
                worst = max(worst, ((hx @ Vector((sx * HIP_X, 0, HIP_Z))) - turn_feet(sg, u)[sfx][0]).length / (THIGH + SHIN))
    print('TURN_REACH worst %.3f (must stay below 1)' % worst)
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
if ARMS_ONLY:
    acts = [bake('idle', 2)]
else:
    acts = [bake('idle', 90, BODY)] + [bake(name, cfg['n'], BODY) for name, cfg in GAITS.items()]
    acts += [bake('death', round(DEATH_LEN * FPS), BODY), bake('air', 2, BODY)]
    acts += [bake(name, TURN_N, BODY) for name in TURNS]
    if MODE == 'player':
        acts.append(bake('crouch', 90, BODY))
if MODE in ('player', 'fp'):
    acts.append(bake('reload', round(TL.RELOAD_LEN * FPS), None if ARMS_ONLY else set(EXTRA)))
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

if ARMS_ONLY:
    # 1인칭 모델의 원점은 눈: 게임이 뷰모델(카메라 자식)에 그대로 붙인다
    arm.location = -EYE
    bpy.context.view_layer.update()
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
