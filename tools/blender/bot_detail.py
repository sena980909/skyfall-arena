# 힉스필드(이미지→3D)로 만든 상세 메시를 직접 만든 봇 리그에 입힌다.
# - 상세 메시는 절차 모델의 정면·측면·후면 렌더를 자세 기준으로 그린 디자인에서 나왔으므로 자세·비율이 절차 모델과 거의 같다.
# - 그래서 (1) 크기·방향·위치를 절차 메시에 맞춰 정렬하고 (2) 각 정점에서 가장 가까운 절차 메시 면의 본을 물려받는다.
#   본·애니메이션은 그대로 쓰고 겉모습만 바뀐다. 관절 경계는 가중치를 이웃과 섞어 부드럽게 한다.
import math

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree


def _import_joined(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    assert meshes, 'no mesh in ' + path
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
        o.data.transform(mw)
    if len(meshes) > 1:
        with bpy.context.temp_override(active_object=meshes[0], selected_editable_objects=meshes, selected_objects=meshes):
            bpy.ops.object.join()
    det = meshes[0]
    for o in new:
        if o is not det and o.name in bpy.data.objects and o.type != 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    det.name = 'BotMesh'
    det.data.name = 'BotMeshDetail'
    return det


def _bbox(points):
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return lo, hi


def _align(det, proc_pts, tree):
    """Z축 90도 단위 회전 4가지를 시도해 절차 메시와 가장 잘 겹치는 변환을 고른 뒤, 이동·균등 배율을 몇 번 다듬는다."""
    plo, phi = _bbox(proc_pts)
    low_p = [p for p in proc_pts if p.z < plo.z + 0.45 * (phi.z - plo.z)]
    lplo, lphi = _bbox(low_p)
    pc = (lplo + lphi) * 0.5
    src = [v.co.copy() for v in det.data.vertices]
    step = max(1, len(src) // 2500)
    best = None
    for k in range(4):
        R = Matrix.Rotation(k * math.pi / 2, 4, 'Z')
        pts = [R @ p for p in src]
        lo, hi = _bbox(pts)
        s = (phi.z - plo.z) / (hi.z - lo.z)
        low = [p for p in pts if p.z < lo.z + 0.45 * (hi.z - lo.z)]
        llo, lhi = _bbox(low)
        c = (llo + lhi) * 0.5
        M = Matrix.Translation((pc.x, pc.y, plo.z)) @ Matrix.Scale(s, 4) @ Matrix.Translation((-c.x, -c.y, -lo.z)) @ R
        for _ in range(10):
            dx = dy = 0.0
            num = den = 0.0
            n = 0
            for p in src[::step]:
                q = M @ p
                hit = tree.find_nearest(q)
                if hit[0] is None:
                    continue
                dx += hit[0].x - q.x
                dy += hit[0].y - q.y
                num += hit[0].z * q.z
                den += q.z * q.z
                n += 1
            sc = max(0.97, min(1.03, num / den)) if den > 0 else 1.0
            M = Matrix.Translation((dx / n, dy / n, 0)) @ Matrix.Scale(sc, 4) @ M
        err = 0.0
        n = 0
        for p in src[::step]:
            hit = tree.find_nearest(M @ p)
            err += hit[3]
            n += 1
        err /= n
        print(f'DETAIL_ALIGN yaw={k * 90} mean_dist={err:.4f}')
        if best is None or err < best[0]:
            best = (err, M, k)
    print(f'DETAIL_ALIGN_BEST yaw={best[2] * 90} mean_dist={best[0]:.4f}')
    det.data.transform(best[1])
    lo, _ = _bbox([v.co for v in det.data.vertices])
    det.data.transform(Matrix.Translation((0, 0, -lo.z)))
    det.data.update()
    return best[0]


def swap_in(proc, path, tex_size=1024, smooth_passes=2, visor_material='bot_visor'):
    """절차 메시 proc(정점 그룹 = 본, 정점당 하나)을 상세 메시로 바꿔 돌려준다. proc는 지운다."""
    pm = proc.data
    proc_pts = [v.co.copy() for v in pm.vertices]
    polys = [tuple(p.vertices) for p in pm.polygons]
    tree = BVHTree.FromPolygons(proc_pts, polys)
    gname = {g.index: g.name for g in proc.vertex_groups}
    vbone = []
    for v in pm.vertices:
        gs = sorted(v.groups, key=lambda g: -g.weight)
        vbone.append(gname[gs[0].group] if gs else None)
    face_bone = [vbone[p.vertices[0]] for p in pm.polygons]
    face_mat = [pm.materials[p.material_index].name if pm.materials else '' for p in pm.polygons]

    det = _import_joined(path)
    _align(det, proc_pts, tree)
    dm = det.data

    # ---- 본 물려받기 + 경계 섞기
    bones = sorted({b for b in face_bone if b})
    w = []
    for v in dm.vertices:
        hit = tree.find_nearest(v.co)
        w.append({face_bone[hit[2]]: 1.0})
    bm = bmesh.new()
    bm.from_mesh(dm)
    bm.verts.ensure_lookup_table()
    nbrs = [[e.other_vert(v).index for e in v.link_edges] for v in bm.verts]
    bm.free()
    for _ in range(smooth_passes):
        nw = []
        for i, ns in enumerate(nbrs):
            acc = dict(w[i])
            for j in ns:
                for b, x in w[j].items():
                    acc[b] = acc.get(b, 0.0) + x / max(1, len(ns))
            tot = sum(acc.values())
            nw.append({b: x / tot for b, x in acc.items()})
        w = nw
    det.vertex_groups.clear()
    groups = {b: det.vertex_groups.new(name=b) for b in bones}
    for i, ws in enumerate(w):
        top = sorted(ws.items(), key=lambda kv: -kv[1])[:4]
        tot = sum(x for _, x in top)
        for b, x in top:
            if x / tot > 0.02:
                groups[b].add([i], x / tot, 'REPLACE')
    count = {b: 0 for b in bones}
    for ws in w:
        count[max(ws, key=ws.get)] += 1
    print('DETAIL_BONE_VERTS', count)

    # ---- 재질: 본체 하나 + 바이저(게임이 색·발광을 바꾼다)
    base = dm.materials[0]
    base.name = 'bot_detail'
    if visor_material:
        prev = bpy.data.materials.get(visor_material)
        if prev is not None:
            prev.name = visor_material + '_proc'
        vis = base.copy()
        vis.name = visor_material
        dm.materials.append(vis)
        vi = len(dm.materials) - 1
        n = 0
        for p in dm.polygons:
            hit = tree.find_nearest(p.center)
            if face_mat[hit[2]] == visor_material and hit[3] < 0.04:
                p.material_index = vi
                n += 1
        print('DETAIL_VISOR_FACES', n)

    # ---- 텍스처 줄이기 (웹 전송용)
    for img in bpy.data.images:
        if img.size[0] > tex_size or img.size[1] > tex_size:
            print('DETAIL_TEX', img.name, tuple(img.size), '->', tex_size)
            img.scale(tex_size, tex_size)

    tris = sum(len(p.vertices) - 2 for p in dm.polygons)
    print('DETAIL_TRIS', tris, 'VERTS', len(dm.vertices), 'MATS', [m.name for m in dm.materials])
    bpy.data.objects.remove(proc, do_unlink=True)
    return det
