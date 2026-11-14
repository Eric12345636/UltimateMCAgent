"""
subgoals: move_to, attack, mine, place, use, craft, etc.
atom_actions: 
"""
from .decider import Decider
class DecisionsManager:
    def __init__(self) -> None:
        self.action_chooser = Decider('',{
            "action": {
                "type": "choice",
                "instructions": "Which action should the Minecraft player take?",
                "criteria": {
                    "move_to": "Go to another place",
                    "attack": "Attack an entity until its death",
                    "mine": "Mine a block",
                    "place": "Place a block",
                    "use": "Use current item held",
                    "craft": "Craft an item in crafting table",
                }
            }
        })