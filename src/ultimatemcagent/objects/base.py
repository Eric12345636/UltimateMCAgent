from dataclasses import dataclass,field
from typing import Literal

@dataclass
class MinecraftObject:
    name: str
    description: str
    pos: tuple[float,float,float] | None

@dataclass
class Waypoint(MinecraftObject):
    pass