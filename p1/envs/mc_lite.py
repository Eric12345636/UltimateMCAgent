"""极简体素仿真（mc_lite）。

只为训练**反射策略**服务，所以只复刻 8 个机制：
  1. 重力与落地
  2. 方块碰撞（6 类地面：wall/flat/hole/liq/haz/climb/magma）
  3. 岩浆 / 火焰伤害
  4. 坠落伤害
  5. 实体追击 + 攻击冷却
  6. 氧气 / 溺水
  7. 液体减速
  8. 饥饿（简化：只随时间缓慢下降）

**它不是 Minecraft 的替身**：配方、掉落、经验、方块放置全都不模拟。
它的唯一职责是给反射策略提供「便宜到可以跑百万步」的训练场，
所以仿真的观测编码必须与 Node 运行侧**逐 token 一致**——
这个一致性由 p1/tests/test_golden.py 用黄金向量守住。

真服上的评测仍然是唯一有效的评测场。
"""

from __future__ import annotations

import math
import random
from typing import Any, Dict, List, Optional, Tuple

from coe.tokens import (DIRS, MOVE_NONE, World, bearing_index, encode_local, flee_goal,
                        frame, probe_dir, surface_class, terrain_of)

TICK = 1.0 / 20.0

# 移动速度（格/tick）。MC 走路约 0.216，疾跑约 0.281
WALK_SPEED = 0.216
SPRINT_SPEED = 0.281
SWIM_SPEED = 0.12

GRAVITY = 0.08
TERMINAL_VY = -3.92

# 敌对实体
ENTITY_SPEED = 0.22
ATTACK_RANGE = 2.0
ATTACK_INTERVAL = 20      # tick
ATTACK_DAMAGE = 1.0

LAVA_DAMAGE_INTERVAL = 10
LAVA_DAMAGE = 2.0
FIRE_DAMAGE_INTERVAL = 20
FIRE_DAMAGE = 1.0
DROWN_INTERVAL = 10
DROWN_DAMAGE = 2.0


class Entity:
    def __init__(self, eid: int, pos: Tuple[float, float, float], hp: float = 20.0,
                 kind: str = "hostile"):
        self.id = eid
        self.pos = list(pos)
        self.hp = hp
        self.max_hp = hp
        self.kind = kind
        self.attack_cd = 0
        self.yaw = 0.0


class MCEnv:
    """反射训练用的极简环境。

    观测是 L-obs（88 token），动作是控制向量。
    """

    def __init__(self, seed: int = 0, size: int = 40, horizon: int = 200,
                 goal: str = "flee", n_entities: int = 1):
        self.rng = random.Random(seed)
        self.size = size
        self.horizon = horizon
        self.goal_kind = goal
        self.n_entities = n_entities
        self.reset()

    # ---------- 世界 ----------

    def _build_world(self) -> None:
        """平地 + 一些坑 / 水塘 / 岩浆 / 台阶。"""
        blocks: Dict[str, str] = {}
        r = self.rng
        half = self.size // 2
        # 挖几个洞
        for _ in range(6):
            cx = r.randint(-half + 4, half - 4)
            cz = r.randint(-half + 4, half - 4)
            w = r.randint(1, 3)
            for dx in range(w):
                for dz in range(w):
                    for y in (61, 62, 63):
                        blocks["%d,%d,%d" % (cx + dx, y, cz + dz)] = "air"
        # 几个水塘
        for _ in range(2):
            cx = r.randint(-half + 5, half - 5)
            cz = r.randint(-half + 5, half - 5)
            for dx in range(2):
                for dz in range(2):
                    blocks["%d,63,%d" % (cx + dx, cz + dz)] = "water"
        # 几摊岩浆
        for _ in range(2):
            cx = r.randint(-half + 5, half - 5)
            cz = r.randint(-half + 5, half - 5)
            for dx in range(2):
                for dz in range(2):
                    blocks["%d,63,%d" % (cx + dx, cz + dz)] = "lava"
        # 几级台阶
        for _ in range(3):
            cx = r.randint(-half + 6, half - 6)
            cz = r.randint(-half + 6, half - 6)
            blocks["%d,64,%d" % (cx, cz)] = "stone"
        self.world = World(63, "stone", blocks)

    def _build_entities(self) -> None:
        r = self.rng
        self.entities: List[Entity] = []
        for i in range(self.n_entities):
            ang = r.random() * math.tau
            dist = r.uniform(6, 12)
            x = self.pos[0] + math.cos(ang) * dist
            z = self.pos[2] + math.sin(ang) * dist
            self.entities.append(Entity(100 + i, (x, 64.0, z)))

    # ---------- 工具 ----------

    def _cell(self, x: float, y: float, z: float) -> Optional[str]:
        return self.world.block_at(x, y, z)

    def _solid(self, x: float, y: float, z: float) -> bool:
        return surface_class(self._cell(x, y, z)) == "solid"

    def _surfaces(self) -> Tuple[bool, bool]:
        """当前位置是不是在水里 / 岩浆里。"""
        here = self._cell(self.pos[0], self.pos[1], self.pos[2])
        below = self._cell(self.pos[0], self.pos[1] - 0.5, self.pos[2])
        s = surface_class(here)
        f = surface_class(below)
        in_lava = (s == "haz") or (f == "haz")
        in_water = (s == "liq") or (f == "liq")
        return in_water, in_lava

    def _ground_y(self, x: float, z: float) -> Optional[float]:
        for y in range(int(math.floor(self.pos[1])) + 2, int(math.floor(self.pos[1])) - 4, -1):
            if self._solid(x, y, z):
                above = self._cell(x, y + 1, z)
                if surface_class(above) != "solid":
                    return float(y + 1)
        return None

    # ---------- 观测 ----------

    def _sense(self) -> Dict[str, Any]:
        f = frame(self.yaw)
        geom = [probe_dir(self.world, self.pos, f, i) for i in range(8)]

        threat = {"present": False, "bearing": None, "dist": None,
                  "hpFrac": None, "hurtTicks": self.hurt_ticks}
        best = float("inf")
        for e in self.entities:
            if e.kind != "hostile":
                continue
            d = math.dist(e.pos, self.pos)
            if d > 16 or d >= best:
                continue
            best = d
            threat["present"] = True
            threat["dist"] = d
            threat["bearing"] = bearing_index(e.pos[0] - self.pos[0], e.pos[2] - self.pos[2], f)
            threat["hpFrac"] = e.hp / e.max_hp

        goal = {"type": self.goal_kind, "dist": None, "visible": False,
                "targetClass": None, "bearing": None}
        if self.goal_kind == "flee":
            goal = flee_goal(threat)
        elif self.goal_kind == "goto":
            target = self._goal_pos()
            if target is not None:
                goal["dist"] = math.dist(target, self.pos)
                goal["visible"] = True
                x, y, z = target
                goal["bearing"] = bearing_index(x - self.pos[0], z - self.pos[2], f)
                goal["targetClass"] = terrain_of(surface_class(self._cell(x, y, z)),
                                                 surface_class(self._cell(x, y - 1, z)))

        return {
            "self": {
                "hp": self.hp,
                "food": self.food,
                "oxy": self.oxy,
                "on_ground": self.on_ground,
                "in_water": self.in_water,
                "in_lava": self.in_lava,
                "on_fire": self.on_fire,
                "sneaking": bool(self.prev_action.get("sneak")),
                "sprinting": bool(self.prev_action.get("sprint")),
                "blocking": False,
                "hurt_ticks": self.hurt_ticks,
            },
            "geom": geom,
            "threat": threat,
            "goal": goal,
            "prev": dict(self.prev_action),
        }

    def observe(self) -> List[str]:
        return encode_local(self._sense())

    def _goal_pos(self):
        if self.goal_kind != "goto":
            return None
        if not getattr(self, "_goto_target", None):
            ang = self.rng.random() * math.tau
            self._goto_target = (self.pos[0] + math.cos(ang) * 10.0, 64.0,
                                 self.pos[2] + math.sin(ang) * 10.0)
        return self._goto_target

    # ---------- 动力学 ----------

    def _apply_damage(self, amount: float, source: str) -> None:
        if amount <= 0 or self.dead:
            return
        self.hp -= amount
        self.hurt_ticks = 0.0
        self.damage_taken += amount
        self.last_damage_source = source
        if self.hp <= 0:
            self.hp = 0.0
            self.dead = True

    def _move_entities(self) -> None:
        for e in self.entities:
            if e.kind != "hostile":
                continue
            d = math.dist(e.pos, self.pos)
            if d > 16:
                continue
            if d > ATTACK_RANGE:
                dx = (self.pos[0] - e.pos[0]) / d
                dz = (self.pos[2] - e.pos[2]) / d
                nx = e.pos[0] + dx * ENTITY_SPEED
                nz = e.pos[2] + dz * ENTITY_SPEED
                if not self._solid(nx, e.pos[1], nz):
                    e.pos[0] = nx
                    e.pos[2] = nz
            e.attack_cd = max(0, e.attack_cd - 1)
            if d <= ATTACK_RANGE and e.attack_cd == 0:
                e.attack_cd = ATTACK_INTERVAL
                self._apply_damage(ATTACK_DAMAGE, "mob")

    def _player_attack(self) -> None:
        """动作里的 attack：在面前 3 格内找最近的敌对实体打。"""
        f = frame(self.yaw)
        best = None
        best_d = 3.0
        for e in self.entities:
            if e.kind != "hostile":
                continue
            d = math.dist(e.pos, self.pos)
            if d > best_d:
                continue
            side = (e.pos[0] - self.pos[0]) * f["rx"] + (e.pos[2] - self.pos[2]) * f["rz"]
            front = (e.pos[0] - self.pos[0]) * f["fx"] + (e.pos[2] - self.pos[2]) * f["fz"]
            # 大致朝前（允许 120 度扇形）
            if front <= 0 or abs(side) > max(1.0, front * 1.5):
                continue
            best = e
            best_d = d
        if best is not None:
            best.hp -= 4.0
            self.damage_dealt += 4.0
            if best.hp <= 0:
                self.entities.remove(best)

    def step(self, action: Dict[str, Any]) -> Tuple[List[str], float, bool, Dict[str, Any]]:
        """推进一步。action 是控制向量（见 coe/model.py 的头定义）。"""
        self.t += 1
        self.hurt_ticks += 1.0
        self.damage_taken = 0.0
        self.damage_dealt = 0.0
        self.last_damage_source = None

        prev_pos = list(self.pos)
        prev_dist = self._dist_to_goal()

        move = int(action.get("move", MOVE_NONE))
        sprint = bool(action.get("sprint"))
        jump = bool(action.get("jump"))
        sneak = bool(action.get("sneak"))
        attack = bool(action.get("attack"))
        yaw_delta = float(action.get("yaw_delta", 0.0))
        pitch_delta = float(action.get("pitch_delta", 0.0))

        self.yaw += yaw_delta
        self.prev_action = {"move": move, "sprint": sprint, "jump": jump,
                            "sneak": sneak, "shield": bool(action.get("shield")),
                            "attack": attack, "use": bool(action.get("use")),
                            "dig": bool(action.get("dig"))}

        # 视角增量让朝向跟着走（模拟真实客户端：走路时朝向不变，但策略可能主动转）
        # MC 里移动方向与朝向无关，所以这里只在策略给了 yaw_delta 时转。

        # --- 水平移动 ---
        if move != MOVE_NONE:
            d = DIRS[move]
            f = frame(self.yaw)
            vx = (f["rx"] * d[0] + f["fx"] * d[1])
            vz = (f["rz"] * d[0] + f["fz"] * d[1])
            norm = math.hypot(vx, vz)
            if norm > 0:
                vx /= norm
                vz /= norm
            speed = SPRINT_SPEED if sprint else WALK_SPEED
            if self.in_water:
                speed = SWIM_SPEED
            nx = self.pos[0] + vx * speed
            nz = self.pos[2] + vz * speed
            feet_y = math.floor(self.pos[1])
            blocked = self._solid(nx, feet_y, nz) or self._solid(nx, feet_y + 1, nz)
            if not blocked:
                self.pos[0] = nx
                self.pos[2] = nz

        # --- 跳跃与重力 ---
        if jump and self.on_ground:
            self.vy = 0.42
            self.on_ground = False
        self.vy = max(TERMINAL_VY, self.vy - GRAVITY)
        ny = self.pos[1] + self.vy
        ground = self._ground_y(self.pos[0], self.pos[2])
        if self.vy <= 0 and ground is not None and ny <= ground:
            fall = max(0.0, (self.pos[1] - ground))
            self.pos[1] = ground
            self.vy = 0.0
            if not self.on_ground:
                self.on_ground = True
                if fall > 3.0:
                    self._apply_damage(math.floor(fall - 3.0), "fall")
            else:
                self.on_ground = True
        else:
            self.pos[1] = ny
            self.on_ground = False

        # --- 环境状态 ---
        self.in_water, self.in_lava = self._surfaces()
        self.on_fire = self.in_lava
        if self.in_water:
            self.oxy = max(0.0, self.oxy - 0.5)
            if self.oxy <= 0 and self.t % DROWN_INTERVAL == 0:
                self._apply_damage(DROWN_DAMAGE, "drown")
        else:
            self.oxy = min(20.0, self.oxy + 1.0)
        if self.in_lava and self.t % LAVA_DAMAGE_INTERVAL == 0:
            self._apply_damage(LAVA_DAMAGE, "lava")
        if self.on_fire and self.t % FIRE_DAMAGE_INTERVAL == 0:
            self._apply_damage(FIRE_DAMAGE, "fire")
        self.food = max(0.0, self.food - 0.01)

        self._move_entities()
        if attack:
            self._player_attack()

        # --- 奖励 ---
        # 尺度很重要：目标进度信号必须和「活着的成本」「受伤的代价」可比，
        # 否则策略收到的梯度全是噪声（实测 0.5/Δ 的版本 400 episode 越训越差）。
        # 最大 Δ距离 ≈ 0.06 格/tick（疾跑甩开追兵），所以 5.0 的系数让好行为能拿到 +0.3/tick。
        reward = -0.05
        reward -= 1.0 * self.damage_taken
        new_dist = self._dist_to_goal()
        if prev_dist is not None and new_dist is not None:
            progress = new_dist - prev_dist if self.goal_kind == "flee" else prev_dist - new_dist
            reward += 5.0 * progress
        if self.damage_taken > 0:
            reward -= 0.5
        if self.dead:
            reward -= 10.0

        done = self.dead or self.t >= self.horizon
        info = {
            "damage": self.damage_taken,
            "damage_dealt": self.damage_dealt,
            "source": self.last_damage_source,
            "dist": new_dist,
            "dead": self.dead,
        }
        return self.observe(), reward, done, info

    def _dist_to_goal(self) -> Optional[float]:
        if self.goal_kind == "flee":
            best = None
            for e in self.entities:
                if e.kind != "hostile":
                    continue
                d = math.dist(e.pos, self.pos)
                if best is None or d < best:
                    best = d
            return min(16.0, best) if best is not None else None
        if self.goal_kind == "goto":
            t = self._goal_pos()
            return math.dist(t, self.pos) if t else None
        return None

    def reset(self) -> List[str]:
        self.t = 0
        self.pos = [0.0, 64.0, 0.0]
        self.vy = 0.0
        self.yaw = 0.0
        self.hp = 20.0
        self.food = 20.0
        self.oxy = 20.0
        self.on_ground = True
        self.in_water = False
        self.in_lava = False
        self.on_fire = False
        self.hurt_ticks = 99.0
        self.dead = False
        self.prev_action = {"move": MOVE_NONE, "sprint": False, "jump": False,
                            "sneak": False, "shield": False, "attack": False,
                            "use": False, "dig": False}
        self._goto_target = None
        self._build_world()
        self._build_entities()
        return self.observe()
