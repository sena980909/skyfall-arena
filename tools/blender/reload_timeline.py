"""재장전 시간표: 1인칭 리그(build_fp_rig)와 3인칭 주인공 리그(build_bot_rig player)가 함께 쓴다.

같은 동작을 같은 시각에 하도록 구간(초)을 한곳에 둔다. 손·총이 어디로 가는지는 각 리그가 정한다
(1인칭은 카메라 공간, 3인칭은 몸 공간이라 좌표가 다르다). 게임의 효과음 시점(Player.RELOAD_CUES)도 여기에 맞춘다.
"""

RELOAD_LEN = 1.4

# 구간 (시작, 끝)
CANT_IN = (0.03, 0.22)       # 총을 기울여 탄창 구멍이 보이게
CANT_OUT = (1.10, 1.34)      # 원래 자세로
HAND_LEAVE = (0.10, 0.30)    # 왼손이 총열 덮개에서 떨어짐
MAG_OUT = (0.16, 0.42)       # 빈 탄창이 빠져 떨어짐
MAG_SWAP = 0.45              # 이 시각부터 '새 탄창'
HAND_GRAB = (0.50, 0.60)     # 왼손이 새 탄창을 쥠
MAG_IN = (0.52, 0.86)        # 새 탄창을 탄창 구멍 아래까지 가져옴
MAG_SEAT = (0.88, 0.97)      # 끝까지 밀어 넣음
HAND_RELEASE = (0.99, 1.12)  # 탄창에서 손을 뗌
HAND_RETURN = (1.04, 1.28)   # 왼손이 총열 덮개로 돌아옴
SEAT_GAP = 0.085             # 밀어 넣기 직전 탄창이 내려와 있는 거리(m, 총 로컬 -Z)

# 효과음 시점(초): 탄창 멈치, 탄창 걸림, 왼손 복귀
CUES = (0.14, 0.93, 1.15)


def ramp(t, t0, t1):
    if t <= t0:
        return 0.0
    if t >= t1:
        return 1.0
    k = (t - t0) / (t1 - t0)
    return k * k * (3 - 2 * k)


def lerp3(a, b, k):
    return tuple(x + (y - x) * k for x, y in zip(a, b))


def cant(t):
    """총 기울임 0..1."""
    return ramp(t, *CANT_IN) * (1 - ramp(t, *CANT_OUT))


def mag_offset(t, out_end, in_start):
    """탄창 위치(총 로컬 오프셋). out_end = 빈 탄창이 떨어져 가는 곳, in_start = 새 탄창이 출발하는 곳."""
    if t < MAG_SWAP:
        return lerp3((0.0, 0.0, 0.0), out_end, ramp(t, *MAG_OUT))
    off = lerp3(in_start, (0.0, 0.0, -SEAT_GAP), ramp(t, *MAG_IN))
    return lerp3(off, (0.0, 0.0, 0.0), ramp(t, *MAG_SEAT))


def hand_weights(t):
    """왼손 위치 가중치 (총열 덮개, 탄창, 그 밖 = 탄창 주머니 쪽)."""
    w_gun = (1 - ramp(t, *HAND_LEAVE)) + ramp(t, *HAND_RETURN)
    w_mag = ramp(t, *HAND_GRAB) * (1 - ramp(t, *HAND_RELEASE))
    return w_gun, w_mag, max(0.0, 1 - w_gun - w_mag)
