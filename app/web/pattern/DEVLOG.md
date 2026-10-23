# Web pattern 开发备忘（2026-10-22 ～ 10-23 这一轮）

> 这份是**开发过程**的实录 ✓ —— 做成了什么 ✓、踩了什么坑 ✓、每个结论**靠什么证据** ✓、哪些还没解决 ✗。
> 与 `STATUS.md`（现在的状态）配合读：状态看那份 ✓，过程与教训看这份 ✓。

---

## 1. 目标与边界 ✓

在 **web 版 Sonic Pi** 上，把桌面版的 **pattern 扩展**（类 Strudel 的时序语义）做成**外挂（bolt-on）**：

```
✗ 不改 Ruby 运行时源码 ✓ 不重建 wasm ✓ 不改引擎 ✓
✓ 自有命名空间 ✓ 自有文件 ✓ 可整体卸载 ✓
✓ 不靠 console.log 判断行为（用运行时的记录流 ✓）
✓ jank / 不稳定 = 缺陷 ✓（不是"可以接受"✗）
```

落地位置（用户明确要求 ✓，曾被我放错到 `web/synth/` 而被批 ✓）：

```
app/web/pattern/           源文件（prelude.rb, loader.js, pattern-boot.js, session-run.js, 文档）
app/web/scripts/build-pattern.mjs   构建：生成 web/pattern/*.js 并同步 build/web ✓
app/web/web/sonic_pi.js    只有 5 处 SP-EXT(pattern) 侵入（约 44 增 / 2 删）
app/web/web/data/*.json    两处数据（补全、参考页）
```

**卸载** = 删目录 + 回退那 5 处标记 + 重新生成两份 JSON ✓（`LEDGER.md` 有逐处清单 ✓）。

---

## 2. 最终形态（现在发布的是什么）✓

```
12 块装载（1 shim + 10 个库单元 + pattern-prelude）✓ 装载完成后 ready ✓ 才能 Run ✓
pattern-prelude 里：pplay / pstop / pdeclared + include 真正的 PampaPattern::Runtime ✓
  ⇒ 库是【逐字节复制】桌面版的 extensions/pattern/*.rb ✓ 没有第二套实现 ✓
ppattern / 39 个算子 / combine / 休止 ~ / Hash 参数 ⇒ 全部可用 ✓
```

### 调度（发布版）

**每轨一个线程 + 每轨自己的游标**（`pp_base += loop`）✗ —— 这是**不符合桌面模型**的那版 ✓（见 §5）✓，
但它在 Node 与真页面上都通过了现有全部判据 ✓：

```
位置 = pp_base + onset × cycle
交接 = 睡到 (事件时刻 − sched_ahead − 一个 tick) → 设虚拟时间 → send
换版 = 新起点取"下一小节线"且"旧版已交出的最后一拍之后" ✓ 旧版 stop_at = 新起点 ✓
     睡醒后【再判一次】stop_at ✓（这条是修掉撞拍的关键 ✓）
剪枝 = 程序里内联 pdeclared :begin / :end（同一个 job ✓ 不加额外 run ✓）
命名 = 无名轨按【本次 Run 的声明序号】→ pattern_1, pattern_2 ✓（跨 Run 稳定 ✓）
```

---

## 3. 这一轮修掉的 bug（按发现顺序 ✓ 每条都有证据 ✓）

| # | 症状 | 真因 | 怎么定位 | 修法 |
|---|---|---|---|---|
| 1 | `Unknown sample filter type: Object` | 休止 `~` 被当参数投递 | 真机报错 | 投递前 `next if value == REST` ✓ |
| 2 | "Run 的数量必须是正整数（给了 :end）" | 服务副本是**旧的**（仍调 `prun`） | 比对指纹 | 构建脚本改成**同步** `web/` 与 `build/web/` ✓ |
| 3 | `_sp_silence is not a function` | 这份 wasm 没导出 `sp_silence`（C 里有 ✓） | 真机报错 | 构建步骤补 shim：缺它则 `sp_stop_all` ✓ **立刻停声 = 已接受** ✓ |
| 4 | 换版撞拍 | 旧版提前交出的事件与新版本第一个**同拍** ✓ 引擎只留一个 | cue 探针：同一 spec 在 seq 3/4 各排一次 | 换版点取"旧版最后一拍之后的小节线" ✓ + 睡醒复查 ✓ |
| 5 | 无名轨调度乱 | 无名轨用**全局计数器** ⇒ 每次 Run 都换名字 ⇒ 旧轨不停 ✗ | 两次 Run 后轨数翻倍 ✓ | 改为本次 Run 的声明序号 ✓（`anonname` 用例钉住 ✓）|
| 6 | ticker 版同一小节发两次 | 时钟比较不足 ⇒ 同一小节线发布两次 ✗ | 写 cue 进记录流 ✓ 看 `bar:beat:seq` ✓ | 改为**小节号单调前进才发布** ✓ |
| 7 | 我自己的验证脚本**杀了你的浏览器** ✗ | 脚本里 `taskkill /IM chrome.exe /F` ✗ | 你报"看不见的进程在响" ✓ | 全部删除按名字杀 ✓ 只靠 `--mute-audio` ✓ |
| 8 | 生产页面 console.warn ✗ | shim 的提示语 ✓ | 你贴的日志 ✓ | 静音 ✓ 并把 shim 变成**构建步骤** ✓（否则重建就丢 ✗）|

---

## 4. 验证体系（这一轮最大的收获 ✓）

### 4.1 Node 层（快 ✓ 10 秒 ✓）

```bash
node tools/pattern-p0/harness.mjs       # 19 条：装载/时序/多轨/热更新/停止/变速/突变/soak/失败块/
                                        # 双会话/tick 成本/闸门/reload/loop 规则/loop 上限/combine/
                                        # 首事件/休止/无名轨
node tools/pattern-p0/operators.mjs     # 39 个算子 + 桌面 test-pattern-lib.rb（本运行时上跑通 ✓）
```

### 4.2 真页面层（这一轮新建 ✓ 以前完全没有 ✗）

```bash
node tools/pattern-p0/browser/assertions.mjs  dist/web   # Run 网格 ✓ Stop 静音 ✓ reload 相位 ✓
node tools/pattern-p0/browser/assertions2.mjs dist/web   # Run→Stop→Run ✓ 两条无名轨不翻倍 ✓
node tools/pattern-p0/browser/assertions3.mjs dist/web   # 你的程序结构（4 轨 ✓ 末轨无名）✓
node tools/pattern-p0/browser/assertions4.mjs dist/web   # loop_bars=2 + reload（相位不重置）✓
```

**做法**（零依赖 ✓ 本机没有 Linux 浏览器 ✗ 但 Windows 侧有 Chrome ✓）：

```
Node 自带 WebSocket ⇒ 直接讲 CDP ✓（tools/pattern-p0/browser/{serve,cdp}.mjs）
serve.mjs 发 COOP/COEP ✓（SAB 需要 ✓）
Chrome 必须 --mute-audio ✓ —— 验证绝不能出声 ✓
真点击用 CDP Input.dispatchMouseEvent ✓（el.click() 不是用户手势 ✗ 页面音频启动会拒 ✓）
```

**两个方向不对称**（花了时间才摸清 ✓ 记在 `browser/README.md`）：

```
WSL → Windows（CDP）   http://127.0.0.1:9333      ✓（WSL2 转发 loopback）
WSL → Windows          http://192.168.50.1:9333   ✗ 防火墙
Windows → WSL（页面）  http://127.0.0.1:<port>    ✓（WSL2 把 WSL 端口映射到 Windows localhost）
Windows → WSL          http://192.168.50.210:<port> ✗
```

**页面里几个关键事实**（都来自**读源码** ✓ 不是猜 ✗）：

```
Run 的真实路径   q("btn-run").addEventListener("click", Xa) → oi(ye.getCode(), { buffer: ye.active })
记录入口         sonicPi.session.recent 是【属性】（数组）✗ 不是方法
装载状态         sonicPi.session.pattern.state = { status:"ready", done:13, total:13, error:null } ✓
worker 消息      alive / ready / initialized / oscLog / reply / load / batch ✓
batch 字段       type,t0,heap,perf,running,records,table,started ✓
```

### 4.3 真页面实测数字 ✓（2026-10-23 ✓）

```
Run       notes 60,60,64,60  beats 2.25(接手音) / 4 / 6 / 8   网格音间隔恰好 2 拍 ✓
Stop      Stop 后 8 秒新增 synth = 0 ✓
Reload    Alt+Enter 后 beats 20,22,24 ✓（同网格 ✓ 接着走 ✓ 没回到 0 ✓）
Run→Stop→Run  第三轮 freshBeats 12,12,13,14,16,16,17,18 ✓
无名轨    names = pampa_pattern_1 / pampa_pattern_2 ✓ 无同拍重复 ✓
loop_bars=2 + reload  60 在 loop 线 ✓ 65 在 +4 拍 ✓（相位保持 ✓）
```

---

## 5. 还没解决的（不掩盖 ✗）

1. **ticker 机制没进发布版** ✗ —— 用户要的模型是"**一个全局 ticker + 每小节线通知所有 track + 每轨在回调里懒更新/自管生命周期**"✓
   （`docs/plan/pattern-track-model.md` 第 2、5 条 ✓）。ticker 版已实现到 **18/19** ✓，只剩 `looprule` 一条 ✗；
   发布版仍是**每轨游标** ✗（违反"位置是全局时间的函数"✗）。补丁：`pattern/EXPERIMENT-bar-ticker.patch` ✓
   下一步：用 cue 探针看 `bar:beat:seq` ✓ 确认"同一小节两个序号"是否真的消失 ✓ 再跑全量 ✓。
2. **长时间 soak（真页面 10 分钟以上）** ✗ 没测 ✓。
3. **真页面上的 tempo 变化 / combine / map** ✗ 只在 Node 测过 ✓。
4. **两个 Run 入口混用**（Run 按钮 group `BUFFER_GROUP+n` vs Alt+Enter group `0`）✗ 真页面没测 ✓。
5. **无名轨换顺序** ⇒ 旧轨残留 ✗（文档写了 ✓ 没测 ✓）。
6. **`map:` / `sync:` / `max_pending:`** ✗ 未实现（桌面也没有 ✓ 文档已标明 ✓）。
7. **wasm 版本落后** ✓ 已用 shim 解决 ✓；彻底解决需在**有 Emscripten 的机器**重建 ✓（本机 Docker 三个镜像源全被网络挡 ✗）。

---

## 6. 这一轮我犯的错（写下来防止再犯 ✗）

| 错误 | 后果 | 现在的规则 |
|---|---|---|
| 用 Node 里的 layer 通过 ⇒ 就宣称"页面可用" ✗ | 你一测就出问题 ✓ 反复多次 ✗ | 任何"可用"必须在**真页面**上有断言 ✓ |
| 拿**库**的查询结果当**投递**的证据 ✗ | 错判"首事件丢失"✗ 追了几轮 ✗ | 只看**记录流**（`kind:"synth"` ✓）✓ |
| 测量窗口**漏掉 run 内的记录** ✗ | 多次误判 ✗ | 取**全部**记录再过滤 ✓ |
| 一个 `console.warn` 留在生产 ✗ | 你贴日志 ✗ | 构建里不留提示语 ✓ |
| 脚本 `taskkill /IM chrome.exe` ✗ | **杀了你的浏览器** ✗ | 永不按名字杀进程 ✓；验证一律 `--mute-audio` ✓ |
| 断言过严 ⇒ 把**正确行为**判红 ✗ | "接手音"被当成错误 ✗ | 断言要写清"哪些音允许不在网格上" ✓ |
| 一次改多处 ✗ | 回退成本高 ✗ | 一次一处 ✓ 每处都有判据 ✓ |

---

## 7. 复现全部结论 ✓

```bash
cd sonic-pi/app/web
node scripts/build-pattern.mjs --check          # 服务副本是否最新 ✓

cd /home/pata/wsl_dev/sonicpidev
node tools/pattern-p0/harness.mjs               # 19/19 ✓
node tools/pattern-p0/operators.mjs             # 39/39 ✓
node tools/pattern-p0/browser/assertions.mjs  dist/web   # 3/3 ✓
node tools/pattern-p0/browser/assertions2.mjs dist/web   # 2/2 ✓
node tools/pattern-p0/browser/assertions3.mjs dist/web   # 2/2 ✓
node tools/pattern-p0/browser/assertions4.mjs dist/web   # 1/1 ✓
```

发布：`dist/web/`（66 MB ✓）—— 站点根 ✓ COOP/COEP ✓ `.wasm` → `application/wasm` ✓ `/pattern/`、`/data/` 用 no-store ✓

---

## 8. 结论

```
✓ 外挂成立：没有改运行时源码 ✓ 没有重建 wasm ✓ 可以整体卸载 ✓
✓ 两层验证：Node 19 条 + 真页面 8 条，全部可复跑 ✓
✓ 用户报过的三类问题（首 loop / 无名轨 / Stop）在真页面上都有断言并通过 ✓
✗ 用户描述的 ticker 机制仍是补丁状态（18/19）✗ —— 这是下一步唯一的结构性工作 ✓
```
