# 적 봇의 정면·좌측·후면·우측 직교 렌더 → assets_src/reference/bot_view_{front,left,back,right}.png
# 힉스필드에서 상세 디자인 이미지를 만들 때 자세·비율 기준으로 쓴다(리그의 관절 위치와 맞아야 하므로 현재 모델을 그대로 찍는다).
# 실행: blender -b assets_src/bot_rig.blend --python tools/blender/render_bot_views.py -- <abs_project_dir>
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else ['.']
PROJECT = os.path.abspath(argv[0])
OUT = os.path.join(PROJECT, 'assets_src', 'reference')

scene = bpy.context.scene
for ob in list(scene.objects):
    if ob.type in ('CAMERA', 'LIGHT'):
        bpy.data.objects.remove(ob, do_unlink=True)
for ob in scene.objects:
    if ob.type == 'ARMATURE':
        ob.data.pose_position = 'REST'

cam_data = bpy.data.cameras.new('ortho')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 2.1
cam_data.clip_start = 0.1
cam_data.clip_end = 30
cam = bpy.data.objects.new('ortho', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

world = bpy.data.worlds.new('flat')
world.use_nodes = True
bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
bg.inputs[0].default_value = (0.82, 0.82, 0.82, 1)
bg.inputs[1].default_value = 1.0
scene.world = world
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = scene.render.resolution_y = 1024
scene.render.film_transparent = False
try:
    scene.view_settings.view_transform = 'Standard'
except Exception:
    pass

key = bpy.data.objects.new('key', bpy.data.lights.new('key', 'SUN'))
key.data.energy = 2.5
scene.collection.objects.link(key)

CENTER = Vector((0.0, 0.1, 0.92))
# 봇 공간: +Y 정면, +X 오른쪽. '좌측 뷰'는 캐릭터의 왼쪽(-X)에서 본 모습
VIEWS = {'front': Vector((0, 1, 0)), 'left': Vector((-1, 0, 0)), 'back': Vector((0, -1, 0)), 'right': Vector((1, 0, 0))}
for name, d in VIEWS.items():
    cam.location = CENTER + d * 8
    cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    # 조명은 카메라 쪽 위에서
    ld = (-d + Vector((0.25, 0, -0.45))).normalized()
    key.rotation_euler = ld.to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(OUT, f'bot_view_{name}.png')
    bpy.ops.render.render(write_still=True)
    print('RENDERED', scene.render.filepath)
