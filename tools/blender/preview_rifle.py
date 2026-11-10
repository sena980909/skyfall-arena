# 라이플만 만들어 여러 각도로 렌더 (모델링 확인용)
# 실행: blender -b --factory-startup --python tools/blender/preview_rifle.py -- <abs_out_dir>
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib_build as L  # noqa: E402
from fp_rifle import build_rifle  # noqa: E402

out = os.path.abspath(sys.argv[sys.argv.index('--') + 1])
os.makedirs(out, exist_ok=True)
L.reset_scene()
build_rifle()
cam = L.setup_preview(res=(1100, 620), fov_deg=30)
c = (0, 0.07, -0.04)
L.render(os.path.join(out, 'rifle_left.png'), loc=(-1.6, 0.07, -0.04), look_at=c)
L.render(os.path.join(out, 'rifle_34.png'), loc=(-1.0, -1.0, 0.45), look_at=c)
L.render(os.path.join(out, 'rifle_top.png'), loc=(0.001, 0.07, 1.6), look_at=c)
L.render(os.path.join(out, 'rifle_rear.png'), loc=(-0.25, -1.2, 0.2), look_at=c)
print('PREVIEW_DONE')
