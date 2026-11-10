# 맵 모듈 키트 생성 → public/assets/models/map_kit.glb
# 실행: blender -b --factory-startup --python tools/blender/build_map_kit.py -- <abs_project_dir> [preview_only]
#
# 각 모듈은 게임의 충돌 상자와 같은 기준 크기로, 원점 = 바닥 중앙에 만든다(Blender: X 길이, Y 깊이, Z 높이).
# 게임(GreyboxMap.applyKit)은 충돌 상자를 그대로 두고 보이지 않게만 한 뒤, 모듈을 상자 크기·방향에 맞춰 얹는다.
# 드로콜을 줄이려고 색은 정점 색으로 굽는다: 모듈마다 재질은 kit_paint(정점 색) + 발광 재질뿐이다.
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib_build as L  # noqa: E402
import bot_detail as BD  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else ['.']
PROJECT = os.path.abspath(argv[0])
PREVIEW = os.path.join(PROJECT, 'assets_src', '_preview')
os.makedirs(PREVIEW, exist_ok=True)

L.reset_scene()
L.SEG_OVERRIDE = 1
COLORS = {}


def C(name, rgb):
    COLORS['c_' + name] = rgb
    return L.material('c_' + name, rgb)


SD = C('steel_dark', (0.035, 0.042, 0.055))
ST = C('steel', (0.11, 0.135, 0.17))
ST2 = C('steel2', (0.075, 0.09, 0.115))
SL = C('steel_light', (0.26, 0.3, 0.36))
CONC = C('concrete', (0.22, 0.235, 0.26))
YEL = C('hazard', (0.8, 0.52, 0.04))
BLACK = C('black', (0.012, 0.012, 0.016))
WHITE = C('white', (0.7, 0.72, 0.75))
TEAL = C('teal', (0.04, 0.3, 0.34))
NAVY = C('navy', (0.03, 0.045, 0.085))
GLOW_C = L.material('kit_glow_cyan', (0.05, 0.5, 0.6), rough=0.3, emit=(0.2, 0.9, 1.0), emit_strength=2.5)
GLOW_A = L.material('kit_glow_amber', (0.6, 0.35, 0.05), rough=0.3, emit=(1.0, 0.6, 0.15), emit_strength=2.5)

PAINT = bpy.data.materials.new('kit_paint')
PAINT.use_nodes = True
_bsdf = next(n for n in PAINT.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
_bsdf.inputs['Roughness'].default_value = 0.62
_bsdf.inputs['Metallic'].default_value = 0.15
_vc = PAINT.node_tree.nodes.new('ShaderNodeVertexColor')
_vc.layer_name = 'Col'
PAINT.node_tree.links.new(_vc.outputs['Color'], _bsdf.inputs['Base Color'])

MODULES = []


GEN = os.path.join(PROJECT, 'assets_src', 'higgs')
USE_GEN = 'no_gen' not in argv


def generated(name, file, size, yaw=0.0, tex=512, uniform=False, max_tris=0):
    """힉스필드로 만든 소품 메시(그림 → 이미지→3D)가 있으면 그것을 모듈로 쓴다. 없거나 인자에 no_gen이 있으면 None → 절차 모델.
    size = (X 길이, Y 깊이, Z 높이). 재질은 '<모듈 이름>_gen' 하나(자체 텍스처)라서 드로콜은 모듈당 하나다."""
    path = os.path.join(GEN, file)
    if not USE_GEN or not os.path.exists(path):
        return None
    ob = BD.import_static(path, name, size, yaw=yaw, tex_size=tex, uniform=uniform, max_tris=max_tris)
    MODULES.append(ob)
    return ob


def same_mesh(src, name):
    """같은 메시를 가리키는 모듈 하나 더(파일에는 메시가 한 번만 들어간다)."""
    ob = bpy.data.objects.new(name, src.data)
    bpy.context.scene.collection.objects.link(ob)
    MODULES.append(ob)
    return ob


def B(name, c, s, m, bevel=0.0, rot=None, xform=None):
    return L.box(name, c, s, m, 'g', bevel=bevel, rot=rot, xform=xform)


def finish(name):
    """파트를 합치고 재질 색을 정점 색으로 구운 뒤 재질을 kit_paint + 발광으로 줄인다."""
    ob = L.join_parts(name)
    me = ob.data
    col = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    old = list(me.materials)
    targets = []
    for poly in me.polygons:
        m = old[poly.material_index]
        if m.name.startswith('kit_glow'):
            targets.append(m)
            rgb = (1.0, 1.0, 1.0)
        else:
            targets.append(PAINT)
            rgb = COLORS[m.name]
        for li in poly.loop_indices:
            col.data[li].color = (rgb[0], rgb[1], rgb[2], 1.0)
    slots = []
    for t in targets:
        if t not in slots:
            slots.append(t)
    me.materials.clear()
    for t in slots:
        me.materials.append(t)
    for poly, t in zip(me.polygons, targets):
        poly.material_index = slots.index(t)
    me.color_attributes.active_color = col
    try:
        me.color_attributes.render_color_index = 0
    except Exception:  # noqa: BLE001
        pass
    ob.vertex_groups.clear()
    L.box_uv(ob, 2.5)
    L.PARTS.clear()
    MODULES.append(ob)
    print('MODULE %-18s tris %5d  mats %d' % (name, sum(len(p.vertices) - 2 for p in me.polygons), len(slots)))
    return ob


# ---------------------------------------------------------------- 컨테이너 6 x 2.5(깊이) x 2.5(높이)
def container(tag, base):
    dark = tuple(c * 0.7 for c in base)
    light = tuple(min(1.0, c * 1.25 + 0.03) for c in base)
    m, md, ml = C('cont_' + tag, base), C('cont_' + tag + '_d', dark), C('cont_' + tag + '_l', light)
    B('core', (0, 0, 1.25), (5.9, 2.4, 2.4), m)
    for sx in (-1, 1):
        for sy in (-1, 1):
            B('post', (sx * 2.93, sy * 1.18, 1.25), (0.14, 0.14, 2.5), SD, bevel=0.012)
        B('end_top', (sx * 2.95, 0, 2.44), (0.1, 2.5, 0.12), SD)
        B('end_bot', (sx * 2.95, 0, 0.06), (0.1, 2.5, 0.12), SD)
    for sy in (-1, 1):
        B('rail_top', (0, sy * 1.2, 2.44), (6, 0.1, 0.12), SD)
        B('rail_bot', (0, sy * 1.2, 0.06), (6, 0.1, 0.12), SD)
        for i in range(18):
            B('rib', (-2.55 + i * 0.3, sy * 1.215, 1.25), (0.12, 0.05, 2.1), md)
        B('stripe', (1.2, sy * 1.245, 1.95), (2.2, 0.02, 0.34), WHITE)
        B('logo', (2.0, sy * 1.25, 1.95), (0.34, 0.02, 0.22), BLACK)
        B('marker', (-2.3, sy * 1.245, 0.5), (0.5, 0.02, 0.1), GLOW_A)
    for i in range(9):
        B('roof_rib', (-2.4 + i * 0.6, 0, 2.47), (0.14, 2.3, 0.05), md)
    for sy in (-1, 1):
        B('door', (2.975, sy * 0.58, 1.25), (0.05, 1.12, 2.2), ml)
        for yy in (0.3, 0.85):
            L.cyl('bar', (3.01, sy * yy, 0.15), (3.01, sy * yy, 2.35), 0.025, 0.025, SL, 'g', segments=6)
        B('handle', (3.03, sy * 0.3, 1.1), (0.03, 0.2, 0.06), SL)
    for i in range(5):
        B('end_rib', (-2.975, -0.9 + i * 0.45, 1.25), (0.05, 0.14, 2.1), md)
    finish('kit_container_' + tag)


# ---------------------------------------------------------------- 크레이트 2 x 2 x h
def crate(h, name):
    B('core', (0, 0, h / 2), (1.88, 1.88, h - 0.06), ST)
    for sx in (-1, 1):
        for sy in (-1, 1):
            B('post', (sx * 0.94, sy * 0.94, h / 2), (0.12, 0.12, h), SD, bevel=0.012)
    for z in (0.06, h - 0.06):
        for s in (-1, 1):
            B('fx', (0, s * 0.94, z), (2, 0.12, 0.12), SD)
            B('fy', (s * 0.94, 0, z), (0.12, 2, 0.12), SD)
    B('lid', (0, 0, h - 0.012), (1.7, 1.7, 0.024), SL)
    B('lid_mark', (0, 0, h - 0.004), (0.9, 0.16, 0.01), YEL)
    for s in (-1, 1):
        B('plate_y', (0, s * 0.945, h / 2), (1.4, 0.03, h - 0.45), TEAL)
        B('glow_y', (0, s * 0.965, h / 2), (0.5, 0.02, 0.06), GLOW_C)
        B('plate_x', (s * 0.945, 0, h / 2), (0.03, 1.4, h - 0.45), TEAL)
        B('glow_x', (s * 0.965, 0, h / 2), (0.02, 0.5, 0.06), GLOW_C)
    finish(name)


# ---------------------------------------------------------------- 엄폐 방벽 6 x 0.6 x 1.1
def barrier():
    L.prism('body', [(-0.3, 0), (0.3, 0), (0.3, 0.22), (0.15, 0.5), (0.12, 1.04), (-0.12, 1.04), (-0.15, 0.5), (-0.3, 0.22)],
            5.9, CONC, 'g', bevel=0.0)
    for i in range(12):
        B('cap', (-2.75 + i * 0.5, 0, 1.07), (0.5, 0.3, 0.06), YEL if i % 2 == 0 else BLACK)
    for sx in (-1, 1):
        B('end', (sx * 2.96, 0, 0.55), (0.08, 0.62, 1.1), SD)
    for sy in (-1, 1):
        B('reflector', (0, sy * 0.15, 0.78), (4.6, 0.03, 0.07), GLOW_A)
        B('foot', (0, sy * 0.27, 0.04), (5.6, 0.06, 0.08), SD)
    finish('kit_barrier')


# ---------------------------------------------------------------- 중앙 플랫폼
def deck():
    B('slab', (0, 0, 0.2), (11.9, 11.9, 0.32), ST)
    for s in (-1, 1):
        B('beam_y', (0, s * 5.9, 0.2), (12, 0.2, 0.4), SD)
        B('beam_x', (s * 5.9, 0, 0.2), (0.2, 12, 0.4), SD)
        B('hazard', (s * 5.55, 0, 0.39), (0.3, 11.4, 0.035), YEL)
    for i in range(4):
        for j in range(4):
            B('panel', (-4.2 + i * 2.8, -4.2 + j * 2.8, 0.385), (2.6, 2.6, 0.03), SL if (i + j) % 2 == 0 else ST2)
    for k in (-3.5, 0, 3.5):
        B('under', (0, k, -0.1), (11.6, 0.3, 0.22), SD)
    for sx in (-1, 1):
        for sy in (-1, 1):
            B('ulight', (sx * 3, sy * 1.75, -0.02), (0.9, 0.22, 0.04), GLOW_C)
    finish('kit_deck')


def pillar():
    B('core', (0, 0, 1.8), (0.7, 0.7, 3.6), ST, bevel=0.03)
    B('base', (0, 0, 0.125), (1.0, 1.0, 0.25), SD, bevel=0.03)
    B('cap', (0, 0, 3.5), (1.0, 1.0, 0.2), SD, bevel=0.03)
    B('band', (0, 0, 1.15), (0.76, 0.76, 0.16), YEL)
    for s in (-1, 1):
        B('glow_y', (0, s * 0.355, 2.3), (0.08, 0.02, 1.2), GLOW_C)
        B('glow_x', (s * 0.355, 0, 2.3), (0.02, 0.08, 1.2), GLOW_C)
    finish('kit_pillar')


def rail():
    for i in range(7):
        B('post', (-6 + 0.08 + i * (11.84 / 6), 0, 0.5), (0.16, 0.3, 1.0), SD)
    for i in range(6):
        B('panel', (-5.0 + i * 2.0, 0, 0.47), (1.8, 0.12, 0.72), ST)
        B('panel_line', (-5.0 + i * 2.0, 0, 0.47), (1.2, 0.14, 0.06), TEAL)
    B('top', (0, 0, 0.95), (12, 0.22, 0.1), YEL)
    B('kick', (0, 0, 0.05), (12, 0.24, 0.1), SD)
    finish('kit_rail')


def stairs():
    """원점 = 안쪽(플랫폼 쪽) 바닥 가장자리 중앙. +X로 6.3m 내려간다. 폭 4m."""
    rz = Matrix.Rotation(-math.pi / 2, 4, 'Z')  # 프로파일(y,z)을 (x,z)로
    pts = [(0.0, 0.0)]
    for i in range(9):
        h = 4.0 - i * 0.45
        pts += [(i * 0.7, h), ((i + 1) * 0.7, h)]
    pts.append((6.3, 0.0))
    L.prism('body', pts, 3.7, ST, 'g', bevel=0.0, xform=rz)
    for s in (-1, 1):
        L.prism('side', pts, 0.15, SD, 'g', x=s * 1.925, bevel=0.0, xform=rz)
    for i in range(9):
        h = 4.0 - i * 0.45
        B('nose', ((i + 1) * 0.7 - 0.06, 0, h + 0.004), (0.1, 3.7, 0.024), YEL)
        B('tread', (i * 0.7 + 0.32, 0, h + 0.002), (0.5, 3.4, 0.012), ST2)
    finish('kit_stairs')


# ---------------------------------------------------------------- 외벽 구간 8 x 1 x 6
def wall_seg():
    B('core', (0, 0, 3.0), (8, 0.7, 6), ST2)
    B('plinth', (0, 0, 0.3), (8, 1.0, 0.6), SD)
    B('crown', (0, 0, 5.75), (8, 0.9, 0.5), SD)
    for sx in (-1, 1):
        B('pilaster', (sx * 3.75, 0, 3.0), (0.5, 1.0, 6), SD)
    for sy in (-1, 1):
        for sx in (-1, 1):
            B('panel', (sx * 1.72, sy * 0.36, 2.7), (3.2, 0.06, 3.3), ST)
            B('panel_in', (sx * 1.72, sy * 0.395, 2.7), (2.6, 0.02, 0.5), NAVY)
            B('vent', (sx * 1.72, sy * 0.395, 1.5), (1.4, 0.03, 0.3), BLACK)
        B('light', (0, sy * 0.43, 4.95), (6.6, 0.05, 0.12), GLOW_C)
        B('hazard', (0, sy * 0.505, 0.5), (7.0, 0.02, 0.12), YEL)
    finish('kit_wall')


# ---------------------------------------------------------------- 배경 타워 10 x 10 x 40, 벽 위 조명
def tower():
    B('core', (0, 0, 20), (10, 10, 40), NAVY)
    B('base', (0, 0, 1.5), (11, 11, 3), SD)
    B('top', (0, 0, 40.5), (8, 8, 1), SD)
    L.cyl('antenna', (2, 2, 41), (2, 2, 47), 0.15, 0.08, SD, 'g', segments=6)
    for k in range(9):
        z = 5 + k * 4
        g = GLOW_A if k % 3 == 0 else GLOW_C
        for s in (-1, 1):
            B('win_y', (0, s * 5.02, z), (7.5, 0.06, 0.45), g)
            B('win_x', (s * 5.02, 0, z), (0.06, 7.5, 0.45), g)
    finish('kit_tower')


def lamp():
    B('pole', (0, 0, 1.2), (0.14, 0.14, 2.4), SD)
    B('arm', (0, 0, 2.4), (0.9, 0.2, 0.14), SD)
    B('head', (0, 0, 2.3), (0.7, 0.16, 0.06), GLOW_C)
    finish('kit_lamp')


# 컨테이너·상자·방벽·단말은 생성 메시가 있으면 그것을 쓴다
# 컨테이너는 생성 메시의 모양을 쓰지 않는다: 골판과 테두리가 울퉁불퉁하게 나와서, 겉그림만 여섯 면으로 찍어 깨끗한 상자에 입힌다
CONTAINER_SRC = os.path.join(GEN, 'prop_container.glb')
gen_container = None
if USE_GEN and os.path.exists(CONTAINER_SRC):
    gen_container = BD.project_box(
        CONTAINER_SRC, 'kit_container_a', (6, 2.5, 2.5),
        {'yp': (0, 0, 1024, 427), 'zp': (1024, 0, 1024, 427), 'yn': (0, 427, 1024, 427), 'xp': (1024, 427, 427, 427),
         'xn': (1451, 427, 427, 427), 'zn': (0, 854, 408, 170)},
        (2048, 1024), PREVIEW, border=0.2, inset=0.08)
    MODULES.append(gen_container)
if gen_container:
    # 색 변형은 게임이 텍스처 채널을 바꿔 낸다(GreyboxMap.applyKit): 메시·텍스처는 하나만 싣는다
    for tag in 'bcd':
        same_mesh(gen_container, 'kit_container_' + tag)
else:
    container('a', (0.62, 0.21, 0.045))
    container('b', (0.045, 0.3, 0.34))
    container('c', (0.07, 0.15, 0.42))
    container('d', (0.23, 0.25, 0.28))
# The crate is a box as well: same projection (straight edges, 108 triangles instead of 2,600 on 40 instances)
CRATE_SRC = os.path.join(GEN, 'prop_crate.glb')
gen_crate = None
if USE_GEN and os.path.exists(CRATE_SRC):
    gen_crate = BD.project_box(
        CRATE_SRC, 'kit_crate', (2, 2, 1),
        {'yp': (0, 0, 512, 256), 'yn': (512, 0, 512, 256), 'xp': (0, 256, 512, 256), 'xn': (512, 256, 512, 256),
         'zp': (0, 512, 512, 512), 'zn': (512, 512, 256, 256)},
        (1024, 1024), PREVIEW, border=0.15, inset=0.045)
    MODULES.append(gen_crate)
if gen_crate:
    # 높은 상자(2m) = 상자 둘을 쌓은 것. 위 상자는 90° 돌려 같은 면이 겹쳐 보이지 않게 한다
    top = gen_crate.data.copy()
    top.transform(Matrix.Translation((0, 0, 1)) @ Matrix.Rotation(math.pi / 2, 4, 'Z'))
    bm = bmesh.new()
    bm.from_mesh(gen_crate.data)
    bm.from_mesh(top)
    tall = bpy.data.meshes.new('kit_crate_tall')
    bm.to_mesh(tall)
    bm.free()
    bpy.data.meshes.remove(top)
    for p in tall.polygons:
        p.use_smooth = False
    tall.materials.append(gen_crate.data.materials[0])
    ob = bpy.data.objects.new('kit_crate_tall', tall)
    bpy.context.scene.collection.objects.link(ob)
    MODULES.append(ob)
else:
    crate(1.0, 'kit_crate')
    crate(2.0, 'kit_crate_tall')
if not generated('kit_barrier', 'prop_barrier.glb', (6, 0.6, 1.1), tex=1024):
    barrier()
# 임무 단말(중계기·신호기·전송 단말): 충돌 상자가 없어 비율을 그대로 둔다. 기준 높이 2m, 게임이 높이에 맞춰 줄인다
generated('kit_console', 'prop_console.glb', (0.9, 0.9, 2.0), uniform=True)
deck()
pillar()
rail()
stairs()
wall_seg()
tower()
lamp()
print('TOTAL_TRIS', sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in MODULES))

# ---------------------------------------------------------------- 미리보기 (한 줄로 늘어놓고 렌더 후 원점 복귀)
cam = L.setup_preview(res=(1400, 700), fov_deg=30)
lineup = {'kit_container_a': (-9, 0, 0), 'kit_container_b': (-9, 4, 0), 'kit_crate': (-3.5, 0, 0), 'kit_crate_tall': (-3.5, 3.5, 0),
          'kit_barrier': (2, -1.5, 0), 'kit_pillar': (0, 3, 0), 'kit_rail': (4, 5, 0), 'kit_wall': (6, 9, 0), 'kit_stairs': (7, 0, 0),
          'kit_console': (-0.5, -2.5, 0)}
for o in MODULES:
    o.hide_render = o.name not in lineup
    if o.name in lineup:
        o.location = lineup[o.name]
L.render(os.path.join(PREVIEW, 'kit_lineup.png'), loc=(-4, -26, 12), look_at=(1.5, 2, 1.5), fov_deg=30)
for o in MODULES:
    o.hide_render = o.name != 'kit_deck'
    o.location = (0, 0, 0)
L.render(os.path.join(PREVIEW, 'kit_deck.png'), loc=(14, -16, 9), look_at=(0, 0, 0), fov_deg=30)
for o in MODULES:
    o.hide_render = False
if len(argv) > 1 and argv[1] == 'preview_only':
    print('PREVIEW_ONLY_DONE')
    sys.exit(0)

cam.hide_viewport = True
for o in list(bpy.context.scene.objects):
    if o not in MODULES:
        bpy.data.objects.remove(o, do_unlink=True)
out = os.path.join(PROJECT, 'public', 'assets', 'models', 'map_kit.glb')
want = dict(filepath=out, export_format='GLB', use_selection=False, export_yup=True, export_apply=True,
            export_animations=False, export_skins=False, export_materials='EXPORT', export_cameras=False, export_lights=False,
            export_extras=False, export_vertex_color='ACTIVE', export_all_vertex_colors=False,
            # 생성 소품의 텍스처는 JPEG로 싣는다(PNG면 소품 넷에 5MB가 넘는다)
            export_image_format='JPEG', export_jpeg_quality=85, export_image_quality=85)
props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
print('EXPORT_SKIPPED_ARGS', sorted(set(want) - props))
bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in props})
print('EXPORTED', out, os.path.getsize(out))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(PROJECT, 'assets_src', 'map_kit.blend'))
print('BUILD_DONE')
