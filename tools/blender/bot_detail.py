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


def _align_object(det, proc_pts, tree):
    """바닥 기준이 없는 물체용 정렬: 상자 중심·크기를 맞춘 뒤 이동(3축)·균등 배율을 다듬는다. 회전은 Z축 90도 단위 4가지."""
    plo, phi = _bbox(proc_pts)
    pc = (plo + phi) * 0.5
    pd = (phi - plo).length
    src = [v.co.copy() for v in det.data.vertices]
    step = max(1, len(src) // 3000)
    best = None
    for k in range(4):
        R = Matrix.Rotation(k * math.pi / 2, 4, 'Z')
        pts = [R @ p for p in src]
        lo, hi = _bbox(pts)
        c = (lo + hi) * 0.5
        M = Matrix.Translation(pc) @ Matrix.Scale(pd / (hi - lo).length, 4) @ Matrix.Translation(-c) @ R
        for _ in range(14):
            qs, hs = [], []
            for p in src[::step]:
                q = M @ p
                hit = tree.find_nearest(q)
                if hit[0] is not None:
                    qs.append(q)
                    hs.append(hit[0])
            n = len(qs)
            cq = sum(qs, Vector()) / n
            ch = sum(hs, Vector()) / n
            num = sum((h - ch).dot(q - cq) for q, h in zip(qs, hs))
            den = sum((q - cq).length_squared for q in qs)
            sc = max(0.96, min(1.04, num / den)) if den > 0 else 1.0
            M = Matrix.Translation(ch) @ Matrix.Scale(sc, 4) @ Matrix.Translation(-cq) @ M
        err = 0.0
        n = 0
        for p in src[::step]:
            err += tree.find_nearest(M @ p)[3]
            n += 1
        err /= n
        print(f'DETAIL_ALIGN yaw={k * 90} mean_dist={err:.4f}')
        if best is None or err < best[0]:
            best = (err, M, k)
    print(f'DETAIL_ALIGN_BEST yaw={best[2] * 90} mean_dist={best[0]:.4f}')
    det.data.transform(best[1])
    det.data.update()
    return best[0]


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


def swap_in(proc, path, tex_size=1024, smooth_passes=2, visor_material='bot_visor', part_of=None, joined=None, keep_parts=None, aux_tex_size=None, align_mode='body'):
    """절차 메시 proc(정점 그룹 = 본, 정점당 하나)을 상세 메시로 바꿔 돌려준다. proc는 지운다.

    part_of(본 이름) → 덩어리 이름, joined = 이어져 있어도 되는 덩어리 쌍의 집합을 주면,
    그 밖의 덩어리 경계에서는 메시를 잘라 떼어 놓는다. 생성 메시는 손·총·가슴이 한 표면으로 붙어 있어서,
    자르지 않으면 재장전처럼 손이 총에서 떨어질 때 그 사이 삼각형이 길게 늘어난다.
    """
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
    (_align_object if align_mode == 'object' else _align)(det, proc_pts, tree)
    dm = det.data

    # ---- 면마다 본 물려받기 → (필요하면) 덩어리 경계 자르기 → 정점 가중치 + 경계 섞기
    bm = bmesh.new()
    bm.from_mesh(dm)
    bm.faces.ensure_lookup_table()
    fbone = {}
    for f in bm.faces:
        hit = tree.find_nearest(f.calc_center_median())
        fbone[f] = face_bone[hit[2]]
    if part_of is not None:
        ok = joined or set()
        cut = []
        for e in bm.edges:
            parts = {part_of(fbone[f]) for f in e.link_faces}
            if len(parts) > 1 and any(frozenset((a, b)) not in ok for a in parts for b in parts if a != b):
                cut.append(e)
        if cut:
            bmesh.ops.split_edges(bm, edges=cut)
        print('DETAIL_CUT_EDGES', len(cut))
        if keep_parts is not None:
            drop = [f for f in bm.faces if part_of(fbone[f]) not in keep_parts]
            fbone = {f: b for f, b in fbone.items() if part_of(b) in keep_parts}
            bmesh.ops.delete(bm, geom=drop, context='FACES')
            print('DETAIL_DROPPED_FACES', len(drop), 'kept', len(fbone))
    bm.verts.ensure_lookup_table()
    w = []
    for v in bm.verts:
        cnt = {}
        for f in v.link_faces:
            cnt[fbone[f]] = cnt.get(fbone[f], 0) + 1
        if not cnt:
            cnt[face_bone[tree.find_nearest(v.co)[2]]] = 1
        w.append({max(cnt, key=cnt.get): 1.0})
    nbrs = [[e.other_vert(v).index for e in v.link_edges] for v in bm.verts]
    bm.to_mesh(dm)
    bm.free()
    dm.update()
    for p in dm.polygons:
        p.use_smooth = True
    bones = sorted({b for b in face_bone if b})
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
        limit = tex_size if (aux_tex_size is None or img.name.startswith('Color')) else aux_tex_size
        if img.size[0] > limit or img.size[1] > limit:
            print('DETAIL_TEX', img.name, tuple(img.size), '->', limit)
            img.scale(limit, limit)

    tris = sum(len(p.vertices) - 2 for p in dm.polygons)
    print('DETAIL_TRIS', tris, 'VERTS', len(dm.vertices), 'MATS', [m.name for m in dm.materials])
    bpy.data.objects.remove(proc, do_unlink=True)
    return det


def recolor_blue(ob):
    """본체 색 텍스처의 따뜻한 색(주황 갑옷, 노란 발광)을 파란색·청록색으로 바꾼다 → 적과 같은 모델의 주인공 판."""
    import numpy as np
    mat = ob.data.materials[0]
    img = None
    for node in mat.node_tree.nodes:
        if node.type == 'BSDF_PRINCIPLED' and node.inputs['Base Color'].is_linked:
            src = node.inputs['Base Color'].links[0].from_node
            while src is not None and src.type != 'TEX_IMAGE':
                nxt = [i for i in src.inputs if i.is_linked]
                src = nxt[0].links[0].from_node if nxt else None
            if src is not None:
                img = src.image
    assert img is not None, 'no base color image'
    n = img.size[0] * img.size[1]
    px = np.empty(n * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(n, 4)
    r, g, b = px[:, 0], px[:, 1], px[:, 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    d = mx - mn
    sat = np.where(mx > 1e-5, d / np.maximum(mx, 1e-5), 0)
    dd = np.maximum(d, 1e-6)
    hue = np.where(mx == r, ((g - b) / dd) % 6, np.where(mx == g, (b - r) / dd + 2, (r - g) / dd + 4)) / 6.0
    warm = ((hue < 0.17) | (hue > 0.96)) & (sat > 0.22)
    hh = np.where(hue > 0.5, hue - 1.0, hue)
    # 주황(~0.07) → 파랑 0.615, 노랑(0.17) 쪽으로 갈수록 청록 0.52
    k = np.clip((hh - 0.105) / 0.065, 0.0, 1.0)
    new_h = np.where(warm, 0.615 - 0.095 * k, hue)
    new_v = np.where(warm, mx * (0.86 + 0.14 * k), mx)
    new_s = np.where(warm, np.minimum(1.0, sat * 0.98), sat)
    h6 = new_h * 6.0
    i = np.floor(h6).astype(np.int32) % 6
    f = h6 - np.floor(h6)
    p = new_v * (1 - new_s)
    q = new_v * (1 - new_s * f)
    t = new_v * (1 - new_s * (1 - f))
    px[:, 0] = np.choose(i, [new_v, q, p, p, t, new_v])
    px[:, 1] = np.choose(i, [t, new_v, new_v, q, p, p])
    px[:, 2] = np.choose(i, [p, p, t, new_v, new_v, q])
    img.pixels.foreach_set(px.ravel())
    img.update()
    print('DETAIL_RECOLOR', img.name, 'warm pixels', int(warm.sum()), 'of', n)
