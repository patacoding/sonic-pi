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
