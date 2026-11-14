"""验证反射训练的目标方向、重置和策略梯度。"""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), "..")))
from coe.tokens import World
from envs.mc_lite import MCEnv

try:
    import torch
except ModuleNotFoundError:
    torch = None


class SimulationTests(unittest.TestCase):
    def test_reset_keeps_configured_enemy_count(self):
        env = MCEnv(seed=2, n_entities=1)
        for _ in range(3):
            env.reset()
            self.assertEqual([100], [entity.id for entity in env.entities])

    def test_flee_rewards_increasing_distance(self):
        def take_step(move):
            env = MCEnv(seed=2, goal="flee")
            env.world = World(63, "stone", {})
            env.entities[0].pos = [0.0, 64.0, -8.0]
            return env.step({"move": move, "sprint": True})

        _, away, _, away_info = take_step(4)
        _, towards, _, towards_info = take_step(0)
        self.assertGreater(away_info["dist"], 8)
        self.assertLess(towards_info["dist"], 8)
        self.assertGreater(away, towards)


@unittest.skipIf(torch is None, "需要 PyTorch")
class PolicyTests(unittest.TestCase):
    def test_per_sample_log_probability_matches_distributions(self):
        from coe.model import CoEPolicy

        policy = CoEPolicy(hidden=8)
        for parameter in policy.parameters():
            parameter.data.zero_()
        ids = torch.zeros((2, 88), dtype=torch.long)
        actions, sampled = policy.act(ids, deterministic=True)
        logprob, entropy = policy.evaluate(ids, actions)
        expected = math.log(9 * 9 * 5) + 7 * math.log(2)
        torch.testing.assert_close(sampled, torch.full((2,), -expected))
        torch.testing.assert_close(logprob, sampled)
        torch.testing.assert_close(entropy, torch.full((2,), expected))
        (-logprob[0]).backward()
        self.assertTrue(torch.all(policy.head_bin.bias.grad > 0))


if __name__ == "__main__":
    unittest.main()
