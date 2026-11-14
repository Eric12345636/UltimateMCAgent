"""L-obs 编码（Python 侧）。

**这是与 Node 运行侧的契约**：``mc-agent-api/src/coe/local.js`` 是真值，
本文件必须产出**逐 token 一致**的结果。一致性由 ``p1/tests/test_golden.py``
用黄金向量 ``p1/data/golden_local.json`` 保证；改任何一边都要重新生成黄金向量。

设计原则（与 Node 侧相同）：
  - 低层只关心几何与威胁，不关心方块名字、不关心背包
  - 8 个局部方向 × 4 格探测，每格给出「地面类别」
  - 所有数值都分箱，避免无界词表
"""

from __future__ import annotations

import json
import math
import os
from typing import Any, Dict, List, Optional, Sequence

# ---------- 地面类别 ----------

WALL = "wall"
FLAT = "flat"
HOLE = "hole"
LIQ = "liq"
HAZ = "haz"
CLIMB = "climb"
MAGMA = "magma"

TERRAINS = [WALL, FLAT, HOLE, LIQ, HAZ, CLIMB, MAGMA]

HAZARD_NAMES = {
    "lava", "fire", "magma_block", "cactus", "powder_snow", "campfire",
    "soul_fire", "soul_campfire", "lava_cauldron",
}
LIQUID_NAMES = {"water", "lava", "bubble_column"}
CLIMB_NAMES = {
    "ladder", "vine", "twisting_vines", "weaving_vines", "scaffolding", "cave_vines",
}

# goal 类型
GOALS = ["goto", "mine", "attack", "flee", "eat", "craft", "idle"]

# 局部坐标系：8 个方向，[右, 前] 分量。0=N 1=NE 2=E 3=SE 4=S 5=SW 6=W 7=NW，8=不动
DIRS = [(0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1), (-1, 0), (-1, 1)]
MOVE_NONE = 8

PROBE_DEPTH = 4
PROBE_HEIGHT = 3

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN_FILE = os.path.normpath(os.path.join(HERE, "..", "data", "golden_local.json"))


# ---------- 朝向 ----------

def frame(yaw: float) -> Dict[str, float]:
    """mineflayer 朝向约定：yaw=0 朝 -Z，yaw 增大朝 -X。

    前 = (-sin yaw, -cos yaw)，右 = (cos yaw, -sin yaw)
    """
    s = math.sin(yaw)
    c = math.cos(yaw)
    return {"fx": 0.0 - s, "fz": 0.0 - c, "rx": c, "rz": 0.0 - s}


def bearing_index(vx: float, vz: float, f: Dict[str, float]) -> int:
    """把世界方向向量投影到局部系，返回 0..7。"""
    side = vx * f["rx"] + vz * f["rz"]
    front = vx * f["fx"] + vz * f["fz"]
    if side == 0 and front == 0:
        return MOVE_NONE
    idx = math.floor(math.atan2(side, front) / (math.pi / 4) + 0.5)
    return idx % 8


# ---------- 方块分类 ----------

def surface_class(name: Optional[str]) -> Optional[str]:
    """方块名 → 表面类别。None = 未知（区块没加载）。"""
    if name is None:
        return None
    if name in ("air", "cave_air", "void_air"):
        return "air"
    if name in HAZARD_NAMES:
        return "haz"
    if name in LIQUID_NAMES:
        return "liq"
    if name in CLIMB_NAMES:
        return "climb"
    if name in _PASS_NAMES:
        return "pass"
    return "solid"


# 植物类方块（boundingBox 是 empty，可以穿过）
_PASS_NAMES = {
    "short_grass", "grass", "tall_grass", "fern", "dead_bush", "torch",
    "soul_torch", "red_flower", "yellow_flower", "white_flower", "blue_flower",
    "oxeye_daisy", "poppy", "dandelion", "sugar_cane", "sapling", "wheat",
    "carrots", "potatoes", "nether_sprouts", "seagrass", "kelp", "lily_pad",
    "snow", "sculk", "firefly_bush", "short_dry_grass", "tall_dry_grass",
}


def terrain_of(surf: Optional[str], floor: Optional[str]) -> str:
    """表面 + 正下方 → 地面类别。"""
    if surf is None:
        return WALL          # 区块没加载：宁可当墙
    if surf == "haz":
        return HAZ
    if surf == "liq":
        return LIQ
    if surf == "climb":
        return CLIMB
    if surf == "solid":
        return WALL
    # surf 是 air / pass
    if floor is None:
        return HOLE
    if floor == "haz":
        return MAGMA
    if floor == "liq":
        return LIQ
    if floor in ("solid", "climb"):
        return FLAT
    return HOLE


# ---------- 分箱 ----------

def hp_bucket(hp: float) -> int:
    h = float(hp or 0)
    if h <= 0: return 0
    if h < 5: return 1
    if h < 10: return 2
    if h < 15: return 3
    if h < 18: return 4
    if h < 20: return 5
    return 6


def food_bucket(f: float) -> int:
    v = float(f or 0)
    if v <= 0: return 0
    if v < 5: return 1
    if v < 10: return 2
    if v < 15: return 3
    if v < 20: return 4
    return 5


def oxy_bucket(o: float) -> int:
    v = float(o)
    if not math.isfinite(v): return 3
    if v <= 0: return 0
    if v <= 5: return 1
    if v <= 10: return 2
    return 3


def tick_bucket(ticks: float) -> int:
    t = float(ticks)
    if not math.isfinite(t) or t < 0: return 4
    if t < 1: return 0
    if t < 3: return 1
    if t < 6: return 2
    if t < 16: return 3
    return 4


def dist_bucket(d: float) -> int:
    v = float(d)
    if not math.isfinite(v): return 5
    if v < 1: return 0
    if v < 2: return 1
    if v < 4: return 2
    if v < 8: return 3
    if v < 16: return 4
    return 5


def frac_bucket(frac: float) -> int:
    v = float(frac)
    if not math.isfinite(v): return 3
    if v < 0.25: return 0
    if v < 0.5: return 1
    if v < 0.75: return 2
    return 3


# ---------- 探测 ----------

class World:
    """极简体素世界：只存「有哪些方块」，其余按 default 判定。"""

    def __init__(self, fill_below: int = 63, fill: str = "stone",
                 blocks: Optional[Dict[str, str]] = None):
        self.fill_below = fill_below
        self.fill = fill
        self.blocks = dict(blocks or {})

    def block_at(self, x: float, y: float, z: float) -> Optional[str]:
        key = "%d,%d,%d" % (math.floor(x), math.floor(y), math.floor(z))
        if key in self.blocks:
            return self.blocks[key]
        if math.floor(y) <= self.fill_below:
            return self.fill
        return "air"


def ground_offset(world: World, x: float, z: float, y0: int) -> Optional[int]:
    """站立面高度（相对脚部）。站在 y 处的方块上时是 0，上台阶是 +1。"""
    for y in range(y0 + 2, y0 - PROBE_HEIGHT - 1, -1):
        if surface_class(world.block_at(x, y, z)) != "solid":
            continue
        if surface_class(world.block_at(x, y + 1, z)) != "solid":
            return (y + 1) - y0
    return None


def probe_dir(world: World, pos, f, dir_idx: int) -> Dict[str, Any]:
    """单个方向：4 格的地面类别 + 站立面高度偏移。"""
    d = DIRS[dir_idx]
    terr: List[str] = []
    height: Optional[int] = None
    y0 = int(math.floor(pos[1]))
    for k in range(1, PROBE_DEPTH + 1):
        x = pos[0] + (f["rx"] * d[0] + f["fx"] * d[1]) * k
        z = pos[2] + (f["rz"] * d[0] + f["fz"] * d[1]) * k
        surf = surface_class(world.block_at(x, y0, z))
        floor = surface_class(world.block_at(x, y0 - 1, z))
        terr.append(terrain_of(surf, floor))
        if height is None and terr[-1] not in (WALL, HAZ):
            h = ground_offset(world, x, z, y0)
            if h is not None:
                height = h
    return {"terr": terr, "height": height}


def dist3(a, b) -> float:
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)


def as_pos(p) -> List[float]:
    """位置既可能是 {x,y,z} 也可能是 [x,y,z]，统一成列表。"""
    if isinstance(p, dict):
        return [float(p["x"]), float(p["y"]), float(p["z"])]
    return [float(p[0]), float(p[1]), float(p[2])]


# ---------- 编码 ----------

def encode_local(sense: Dict[str, Any]) -> List[str]:
    """结构化观测 → token 数组。必须与 Node 侧逐 token 一致。"""
    t: List[str] = []

    s = sense.get("self", {})
    t.append("<self>")
    t.append("hp%d" % hp_bucket(s.get("hp")))
    t.append("fd%d" % food_bucket(s.get("food")))
    t.append("ox%d" % oxy_bucket(s.get("oxy")))
    t.append("og%d" % (1 if s.get("on_ground") else 0))
    t.append("iw%d" % (1 if s.get("in_water") else 0))
    t.append("il%d" % (1 if s.get("in_lava") else 0))
    t.append("of%d" % (1 if s.get("on_fire") else 0))
    t.append("sk%d" % (1 if s.get("sneaking") else 0))
    t.append("sp%d" % (1 if s.get("sprinting") else 0))
    t.append("bl%d" % (1 if s.get("blocking") else 0))
    t.append("hu%d" % tick_bucket(s.get("hurt_ticks", 0)))

    t.append("<geom>")
    for i, g in enumerate(sense.get("geom", [])):
        t.append("g%d" % i)
        for tr in g["terr"]:
            t.append(tr)
        h = g.get("height")
        t.append("gh%d" % i)
        if h is None:
            t.append("open")
        else:
            t.append(str(max(-PROBE_HEIGHT, min(PROBE_HEIGHT, h))))

    t.append("<threat>")
    th = sense.get("threat", {})
    if th.get("present"):
        t.append("tb%d" % (th.get("bearing") if th.get("bearing") is not None else 8))
        t.append("td%d" % dist_bucket(th.get("dist", 0)))
        hp_frac = th.get("hpFrac")
        t.append("th%d" % (3 if hp_frac is None else frac_bucket(hp_frac)))
    else:
        t.append("tbn")
        t.append("tdf")
        t.append("thf")
    t.append("tt%d" % tick_bucket(th.get("hurtTicks", 0)))

    t.append("<goal>")
    g = sense.get("goal", {})
    t.append("gt%s" % g.get("type", "idle"))
    d = g.get("dist")
    t.append("gd%s" % ("n" if d is None else dist_bucket(d)))
    t.append("gv%d" % (1 if g.get("visible") else 0))
    t.append("gc%s" % (g.get("targetClass") or "na"))
    b = g.get("bearing")
    t.append("gb%d" % (8 if b is None else b))

    t.append("<prev>")
    p = sense.get("prev", {})
    t.append("pm%d" % p.get("move", MOVE_NONE))
    # 前缀固定：sprint=ps jump=pj sneak=pk shield=ph attack=pa dig=pd
    for key, prefix in (("sprint", "ps"), ("jump", "pj"), ("sneak", "pk"),
                        ("shield", "ph"), ("attack", "pa"), ("dig", "pd")):
        t.append("%s%d" % (prefix, 1 if p.get(key) else 0))

    return t


def load_vocab(file: Optional[str] = None) -> List[str]:
    """读黄金向量文件里的词表（Node 侧生成）。"""
    path = file or GOLDEN_FILE
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)["tokens"]


def load_golden(file: Optional[str] = None) -> Dict[str, Any]:
    path = file or GOLDEN_FILE
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def token_ids(tokens: Sequence[str], vocab: Sequence[str]) -> List[int]:
    index = {t: i for i, t in enumerate(vocab)}
    out = []
    for t in tokens:
        if t not in index:
            raise KeyError("token 不在词表里：%s" % t)
        out.append(index[t])
    return out


# ---------- 从世界规格构造观测（与 Node 的 senseFromBot 对齐） ----------

DEFAULT_ENTITY = {
    "position": [0.0, 64.0, 0.0],
    "yaw": 0.0,
    "pitch": 0.0,
    "health": 20.0,
    "onGround": True,
    "isInWater": False,
    "isInLava": False,
    "isOnFire": False,
    "isSneaking": False,
}


def flee_goal(threat: Dict[str, Any]) -> Dict[str, Any]:
    present = threat["present"]
    return {"type": "flee", "dist": threat["dist"] if present else None,
            "visible": present, "targetClass": None,
            "bearing": threat["bearing"] if present else None}


def _normalize_goal(world: World, goal: Optional[Dict[str, Any]], pos, f,
                    entities: Dict[int, Dict[str, Any]], threat: Dict[str, Any]) -> Dict[str, Any]:
    out = {"type": "idle", "dist": None, "visible": False,
           "targetClass": None, "bearing": None}
    if not goal or goal.get("type") in (None, "idle"):
        return out
    if goal.get("type") not in GOALS:
        out["type"] = "idle"
        return out
    out["type"] = goal["type"]
    target = goal.get("target")
    if not target:
        return flee_goal(threat) if out["type"] == "flee" else out
    if target.get("entityId") is not None:
        e = entities.get(int(target["entityId"]))
        if not e:
            return out
        ep = e["position"]
        out["dist"] = dist3(ep, pos)
        out["visible"] = True
        out["bearing"] = bearing_index(ep[0] - pos[0], ep[2] - pos[2], f)
        return out
    if target.get("pos"):
        p = target["pos"]
        out["dist"] = math.sqrt((p["x"] - pos[0]) ** 2 + (p["y"] - pos[1]) ** 2 + (p["z"] - pos[2]) ** 2)
        out["visible"] = True
        out["bearing"] = bearing_index(p["x"] - pos[0], p["z"] - pos[2], f)
        surf = surface_class(world.block_at(p["x"], p["y"], p["z"]))
        floor = surface_class(world.block_at(p["x"], p["y"] - 1, p["z"]))
        out["targetClass"] = None if surf is None else terrain_of(surf, floor)
    return out


def sense_from_world(world_spec: Dict[str, Any],
                     entity_spec: Optional[Dict[str, Any]] = None,
                     entities_spec: Optional[Dict[str, Any]] = None,
                     goal_spec: Optional[Dict[str, Any]] = None,
                     hurt_ticks: float = 99) -> Dict[str, Any]:
    """按世界规格构造一份结构化观测。

    与 Node 的 ``senseFromBot`` 对齐：黄金向量测试靠它保证两侧一致。
    """
    world = World(world_spec.get("fill_below", 63),
                  world_spec.get("fill", "stone"),
                  world_spec.get("blocks"))

    ent = dict(DEFAULT_ENTITY)
    for k, v in (entity_spec or {}).items():
        ent[k] = v
    pos = as_pos(ent["position"])
    ent["position"] = pos
    f = frame(ent["yaw"])

    entities: Dict[int, Dict[str, Any]] = {}
    for k, v in (entities_spec or {}).items():
        e = dict(v)
        e["position"] = as_pos(e["position"])
        entities[int(k)] = e

    geom = [probe_dir(world, pos, f, i) for i in range(8)]

    threat = {"present": False, "bearing": None, "dist": None,
              "hpFrac": None, "hurtTicks": hurt_ticks}
    best = float("inf")
    for e in entities.values():
        if e.get("type") != "hostile":
            continue
        ep = e["position"]
        d = dist3(ep, pos)
        if d > 16 or d >= best:
            continue
        best = d
        threat["present"] = True
        threat["dist"] = d
        threat["bearing"] = bearing_index(ep[0] - pos[0], ep[2] - pos[2], f)
        mx = e.get("maxHealth")
        threat["hpFrac"] = (e["health"] / mx) if (mx and e.get("health") is not None) else None

    self_state = {
        "hp": ent["health"],
        "food": 20,
        "oxy": ent.get("oxygenLevel", 20),
        "on_ground": bool(ent["onGround"]),
        "in_water": bool(ent["isInWater"]),
        "in_lava": bool(ent["isInLava"]),
        "on_fire": bool(ent["isOnFire"]),
        "sneaking": bool(ent["isSneaking"]),
        "sprinting": False,
        "blocking": False,
        "hurt_ticks": hurt_ticks,
    }

    return {
        "self": self_state,
        "geom": geom,
        "threat": threat,
        "goal": _normalize_goal(world, goal_spec, pos, f, entities, threat),
        "prev": {"move": MOVE_NONE, "sprint": False, "jump": False,
                 "sneak": False, "shield": False, "attack": False, "dig": False},
    }
