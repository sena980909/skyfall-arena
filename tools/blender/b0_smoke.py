# B0 스모크 테스트: 헤드리스 Blender에서 메시 생성 → 렌더 → GLB 내보내기가 되는지 확인
# 실행: blender -b --factory-startup --python tools/blender/b0_smoke.py -- <out_dir>
import sys
import os
import bpy

out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else '.'
os.makedirs(out, exist_ok=True)
print('BLENDER', bpy.app.version_string)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1)
cube = bpy.context.active_object
mat = bpy.data.materials.new('test')
mat.use_nodes = True
cube.data.materials.append(mat)

engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
print('ENGINES', engines)

bpy.ops.export_scene.gltf(filepath=os.path.join(out, 'smoke.glb'), export_format='GLB')
print('GLB_OK', os.path.getsize(os.path.join(out, 'smoke.glb')))

# 렌더 확인
cam_data = bpy.data.cameras.new('cam')
cam = bpy.data.objects.new('cam', cam_data)
bpy.context.scene.collection.objects.link(cam)
cam.location = (3, -3, 2)
cam.rotation_euler = (1.1, 0, 0.785)
bpy.context.scene.camera = cam
light = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
bpy.context.scene.collection.objects.link(light)
scene = bpy.context.scene
scene.render.resolution_x = 320
scene.render.resolution_y = 240
for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT', 'BLENDER_WORKBENCH'):
    if eng not in engines:
        continue
    try:
        scene.render.engine = eng
        scene.render.filepath = os.path.join(out, f'smoke_{eng}.png')
        bpy.ops.render.render(write_still=True)
        print('RENDER_OK', eng, os.path.exists(scene.render.filepath))
    except Exception as e:  # noqa
        print('RENDER_FAIL', eng, e)
