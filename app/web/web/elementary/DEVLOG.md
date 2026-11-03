# Elementary 开发备忘（2026-11-03）

> 与 `pattern/DEVLOG.md` 同性质：做成了什么 ✓、踩了什么坑 ✓、每个结论靠什么证据 ✓、还差什么 ✗。

## 1. 定位 ✓（用户定的）

```
Sonic Pi = 音序器 / 时钟（pattern、live_loop、小节）✓
Elementary = 【代码驱动的合成器】✓ —— 它自己不需要知道拍 ✓
两者之间走 MIDI ✓：Sonic Pi 的 midi_note_on/off 决定"什么时候响" ✓，Elementary 的代码决定"响成什么样" ✓
全局【只有一个】Elementary 实例 ✓ —— 多个音色在代码里实现 ✓，用 channel 区分 ✓
```

## 2. 架构（现在长什么样 ✓）

```
Sonic Pi 缓冲区
  └─ midi_note_on 60, channel: 1
       └─ 运行时 → app/src/main.js 的 midi hook（SP-EXT(elementary) ✓ 第 2 处 ✓）
            └─ window.sonicPiElementary.handleMidi({ path, args: [ch, note, vel] })
                 └─ el-bridge.js 的 8 声部池：找空闲声部（没有就抢最轻的）
                      └─ 声部图 = voice(note, velocity, channel, gate)   ← 玩家代码里的音色 ✓
                           └─ core.render(...) 重渲染 ⇒ core 按 key reconcile ✓ 声部身份不变 ✓
                                └─ node.connect(engine.node.input) ⇒ Sonic Pi 的 mix / with_fx / scope / Recorder ✓
                                     ↑ 前提：Sonic Pi 自己跑着一个 reader：
                                       synth :sound_in_stereo, sustain: 3600, amp: 1
                                       （照抄 web/synth/host.js:100 ✓ 起不来就退回 ctx.destination ✓ 至少能听见 ✓）
```

## 3. 界面 ✓

```
右侧竖排标签 él ✓ —— 与 Soundgineer 的 #synth-btn 同形同边（right:0 ✓ writing-mode:vertical-rl ✓ z-index 101 ✓ 26×65 ✓）
                          紧挨它下方（top: calc(50% + 12.6em) ✓）
可拖拽窗口 ✓ —— 拖拽/边界钳制的写法照 web/synth/window.js ✓ 位置存 localStorage ✓
CodeMirror 编辑器 ✓ —— JS 高亮 ✓ 62vh ✓ 可纵向拉伸 ✓
自动补全 ✓ —— el 的 103 个函数 ✓ 带签名 ✓ 直接插入【参数占位片段】✓（Tab 逐个跳 ✓）
Run / Stop ✓ Ctrl(Cmd)+Enter ✓
两种代码形态 ✓ —— A 档：函数体，结尾 return <node> ✓
                    B 档：export default { render(), getVirtualFileSystem(decodeAudioData)? } ✓（playground 形式 ✓）
                    voice(note, velocity, channel, gate) ✓ —— 定义 MIDI 音色 ✓
```

## 4. Elementary v4 的 API 真相（文档示例与实测不一致 ✗ —— 以实测为准 ✓）

| 写法 | 结果 |
|---|---|
| `el.cycle(440)` ✓ | 可以（数字 ✓）|
| `el.lowpass(cutoff, q, x)` ✓ | **位置参数** ✓（`el.lowpass({cutoff}, x)` ✗ 抛 "expecting a Node type" ✗）|
| `el.blepsaw(220)` / `el.blepsaw(node)` ✓ | 位置参数 ✓ |
| `el.metro({ key, period })` ✓ | 对象**必须带 key** ✓（`el.metro(2)` ✗）|
| `el.const({ key, value })` ✓ | **key 必填** ✓；不带 key 的 const 让下游全抛 ✗ |
| `el.sample({ key, path }, trigger)` | 采样走虚拟文件系统（未接 ✓）|
| `core.createRef("const", …)` ✗ | 实测抛 "expecting a Node type" ✗ ⇒ **不用它** ✓ |
| 更新参数的正确姿势 ✓ | `el.const({key, value})` + **重渲染** ✓（core 按 key reconcile ✓ 就是 playground 的做法 ✓）|

## 5. 踩过的坑（每条都记下修法 ✓ 不再重复 ✗）

| # | 坑 | 症状 | 修法 |
|---|---|---|---|
| 1 | 输出接 `engine.node.input` ✗ | **完全静音** ✓（那个输入只有 Sonic Pi 跑 `sound_in_stereo` 时才被读 ✗）| 起一个 reader ✓；起不来则退回 `ctx.destination` ✓ |
| 2 | 发布包直接在浏览器里 import ✗ | 裸模块名 + 两个 CJS 依赖 ⇒ 加载失败 ✗ | **esbuild 打包** ✓（bundle 已 gitignore ✓ 构建步骤里装 CM ✓）|
| 3 | Blob module 里 `import "/abs/path"` ✗ | `Invalid relative url or base scheme` ✗ | 用完整 URL ✓；后来又撞 CJS ✗ ⇒ 改成**全局注入 `el`** ✓ |
| 4 | 想挂 `code.html` ✗ | `code.html` 是 `build-site.mjs` **生成**的 ✗ 手改会被覆盖 ✗ | 挂在 `sonic_pi.js` 末尾 ✓（1 行 import ✓ SP-EXT(elementary) ✓）|
| 5 | 两级增益 ✗ | 声音≈0.04 ⇒ "极其小" ✗ | 桥里**不加增益** ✓ 音色代码自己决定电平 ✓ |
| 6 | 模板字符串里放反引号/`${}` ✗ | 打包失败 ✓ 产物还是旧的 ✗（两次 ✗）| 注释里别用反引号 ✓ 改完**必须**看 bundle 大小/重新打包 ✓ |
| 7 | 用"整段替换"改桥 ✗ | 把 `start()` `handleMidi()` 一起删掉 ✗ ⇒ `ReferenceError` ✗（两次 ✗）| 只对**唯一锚点**做小替换 ✓ 改完先 `import()` 检查载入 ✓ |
| 8 | 回退面板到旧提交 ✗ | 丢了 `globalThis.sonicPiElementary` ✗ ⇒ MIDI 找不到入口 ✗ | 回退后**逐条核对该有的行** ✓ |
| 9 | `el.const` 没有 key ✗ | 下游抛 "expecting a Node type" ✗ | 每个 const 都带 key ✓ |

## 6. 验证（可复跑 ✓）

```bash
node tools/pattern-p0/browser/assertions7.mjs sonic-pi/app/web/build/web
  PASS the panel opens / Run reports "1 channel out to Sonic Pi's input" / Stop silences
       highlighting (11 tokens) / dragging (94,20 → 134,45) / no page errors        → 7/7 ✓
```
另外用过的一次性探针（未入库 ✗，方法记在这里 ✓）：
```
· 面板能不能挂：读 .elem-btn/.elem-win/.cm-content 与 window.sonicPiElementary
· MIDI 能不能到：Sonic Pi 跑 live_loop + midi_note_on 60/64，读
                 window.sonicPiElementary.voices()  ⇒ 应出现 [60] / [64] ✓（实测通过 ✓）
```

## 7. 还没做 ✗

```
1 ✗ 采样音色：el.sample + Sonic Pi 的采样进虚拟文件系统（getVirtualFileSystem 已支持 ✓ 只是没灌数据 ✓）
2 ✗ 按通道分配多个音色：channel 已经传到 voice(…) ✓ 但默认代码只是"通道2换个波形"✓
     真正的多音色（每通道一套完整音色 + 预设）还没做 ✗
3 ✗ 响度：现在只能靠调代码里的 0.55 ✓ 没有 limiter/软削波 ✓ ⇒ 八声部齐响有削顶风险 ✗
4 ✗ 补全只覆盖 el.* ✓ —— 玩家自己定义的函数/变量没有补全 ✗
5 ✗ 踩拍：按用户决定**后置** ✓（当前设计上不需要 ✓ Sonic Pi 就是时钟 ✓）
```

## 8. 卸载（零残留 ✓）

```
1. 删 app/web/web/elementary/（含 vendor/ ✓）与构建里的 elementary 块（tools/build-for-cdn.sh ✓）
2. 回退 sonic_pi.js 里的 SP-EXT(elementary)（1 行 ✓）与 app/src/main.js 里那一处分派（1 处 ✓）
3. 重新 build ✓ —— 不存在其它侵入 ✓
```
