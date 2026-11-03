# Soundgineer — where it comes from and what we changed

**来源（C 机制，单一正源）**

| 项 | 值 |
|---|---|
| 仓库 | `github.com/patacoding/soundgineer`（fork，分支 `sp-integration`） |
| 依赖声明 | `app/web/package.json`：`"soundgineer": "github:patacoding/soundgineer#<sha>"` |
| 钉版本 | `app/web/package-lock.json` 里的 commit SHA（无需手工维护 pin 文件） |
| 构建源 | `node_modules/soundgineer/src`（由 `scripts/build-soundgineer.mjs` 打包进 `web/synth/vendor/`） |

**变更流程**：改 fork → 推 fork → 更新依赖 SHA（`npm install github:patacoding/soundgineer#<新 sha>`）→ 重建 → 跑探针
（`tools/soundgineer-probe/{link,editor}.mjs`）。**没有本地副本，也不需要同步脚本。**

**fork 里的 SP-EXT 改动**

| # | 文件 | 内容 |
|---|---|---|
| 1 | `src/audio/engine.ts` / 宿主接口 | 宿主钩子（参数表与引擎的对外接口） |
| 2 | `src/ui/presets.ts` | 用户预设**按引擎作用域**（`engine.__sgrScope`）存取：一个通道保存不再覆盖别的通道；旧条目无 scope 视为 `default`，不丢 |
| 3 | `src/ui/enveditor.ts` | ENV **图上直接拖**：9 个手柄（D/A/H/D/R 横向、sustain 纵向、A/D/R 曲线上下），全部经 `engine.setParam(index, normalized)` 写入 —— DSP / worklet / 参数注册表零改动 |

**构建自包含检查（与来源无关，仍然必要）**：`soundgineer-worklet.js` 必须**不含** `import` / `fetch` / `importScripts`，否则构建失败。

## SP-EXT: host-supplied factory presets, grouped by category (2026-10-10)

`node_modules/soundgineer/src/ui/presets.ts` and `ui/app.ts` carry four small additions, and the patched files are kept in
`engine-patches/` because node_modules is not ours to commit and `npm ci` would discard them:

1. a registry (`registerFactoryPresets`) for factory presets a host supplies, each with an optional `category`;
2. `refresh()` builds one `optgroup` per category from that registry, after the built-in `Factory` group;
3. the lookup in `load()` searches the registry as well as the built-ins -- without this, choosing a registered voice
   would silently do nothing;
4. `ui/app.ts` re-exports it, so a host can reach it from the same module it mounts the UI from.

To reapply after `npm ci` in `app/web`: `cp web/synth/engine-patches/*.ts node_modules/soundgineer/src/ui/ && node
scripts/build-soundgineer.mjs`. Upstream is pinned by SHA in `../VENDOR.json`; these belong in that fork's repository.
