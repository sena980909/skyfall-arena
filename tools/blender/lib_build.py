"""Blender 절차적 모델링 공용 도구 (헤드리스 bpy).

좌표계(Blender): X 오른쪽, Y 앞, Z 위. glTF로 내보내면 Y 앞 → -Z, Z 위 → +Y 가 된다.
모든 파트는 "리지드 스키닝": 파트 하나가 본 하나에 가중치 1로 묶인다(장갑·총 같은 하드서피스에 적합).
"""
import math
import bmesh
import bpy
from mathutils import Matrix, Vector

PARTS = []  # (object) 목록: 마지막에 하나의 메시로 합친다
MATS = {}


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    PARTS.clear()
    MATS.clear()


def material(name, color, rough=0.5, metal=0.0, emit=None, emit_strength=1.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if emit is not None:
        for key in ('Emission Color', 'Emission'):
            if key in bsdf.inputs:
                bsdf.inputs[key].default_value = (*emit, 1.0)
                break
        if 'Emission Strength' in bsdf.inputs:
            bsdf.inputs['Emission Strength'].default_value = emit_strength
    MATS[name] = m
    return m


def _finish(bm, name, mat, group, bevel=0.0, segments=2, xform=None, smooth_angle=35.0):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, offset_type='OFFSET', segments=segments,
                        profile=0.5, affect='EDGES', clamp_overlap=True)
    if xform is not None:
        bmesh.ops.transform(bm, matrix=xform, verts=bm.verts[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    try:
        me.set_sharp_from_angle(angle=math.radians(smooth_angle))
    except Exception:
        pass
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    vg = ob.vertex_groups.new(name=group)
    vg.add(list(range(len(me.vertices))), 1.0, 'REPLACE')
    PARTS.append(ob)
    return ob


def prism(name, pts, width, mat, group, x=0.0, bevel=0.002, xform=None, segments=2):
    """측면 윤곽(pts: (y, z) 목록)을 X 방향 두께 width로 돌출."""
    bm = bmesh.new()
    vs = [bm.verts.new((x - width / 2, p[0], p[1])) for p in pts]
    face = bm.faces.new(vs)
    r = bmesh.ops.extrude_face_region(bm, geom=[face])
    ev = [e for e in r['geom'] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=ev, vec=(width, 0, 0))
    return _finish(bm, name, mat, group, bevel, segments, xform)


def box(name, center, size, mat, group, bevel=0.002, rot=None, xform=None, segments=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts[:])
    m = Matrix.Translation(center)
    if rot is not None:
        m = m @ rot.to_4x4()
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, offset_type='OFFSET', segments=segments,
                        profile=0.5, affect='EDGES', clamp_overlap=True)
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts[:])
    return _finish(bm, name, mat, group, 0.0, segments, xform)


def cyl(name, p0, p1, r0, r1, mat, group, segments=16, bevel=0.0, xform=None, smooth_angle=35.0):
    """p0→p1 축의 원뿔대(양끝 막힘)."""
    p0 = Vector(p0)
    p1 = Vector(p1)
    d = p1 - p0
    length = d.length
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=r0, radius2=r1, depth=length)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, offset_type='OFFSET', segments=2,
                        profile=0.5, affect='EDGES', clamp_overlap=True)
    rot = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
    m = Matrix.Translation((p0 + p1) / 2) @ rot
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts[:])
    return _finish(bm, name, mat, group, 0.0, 2, xform, smooth_angle)


def sphere(name, center, radius, mat, group, xform=None, scale=(1, 1, 1)):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=9, radius=radius)
    bmesh.ops.scale(bm, vec=scale, verts=bm.verts[:])
    bmesh.ops.translate(bm, verts=bm.verts[:], vec=center)
    return _finish(bm, name, mat, group, 0.0, 2, xform, smooth_angle=80.0)


def join_parts(name):
    """PARTS를 하나의 메시 오브젝트로 합친다(정점 그룹·머티리얼 슬롯 유지)."""
    obs = list(PARTS)
    with bpy.context.temp_override(active_object=obs[0], selected_editable_objects=obs, selected_objects=obs):
        bpy.ops.object.join()
    ob = obs[0]
    ob.name = name
    ob.data.name = name
    PARTS.clear()
    PARTS.append(ob)
    return ob


def basis(x, y, z, origin=(0, 0, 0)):
    """열벡터 (x, y, z)와 원점으로 4x4 행렬."""
    m = Matrix.Identity(4)
    for i, v in enumerate((x, y, z)):
        m[0][i], m[1][i], m[2][i] = v[0], v[1], v[2]
    m[0][3], m[1][3], m[2][3] = origin
    return m


def rot_about(point, axis, angle):
    """point를 지나는 axis 축 회전(4x4)."""
    p = Vector(point)
    return Matrix.Translation(p) @ Matrix.Rotation(angle, 4, Vector(axis).normalized()) @ Matrix.Translation(-p)


def setup_preview(res=(960, 540), fov_deg=56.0):
    """카메라 = 원점에서 +Y를 바라봄(게임의 1인칭 시점과 동일). 세로 FOV 지정."""
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new('cam')
    cam_data.sensor_fit = 'VERTICAL'
    cam_data.angle_y = math.radians(fov_deg)
    cam_data.clip_start = 0.01
    cam_data.clip_end = 50
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    cam.rotation_euler = (math.radians(90), 0, 0)
    scene.camera = cam
    for nm, rot, energy in (('sun', (math.radians(50), 0, math.radians(30)), 3.0),
                            ('fill', (math.radians(70), 0, math.radians(-120)), 1.0)):
        ld = bpy.data.lights.new(nm, 'SUN')
        ld.energy = energy
        lo = bpy.data.objects.new(nm, ld)
        lo.rotation_euler = rot
        scene.collection.objects.link(lo)
    world = bpy.data.worlds.new('w')
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs[0].default_value = (0.32, 0.42, 0.6, 1)
    bg.inputs[1].default_value = 1.0
    scene.world = world
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.film_transparent = False
    try:
        scene.view_settings.view_transform = 'Standard'
    except Exception:
        pass
    return cam


def render(path, cam=None, loc=None, look_at=None, fov_deg=None):
    scene = bpy.context.scene
    cam = cam or scene.camera
    if loc is not None:
        cam.location = loc
        d = Vector(look_at) - Vector(loc)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    if fov_deg is not None:
        cam.data.angle_y = math.radians(fov_deg)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
