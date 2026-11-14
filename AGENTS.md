# AGENTS.md

## Workspace layout

- `mc-agent-api/` — the git repo (branch `main`). All code lives here; run every command from this directory.
- `p0/` — **not** a git repo. Training-side toolkit for the "train a model to make the decisions" project: state compressor + pointer layer (see `p0/README.md`).
- `p1/` — **not** a git repo. Training-side toolkit for the **CoE lower tier**: L-obs encoder, lite voxel sim, BC + RL trainers, ONNX export (see `p1/README.md`).
- `COE.md` — workspace-root design contract for the CoE architecture (LLM upper tier + trained lower tier). Read it before touching `mc-agent-api/src/coe/` or `p1/`.
- `agent-api-spec-dist.md` — workspace-root file, **outside** the repo. It is a published/distributed copy of the spec pointing at the live deployment (`https://mc-api.windywindie.top/api/v1`, skin site `https://skin.nmo.net.cn/`).
- The canonical in-repo spec is `mc-agent-api/docs/API.md` (generic, `http://<deploy>:18900/api/v1`). The two drift apart. **Authority is the upstream GitHub repo**, not either local copy: see 「硬约束：对外 API 与源站保持一致」below. `agent-api-spec-dist.md` is a published snapshot — leave it alone unless the user asks for a republish.

## 硬约束：对外 API 与源站保持一致（2026-11-13 起，最高优先级）

**权威源**：<https://github.com/Zyzzyva0381/mc-agent-api> 的 `main` 分支。本仓库任何一个对外 HTTP 接口，都必须与源站保持一致。

- **当前源站基线**：`2e7ae76`（v1.3.8，2026-11-14）。本仓库已同步上游 1.3.3–1.3.8（本地版本 v1.4.3：在 1.4.2 之上跟上 `/status` 的 `speed` / `velocity`、`/stop` 等到动作锁释放、重生和切维度后重新等世界到齐并返回 `not_ready`、桶按视线使用物品；`2e7ae76` 只补了 `speed` 为 null 的说明和真机测试坐标）；源站再前进时按下面的同步流程重复。
- **一致范围**：共享端点的路径、HTTP 方法、请求参数、响应字段、错误码、HTTP 状态码、字段语义、默认值语义，全部以源站 `docs/API.md` 为准，不得自行发明、删改或"顺手优化"。
- **同步流程**：动手前先用 `git ls-remote origin refs/heads/main` 对比基线；源站有新提交 → 先按源站同步（或明确记录"暂不跟进"及原因），再改本地代码。
- **本地扩展端点**（源站没有）：`POST /look`、`POST /controller/{attach,detach,submit,plan,state,telemetry,llm}` 保留现状——不删、不改形状、不新增同类；源站若新增端点，按源站跟进。
- **发布快照** `agent-api-spec-dist.md`：它是发给参赛者的发布副本（当前已按源站 v1.3.5 重新生成：29 个端点、含 `/control` 与 `/look`），**不是权威**；只有用户明确要求重新发布时，才按源站内容重新生成。
- **允许**：纯内部实现修复（例如 `collectDrops` 拾取更稳、`gather/mine` 规避出生保护），前提是对外可观察行为与源站一致。挖掘是否成功以服务端方块变化为准，这是源站 1.3.6 的行为，不是本地扩展。
- **每次交付前**：`git ls-remote` 确认源站 SHA；`npm run check` → `npm test` → `python p1/tests/test_golden.py`；若改动触及响应字段，额外做改动前后的 JSON 形状 diff。
- **若需求必须偏离源站**：停下来向用户说明并等待决定，不得擅自实现。

## Commands

| Command | Notes |
|---|---|
| `npm install` | No lockfile is committed. Deps are exact-pinned in `package.json` (mineflayer 4.39.0, mineflayer-pathfinder 2.4.5, minecraft-data 3.117.0, vec3 0.1.10). `onnxruntime-node` is an **optionalDependency** (only needed for `coe.policy: "onnx"`). |
| `npm start` | `node src/index.js config.json`. Needs a `config.json` (gitignored) — copy `config.example.json`. |
| `npm run compete` | `node src/competition/index.js`. Public HTTP API only. See `docs/COMPETITION.md`. Default scoring file is the workspace-root `RULES.md`, not `mc-agent-api/docs/RULES.md`, unless the config sets `rules` (path relative to the config file). |
| `npm run check` | Syntax check over every `src/**/*.js`. Runs without `npm install` (node builtins only) and must be run from the repo root (hardcoded relative `src` path). |
| `npm test` | `node --test test/coe.test.js test/competition.test.js` — offline unit tests (CoE 纯逻辑 + 赛事运行器). No server needed. |
| `npm run build:local-vocab` | Regenerates `src/coe/local-vocab.json` from `src/coe/local.js`. |
| `node src/coe/build-golden.js` | Regenerates `p1/data/golden_local.json` (the train/runtime encoding contract). |
| `python p1/tests/test_golden.py` | Asserts the Python encoder matches the Node encoder token-for-token. Must pass after any L-obs change. |
| `python p1/train_rl.py` / `train_bc.py` | Lower-tier training (see `p1/README.md`). |
| `npm test` (p0) | `node --test` **from `p0/`** — do not use `node --test test/`, that form breaks on this Node build. |

Config path precedence: CLI arg → `MC_AGENT_CONFIG` env → `./config.json`. `MC_AGENT_PORT` overrides `http.port`. `config.baseDir` is the config file's directory — custom adapter `module` paths resolve against it, not the cwd.

## Tests: real-server acceptance only

`test/live_test.py` is the only live test suite (38 `@test` cases). It drives the bot over HTTP and sets up the world through RCON.

```bash
export MC_AGENT_API=http://127.0.0.1:18900/api/v1 MC_AGENT_USER=Agent_1 MC_AGENT_PASSWORD=change-me
export RCON_HOST=127.0.0.1 RCON_PORT=25575 RCON_PASSWORD=...
python test/live_test.py all      # `python3` is NOT on PATH on this machine, use `python`
python test/live_test.py boat     # single case; names are the @test("...") strings in test/live_test.py
```

- **Destructive**: fills blocks, kills entities, changes difficulty/weather/time, and builds a platform around `(-4..60, 94..110, -4..62)`. Only run it against a dedicated test server, never a real world.
- `all` runs every registered case except the diagnostic names `probe` and `diag`. `entity_push` is part of that suite: it summons a cow, teleports the player, and kills the cow. |
- The password may come from a `.agent-password` file next to the script instead of the env var.
- There is **no offline/mock mode**. Runtime behavior cannot be verified without a live Minecraft server; for logic-only edits, verify by reading plus `npm run check`.

## Architecture

- `src/index.js` — entrypoint: load config → build auth provider + readiness factory → configure core + http → listen.
- `src/http.js` — routing, bearer token, login rate limiting, the global action lock, `stop_on`. No business logic.
- `src/session.js` (~3100 lines) — the `Session` class (bot lifecycle, event bus, protocol patches) plus the `api` map (one function per endpoint) and the `READONLY` set.
- `src/blocks.js` — `isExposed`. `find_blocks` and skill block search only return exposed blocks. The LLM survey (`surveyBlocks`) does not use that filter, or buried logs and stone disappear from the prompt.
- `src/coe/` — in-process lower tier (controller, L-obs, skills, recorder). See `COE.md`.
- `src/competition/` — preliminary-round runner. It speaks the published HTTP API only; it does not touch `session.bot`.
- `src/auth/{index,offline,yggdrasil}.js`, `src/readiness/{index,direct,proxy}.js` — pluggable adapters chosen by config `type` or a custom `module` path.

### Endpoint wiring (easy to get wrong)

- Route → api key is `path.replace('/', '_')` (first `/` only): `window/view` → `window_view`, `window/act` → `window_act`.
- An observation endpoint **must** be added to `READONLY` in `session.js`, otherwise it grabs the global action lock. `window_view`/`window_act` are deliberately *not* read-only (they walk and open GUIs).
- The CoE endpoints (`controller_*`) **are** in `READONLY` — the lock is owned by the controller itself (`session.busy.owner === 'controller'`), not by the HTTP layer. `api.controller_submit` checks `session.busy` itself.
- Errors: `fail(code, message, extra)` / `ApiError`. Business failures return **HTTP 200** with `{ok:false,error:{code,message,...extra}}`. Only 400 (bad JSON), 401 (auth), 404 (unknown route), 429 (rate limit) are non-200. Success is `{ok:true, ms, result}`.
- Args are query params merged with the JSON body, body wins on conflict. `pos:[x,y,z]` is auto-expanded to `x`/`y`/`z` when `x` is absent.
- Non-readonly endpoints are gated by: readiness (`wrong_server`), liveness (`dead`), action lock (`busy`), and a `stop_on` list defaulting to `['hurt','death']` (`['death']` for `attack`/`shoot`).
- `Session.isReady()` is `bot && worldReady && readiness.isReady()`. `worldReady` flips after chunks load (cap 8 s) and then 600 ms with no new `entitySpawn` (cap another 3 s). `login` and `respawn` (death respawn and dimension change) invalidate the wait. Until then, if the bot is already on the target server, actions return `not_ready`; otherwise `wrong_server`. `get_entities` may still be empty. Do not drop `worldReady` back to "adapter says ready".
- Interruption: if the action produced partial results it still returns `ok:true` with `result.interrupted_by`; otherwise `error.code` is `interrupted` (or `dead`), with `inner_code` preserving the original error code and its extra fields.
- API changes must update `docs/API.md` (endpoint docs, error-code table, version-history table) and `README.md` if config keys changed. **对外接口的权威是源站**（见「硬约束：对外 API 与源站保持一致」）：`docs/API.md` 只负责如实镜像源站与本地扩展，不能凭空发明接口。

### CoE lower tier (easy to get wrong)

- **Two different observation encodings.** The LLM tier uses p0's compressed observation; the lower tier uses `src/coe/local.js` (L-obs, 88 tokens). Never feed one to the other — that is observation aliasing.
- **The encoding has one source of truth**: `src/coe/local.js` (Node). `p1/coe/tokens.py` must match it token-for-token; `p1/data/golden_local.json` (generated by `node src/coe/build-golden.js`) is what enforces it. Change one side → regenerate the golden file → run `python p1/tests/test_golden.py`.
- **The action lock now has an owner**: `session.busy = { name, t, owner }` where owner is `'http'` or `'controller'`. The reflex loop yields while an HTTP action drives the bot, and vice versa. Two drivers pressing keys at once will fight.
- **The reflex loop must never call the LLM and never make HTTP requests.** Its whole input is the in-process `bot` object. A reflex path that waits on the LLM is not a reflex path.
- **The controller runs in-process** via `require('mc-agent-api/src/session').sessions` — it needs `session.bot` directly, not the HTTP API.
- **BC pairing is off by one**: pathfinder computes the action, then the physics tick moves the bot. The recorder must pair `action_t` with `obs_{t-1}`.

### mineflayer / 1.21.11 protocol quirks (do not "simplify" these away)

- **Outbound packet guard** (`Session.connect()`): protodef does not error on unknown packet names — it silently emits a bodiless frame that the server decodes as `accept_teleportation` and kicks the bot. The `_client.write` wrapper drops any name absent from `minecraft-data`'s `play.toServer` mapper. Keep it.
- `teleport_confirm` is only sent with an integer id ≥ 0 (Velocity's play → configuration → play transition leaks a position event with no teleportId).
- `player_command` no longer exists in 1.21.9+, so `dismount` goes through `player_input` shift instead.
- 1.21.11: `set_passengers` is authoritative for seat state; mineflayer 4.39 never clears `bot.vehicle`, so the code syncs it by hand (otherwise `dismount` reports "still riding" forever).
- Physics stays disabled until chunks load — otherwise the bot falls into the void right after spawn.
- Spawn watchdog (4 s after `spawn`) emits a **relative-zero** `position` (`x/y/z` flags true, coordinates 0) so mineflayer does not clear velocity. An absolute position eats knockback, jumps, and falls that land on that tick.
- `/dig` succeeds only when a server `block_change` or `multi_block_change` updates that cell (`watchServerBlock`). mineflayer predicts air and does not roll it back. No server update → restore the local block and return `dig_unconfirmed` with `pos`, `eye_dist`, `on_ground`, `ping_ms`. The server echoing the old state is `protected_region` with the same extras. `dig_ms` includes the confirm wait.
- Entity push is client-side and missing from prismarine-physics. The `physicsTick` handler shoves the bot out of overlapping living entities, boats, and minecarts. Leave it; the CoE reflex loop does not write `velocity`.
- `attackIntervalMs`: empty hand and non-tools are 250 ms. Axes, hoes, and the mace vary by item (`wooden_axe` 1250, `iron_axe` 1111, `stone_hoe` 500, `diamond_hoe` 250, `mace` 1667). The old 500 ms fallback for "anything else" is the 1.3.5 bug.
- `/status` reads `(foodSaturation || 0)`. A missing saturation used to throw `internal` right after join.
- `/status` `speed` and `velocity` come from `src/motion.js`: actual per-tick displacement, not `entity.velocity` (that value is post-friction and keeps a gravity term while standing). A displacement longer than 10 blocks (teleport or respawn), and riding, report `null`. `forcedMove`, `mount`, `dismount`, and `respawn` reset the tracker.
- Buckets (`/bucket$/` except `milk_bucket`) go through `useBucket`: `activateItem` plus a view raycast. An empty bucket needs `pos` to be the liquid source. A full bucket places on the face toward the eye, or on the block below an air cell.
- `/stop` sets `interruptedBy` to `stop`, clears pathfinder, digging, and controls, and waits until that action lock is released (cap 5 s). The response includes `action`, `released`, and `wait_ms`. A partial result stays `ok: true` with `interrupted_by: "stop"`.
- Resource packs are auto-answered (results 3, 4, 0).
- `readiness.proxy`: backend RCON `list` is the authoritative "am I on the backend" signal. Advancement-tree size alone is unreliable because backends deliver the tree in chunks.

### Behavior worth not breaking

- One bot per character: logging in with the same `profile.id` destroys the previous session.
- `hardReconnect` is rate-limited: at most once per 60 s, at most 5 times per session.
- Death-loop protection: 3 deaths within 60 s → the bot quits and enters a 5-minute cooldown.
- `/chat` rejects messages starting with `/` (commands are not allowed), messages over 100 chars, and more than 1 message/second.
- `/events` returns the **oldest** N events after `since` so polling with `last_seq` never skips events.

## Style

- CommonJS, no semicolons, 2-space indent, `'use strict'` at the top of each file.
- Comments and log messages are written in Chinese — keep them that way.
- No lint or format tooling exists; match the surrounding style by hand and run `npm run check` before finishing.

## `p0/` — training-side state layer

- **Zero dependencies, zero install.** Run `node --test` from `p0/` (not `node --test test/` — that form breaks on this Node build). Do not add npm deps without a reason.
- **Offline by design.** Nothing here may require a Minecraft server; the acceptance test is the fixture round-trip, not a live run.
- `data/vocab.json` is generated by `tools/build-vocab.js` from `minecraft-data` 1.21.11 and **is committed**. Regenerating needs `minecraft-data` resolvable from `p0/node_modules` or `../mc-agent-api/node_modules`, or `$MC_DATA_PATH`.
- `fixtures/scenarios.json` shapes are copied from `mc-agent-api/docs/API.md` response examples. If the API response shape changes, update the fixtures too.
- The pointer grammar's core invariant: **`dig`/`place`/`interact` targets must be visible candidates** (`b<i>`), while **destinations may be literal** (`p`/`px`). `verbs.js`'s `literalOk` encodes that distinction — don't collapse it.
- `move_to` with `y` omitted means "XZ only" and must serialize as `px`, never as a block pointer (a block pointer implies a y). This is a semantics difference, not a formatting one.
- `posture` is full-set semantics: only `true` flags are emitted, and comparison goes through `normalizeBody`.

