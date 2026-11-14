"""黄金向量回归测试。

Node 侧（mc-agent-api/src/coe/local.js）是 L-obs 编码的真值。
这里用黄金向量逐 token 比对，确保 Python 侧没有跑偏。

跑法（从 p1/ 目录）：
    python -m pytest tests/ -q
或不用 pytest：
    python tests/test_golden.py
"""

import os
import sys

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))

from coe.tokens import encode_local, load_golden, load_vocab, sense_from_world, token_ids  # noqa: E402


def _golden_cases():
    return load_golden()["cases"]


def test_each_case_matches():
    """每个场景：Python 重新编码 → 必须与 Node 生成的 token 完全一致。"""
    bad = []
    for case in _golden_cases():
        sense = sense_from_world(case["world"], case.get("entity"),
                                 case.get("entities"), case.get("goal"))
        got = encode_local(sense)
        if got != case["obs"]:
            diff = []
            for i in range(max(len(got), len(case["obs"]))):
                a = got[i] if i < len(got) else None
                b = case["obs"][i] if i < len(case["obs"]) else None
                if a != b:
                    diff.append("  #%d python=%r node=%r" % (i, a, b))
            bad.append("场景 %s 不一致：\n%s" % (case["name"], "\n".join(diff[:8])))
    assert not bad, "\n".join(bad)


def test_token_count_stable():
    """编码长度固定，方便按定长批次训练。"""
    for case in _golden_cases():
        assert len(case["obs"]) == 88, "场景 %s 的 token 数变了：%d" % (case["name"], len(case["obs"]))


def test_vocab_covers_all_tokens():
    vocab = set(load_vocab())
    for case in _golden_cases():
        for t in case["obs"]:
            assert t in vocab, "场景 %s 里的 token %r 不在词表里" % (case["name"], t)


def test_ids_roundtrip():
    vocab = load_vocab()
    for case in _golden_cases():
        ids = token_ids(case["obs"], vocab)
        assert len(ids) == len(case["obs"])
        assert all(0 <= i < len(vocab) for i in ids)


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("OK   %s" % name)
            except AssertionError as e:
                failures += 1
                print("FAIL %s\n%s" % (name, e))
    print("\n%s" % ("全部通过" if failures == 0 else "%d 个用例失败" % failures))
    sys.exit(1 if failures else 0)
