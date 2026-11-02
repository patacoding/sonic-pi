# 时序语义扩展：运行时的用户动词（P3）
#
# 安装方式（**用户空间，零上游改动** ✓ —— 见 docs/plan/pattern-extension-architecture.md §2）：
#
#   1. 把本文件与 pattern-lib.rb / delivery.rb 放到某个目录（比如 ~/.sonic-pi/config/pattern/）
#   2. 在用户目录的 config/init.rb 里加两行：
#        require "/绝对路径/pattern-lib.rb"
#        require "/绝对路径/delivery.rb"
#        require "/绝对路径/runtime.rb"
#        SonicPi::Lang::Core.include(PampaPattern::Runtime)
#   3. 重启 Sonic Pi
#
# **卸载 = 删掉这三行** ✓（不动上游一行 ✓、不需重新编译 ✓）。
#
# 动词表（`p` 前缀，见架构文档 §2.4 的命名纪律 ✓）：
#
#   pquery(pattern, from, to)      查询，**不发声** ✓
#   pplay(pattern, ...)            播放，投递给 Sonic Pi 的动词 ✓
#   pstop(name = nil)              停止（指定名字或全部）✓
#
# ⚠️ **本文件的地基**：投递给**现成动词**（`play`/`sample`/`midi_*`/`osc_send`）✓，
# 绝不直发 OSC ✗ —— 理由见 delivery.rb 顶部的长注释 ✓。
#
# ⚠️ `timeout` 是 **Ruby 自带库** ✓，但**显式 require** 更稳 ✓（`pplay` 的"起跑握手"
# 用它做超时 ✓ —— 见那里的说明 ✓；没有它就会 `NameError` ✗）。
require 'timeout'

module PampaPattern
  module Runtime
    # ── 内部状态：正在跑的播放器 ──────────────────────────────────────────────────────────
    #
    # ⚠️ **必须是"真全局"，不能是实例变量** ✗ —— 这是一条**实测出来的架构约束** ✓：
    #
    #   架构要求 ✓：**生产者（模式）是全局的** ✓、消费时**无缝衔接现有机制** ✓、
    #   而且**消费方可以是 play / sample / midi / osc / 合成器参数 / VST 参数** ✓。
    #
    #   而 Sonic Pi 的 buffer 是「**每次运行 = 新线程 + 新 binding**」✓
    #   （见 `docs/plan/pattern-scope-architecture.md` §1.2 ✓）——
    #   `SonicPi::Lang::Core.include(PampaPattern::Runtime)` 之后 ✓，
    #   **这些方法被 extend 到每个求值对象上** ✓，于是里面的 `@ivar` **落在那个对象上** ✗
    #   → **每个 buffer 各有一张注册表** ✗ → `pstop` **跨 buffer 停不到** ✗。
    #
    #   这是**测出来的** ✓（`tools/pattern-probe/test-global-registry.rb` ✓）：
    #   两个"buffer"对象看到的是**两个不同的 Hash** ✗。
    #
    # **所以注册表放在"所有 buffer 都能看到的同一处"** ✓ ——
    # **一个真正的全局变量** ✓（`$` 开头 ✓，进程内唯一 ✓）。
    # ⚠️ 名字带 `pampa_` 前缀 ✓，避免与用户 / 上游的全局变量撞 ✓。
    #
    # ⚠️ **它也是 `pstop` 能跨 buffer 的前提** ✓ —— 那正是"全局"这件事的**可观测后果** ✓。
    PLAYERS_KEY = :$pampa_pattern_players
    def __pplayers
      # ⚠️ **写入也要线程安全** ✗：`pplay` 的注册是两步 ✓（`pstop(name)` + 赋值 ✓）——
      # 两个 buffer 同时 `pplay` 时理论上会交错 ✓。加一把锁把"读改写"包起来 ✓。
      $pampa_pattern_players ||= {}
      $pampa_pattern_players
    end

    # 注册表的那把锁 ✓（进程内唯一 ✓ —— 与注册表同一个道理 ✓）
    def __pplayers_mutex
      $pampa_pattern_players_mutex ||= Mutex.new
    end

    # ── 构造：**唯一入口** ✓（规格 §6.2）──────────────────────────────────────────────────
    #
    #   ppattern "bd [~ sd] hh*2 cp"    ← mini-notation 字符串 ✓
    #   ppattern [60, 62, 64]           ← 数组（平分一圈）✓
    #   ppattern(已是 Pattern)          ← 原样返回（便于链式）✓
    #
    # ⚠️ 这个函数**是必须的** ✓ —— 第一版漏了它 ✗，注入的代码一跑就报
    # `Sonic Pi doesn't know a function called 'ppattern'` ✓（引擎的报错很帮忙，直接点名 ✓）。
    # 教训：**规格里列出的动词一个都不能少** ✗ —— 否则用户写的第一个字就用不了 ✗。
    # 一组字面值当**一个**值（和弦 / vec3 那种）
    #
    #   `ppattern([pval(57, 60, 64)])`                # → 1 个事件、值是 [57,60,64]
    #   `ppattern([pval(57,60,64), pval(60,64,72)])`  # → 2 个事件（和弦演进）
    def pval(*vals)
      raise ArgumentError, 'pval 至少要一个值' if vals.empty?
      PVal.new(vals)
    end

    # 造一条轨：**数组 = 节奏树**（嵌套 = 细分；nil / "~" 休止；pval 多值；字符串 = 一个事件的值）
    #
    #   ppattern(["c2", "e2", "g2"])            # 3 个事件（均分一圈）
    #   ppattern([["bd","sd"], "hh"])           # 前半圈两个、后半圈一个（嵌套 = 细分）
    #   ppattern(["bd", "~", "sd", nil])        # 4 个位置，2 个休止
    #   ppattern([pval(57, 60, 64)])            # 1 个事件，值是一组数
    #   ppattern("c2")                          # 1 个事件（字符串里有空白/记号会报错）
    def ppattern(spec, cycle_beats: nil, __keep_rests: false)
      # ⚠️ **`cycle_beats:` 只挂一个标记** ✓（不改事件 ✗）
      # 优先级：`pplay(cycle_beats:)` > 这里 > `set :pampa_cycle_beats` > 4.0 ✓
      if cycle_beats && !cycle_beats.is_a?(Numeric)
        raise ArgumentError, "`cycle_beats:` 要数字（收到 #{cycle_beats.inspect}）"
      end
      PampaPattern.normalize_cycle_beats(cycle_beats, 'ppattern 的 cycle_beats:') if cycle_beats

      pat = case spec
            when Pattern then spec
            when Array   then __ptree(spec)
            when PVal
              _pv = spec
              Pattern.new { |b, e| [Hap.new(0r..1r, b..e, _pv)] }
            when String
              # ⚠️⚠️ **字符串 = 一个事件的值** ✓（2026-10-21 API 切换 ✓）
              #
              #   以前字符串是**整条轨**（mini 语法 ✓：`"c2 e2 g2"` = 3 个事件 ✗）。
              #   现在 ✗：字符串就是**一个值** ✓ → 要整条轨请写**数组** ✓。
              #
              #   ⚠️ **安全检查** ✓：字符串里出现空白 / mini 记号时**报错** ✓
              #     （否则旧代码会**静默变成 1 个事件** ✗ —— 那种错最难查 ✗）。
              if spec =~ /\s/ || spec =~ /[~*<>\[\],]/
                raise ArgumentError,
                      "字符串只表示**一个事件的值** ✗（收到 #{spec.inspect}）。" \
                      '整条轨请写**数组**：`ppattern(["c2", "e2", "g2"])` ✓；' \
                      '休止用 `"~"` 或 `nil` ✓；细分用**嵌套**：`ppattern([["c2","e2"], "g2"])` ✓'
              end
              _s = spec
              Pattern.new { |b, e| [Hap.new(0r..1r, b..e, _s)] }
            when Hash
              # 每事件多参数 ✓：键 = 参数名 ✓、值 = 一层 ✓
              layers = {}
              spec.each do |k, v|
                key = k.is_a?(Symbol) ? k : (k.respond_to?(:to_sym) ? k.to_sym : nil)
                raise ArgumentError, "ppattern({…}) 的键要是符号或字符串（收到 #{k.inspect}）" if key.nil?
                if v.is_a?(Hash)
                  raise ArgumentError,
                        "ppattern({…}) 不允许嵌套：层 #{key.inspect} 里又放了 Hash。请把键摊平"
                end
                layers[key] = ppattern(v, __keep_rests: true)
              end
              Combine.build(layers, outer_cycle_beats: cycle_beats)
            else
              raise ArgumentError, "ppattern 需要数组、字符串、Hash、PVal 或 Pattern，收到 #{spec.class}"
            end

      pat.pampa_cycle_beats = cycle_beats if cycle_beats
      pat
    end

    # ⚠️⚠️ **数组 = 节奏树** ✓（2026-10-21 ✓）
    #
    #   * N 个元素 → 这一段**等分**成 N 份 ✓
    #   * **嵌套 = 细分** ✓：`[["bd","sd"], "hh"]` → 前半拍两个 ✓、后半拍一个 ✓
    #     （与旧 mini 的 `"[bd sd] hh"` **逐拍相同** ✓，实测过 ✓）
    #   * `nil` / `"~"` → 休止 ✓（**占位置** ✓、不发声 ✓）
    #   * `pval(...)` → **一个**事件，值是一组数 ✓（和弦 / vec3 ✓）
    #   * 其余元素 → 原样当值 ✓（**不解析** mini ✗ —— 写了 `*2` / `< >` / `[ ]` 就报错 ✓）
    def __ptree(spec, lo = 0r, hi = 1r, out = [])
      raise ArgumentError, 'ppattern 的数组不能为空' if spec.empty?
      w = (hi - lo) / spec.size
      spec.each_with_index do |el, i|
        a = lo + w * i
        b = a + w
        case el
        when Array
          __ptree(el, a, b, out)
        when Hash
          raise ArgumentError,
                'ppattern 的数组元素不能是 Hash ✗ —— Ruby 里 `{57, 60, 64}` 是 `{57=>nil, 60=>nil, 64=>nil}` ✅，' \
                '而 `{ }` 在本 API 里表示**每事件多参数** ✅。和弦请用 `pchord(ppattern(["45:minor", "41:major"]))` ✓；' \
                '一组字面值当**一个**值用 `pval(57, 60, 64)` ✓'
        when PVal
          out << [a...b, el]
        when String
          if el.strip == '~'               # 休止 —— 占位置、不发声
            out << [a...b, Mini::REST]
            next
          end
          if el =~ /\*\s*\d+\z/ || el =~ /[<>\[\]]/
            raise ArgumentError,
                  "ppattern 的数组元素是**字面值** ✗ —— #{el.inspect} 看起来是 mini 写法 ✅。" \
                  '数组元素不解析 mini ✗：要重复写 `["hh"] * 8` ✓（乘法作用在**数组**上 ✓，不是 `["hh" * 8]` ✗）；' \
                  '要细分用**嵌套**：`[["a","b"], "c"]` ✓'
          end
          out << [a...b, el]
        when nil
          out << [a...b, Mini::REST]       # 休止 —— 占位置、不发声
        else
          out << [a...b, el]
        end
      end
      return out unless lo.zero? && hi == 1r   # 递归中 ✓
      # 顶层：包成 Pattern ✓（每圈重复 ✓）
      frags = out
      Pattern.new do |b, e|
        res = []
        last = e.ceil - 1
        (b.floor..last).each do |c|
          frags.each do |span, val|
            ws = c + span.begin
            we = c + span.end
            pb = [ws, b].max
            pe = [we, e].min
            next unless pb < pe
            res << Hap.new(ws..we, pb..pe, val)
          end
        end
        res.sort_by { |h| [h.part.begin, h.whole.begin] }
      end
    end

    # ── 连续信号（第三阶段 ✓）──────────────────────────────────────────────────────────────
    #
    # ⚠️ **直接 `pplay` 一个信号，听不出连续变化** ✗ —— 这不是缺陷 ✓，是语义的必然结果 ✓：
    # 信号的值**依赖于查询窗** ✓，而驱动器用**固定长度**的窗 ✓ → 每窗得到一个常量 ✓。
    # 要"听出在变化"必须**显式离散化** ✓：`psegment(信号, 每圈几份)` ✓。
    #（见 docs/plan/pattern-signal-spec.md §2 与 §6 ✓）
    #
    # ⚠️ 值域一律 **`[0,1]` 单极** ✓（照上游 ✓）—— 所以 `prange` 才给出合理范围 ✓。
    # 若信号是双极的 ✗，`prange(psine,200,2000)` 会给 **−1600** ✓（实测过 ✓）且**不报错** ✗。
    def psine     = SignalPattern.new(->(t) { Signal.sine(t) })
    def psaw      = SignalPattern.new(->(t) { Signal.saw(t) })
    def psquare   = SignalPattern.new(->(t) { Signal.square(t) })
    def ptriangle = SignalPattern.new(->(t) { Signal.triangle(t) })

    # `prand`：**每圈一个**随机数 ✓（圈内恒定 ✓）—— 与 `pnoise` 的区别要写清 ✓
    def prand     = SignalPattern.new(->(t) { Signal.prand(t) })
    # `pnoise`：**连续**随机 ✓（任意时刻不同 ✓）
    def pnoise    = SignalPattern.new(->(t) { Signal.pnoise(t) })

    # `prange(信号, lo, hi)`：把 `[0,1]` 映到 `[lo, hi]` ✓ —— **最常用的一个** ✓
    def prange(sig, lo, hi)
      raise ArgumentError, "prange 的第一个参数必须是信号（收到 #{sig.class}）" unless sig.is_a?(SignalPattern)
      sig.map_signal { |v| Signal.range(v, lo, hi) }
    end

    def poffset(sig, d)
      raise ArgumentError, "poffset 的第一个参数必须是信号（收到 #{sig.class}）" unless sig.is_a?(SignalPattern)
      sig.map_signal { |v| Signal.offset(v, d) }
    end

    def pscale(sig, k)
      raise ArgumentError, "pscale 的第一个参数必须是信号（收到 #{sig.class}）" unless sig.is_a?(SignalPattern)
      sig.map_signal { |v| Signal.scale(v, k) }
    end

    # `padd(a, b)`：信号 + 信号 / 常量 ✓（本阶段只做加法 ✓，够用且好验 ✓）
    def padd(a, b)
      unless a.is_a?(SignalPattern) || b.is_a?(SignalPattern)
        raise ArgumentError, "padd 至少要有一个信号（收到 #{a.class} 与 #{b.class}）"
      end
      if a.is_a?(SignalPattern) && b.is_a?(SignalPattern)
        SignalPattern.new(->(t) { Signal.add(a.fn.call(t), b.fn.call(t)) })
      elsif a.is_a?(SignalPattern)
        a.map_signal { |v| Signal.add(v, b) }
      else
        b.map_signal { |v| Signal.add(a, v) }
      end
    end

    # `psegment(信号, n)`：**离散化** ✓ —— 每圈分成 n 份 ✓，每份一条事件 ✓，
    # 值是信号在**该份中点**的取样 ✓（与"查询中点"同一条规则 ✓）。
    #
    # ⚠️ **必须由用户显式要求** ✗ —— 不自动 ✓：因为"n 取多少"**直接决定声音结果** ✓，
    # 而取错 n **不会报错** ✗（只是听起来不对 ✓）—— 那是本项目最贵的那类静默失败 ✓。
    def psegment(sig, n)
      raise ArgumentError, "psegment 的第一个参数必须是信号（收到 #{sig.class}）" unless sig.is_a?(SignalPattern)
      sig.segment(n)
    end

    # `pslow_sig(sig, k)` / `pfast_sig(sig, k)`：在时间上拉伸/压缩 ✓
    # 用 `SignalPattern` 的时间函数包装 ✓，不动既有算子的语义 ✓。
    def pslow_sig(sig, k)
      raise ArgumentError, "pslow_sig 的第一个参数必须是信号（收到 #{sig.class}）" unless sig.is_a?(SignalPattern)
      k = k.to_r
      SignalPattern.new(->(t) { sig.fn.call(t / k) })
    end

    def pfast_sig(sig, k)
      raise ArgumentError, "pfast_sig 的第一个参数必须是信号（收到 #{sig.class}）" unless sig.is_a?(SignalPattern)
      k = k.to_r
      SignalPattern.new(->(t) { sig.fn.call(t * k) })
    end

    # `parrange([4, 模式], [2, 模式], …)` ✓ —— **曲式** ✓（第六阶段 ✓）。
    #
    # "前 4 圈这样、后 2 圈那样" ✓ —— 编曲最基本的动作 ✓。
    #
    # ⚠️ **段内行为要写清** ✗（见 `docs/plan/pattern-arrange-spec.md` ✓）：
    # 段内的素材**每圈重复一次** ✓ —— 所以
    #   `parrange([4, "bd sd"], [2, "hh"])` ✓ → 圈 0..3 每圈都有 `bd sd` ✓、圈 4..5 每圈有 `hh` ✓。
    # 而**不是**"把 `bd sd` 拉伸成 4 圈的长音" ✗。
    #
    # ⚠️ **上游那个官方例子区分不了这两者** ✗（`arrange([4, "<c a f e>(3,8)"], …)` ✓
    # 用的素材本身就是**四圈长**的 ✓）—— 所以我们**没有**拿它当"段内行为"的判据 ✓，
    # 而是**自己测出**可观察行为 ✓ 并写进文档 ✓（见提交记录 ✓）。
    def parrange(*sections, cycle_beats: nil)
      raise ArgumentError, "parrange 至少要一段，形如 parrange([4, 模式], [2, 模式])" if sections.empty?
      built = sections.map do |sec|
        unless sec.is_a?(Array) && sec.size == 2
          raise ArgumentError, "parrange 的每一段必须是 [圈数, 模式]（收到 #{sec.inspect}）"
        end
        cycles, spec = sec
        [cycles, ppattern(spec)]
      end
      # ⚠️ **编排也能给自己的圈长** ✓（"每个定义处可以指定 cycle" ✓）——
      # 编排是**最该指定圈长的地方** ✓：一段 8 拍、一段 3 拍是很常见的事 ✓。
      # ⚠️ 段内模式自带的圈长**保留** ✓（`Arrange.build` 只改时间位置 ✓、不动标记 ✓）；
      # **但消费时以编排这个标记为准** ✓（编排说一圈几拍 ✓ —— 它才是那层定义 ✓）。
      PampaPattern.normalize_cycle_beats(cycle_beats, 'parrange 的 cycle_beats:') if cycle_beats
      arr = Arrange.build(built)
      arr.pampa_cycle_beats = cycle_beats.to_f if cycle_beats && arr.respond_to?(:pampa_cycle_beats=)
      arr
    end

    # `piter(模式, n)` / `piter_back(模式, n)` ✓ —— **变奏** ✓（第六阶段 ② ✓）。
    #
    # 第 `c` 圈用 `模式.early((c % n) / n)` ✓（`piter_back` 用 `late` ✓）——
    # 于是**同一段素材每圈自动错开一个子段** ✓，n 圈一循环 ✓。
    #
    # 例 ✓：`piter(ppattern("0 1 2 3"), 4)` 的逐圈值序 ✓
    #   圈0 [0 1 2 3] ✓  圈1 [1 2 3 0] ✓  圈2 [2 3 0 1] ✓  圈3 [3 0 1 2] ✓
    #
    # ⚠️ **平移量是「一个子段」（`i/n`）** ✓，**不是「一个元素」** ✗ ——
    # 对**等分**的 pattern 两者恰好等价 ✓，但 `"a@3 b"` 这类**不等分**的就不同 ✓，
    # 所以我们**照机制**做 ✓（用 `early`/`late` ✓），**不简化成循环移位** ✗。
    def piter(pattern, n)
      ppattern(pattern).iter(n)
    end

    def piter_back(pattern, n)
      ppattern(pattern).iter_back(n)
    end

    # `pearly(模式, x)` / `plate(模式, x)` ✓ —— **对齐与摇摆** ✓（第六阶段 ④ ✓）。
    #
    # `pearly` 把内容**提前** `x` 圈 ✓、`plate` **推后** ✓（允许**负圈** ✓ —— 时序本身就允许 ✓）。
    #
    # 例 ✓：`plate(模式, 0.1)` 会把整段内容推后 1/10 圈 ✓ ——
    # 那是「**人性化**」与「**错开两层**」的基本手法 ✓（上游文档的例子正是 stack 两个错开的层 ✓）。
    def pearly(pattern, x)
      ppattern(pattern).early(x)
    end

    def plate(pattern, x)
      ppattern(pattern).late(x)
    end

    # `pply(模式, n)` ✓ —— **加花** ✓（普查里的 ③ ✓）。
    #
    # **每条事件在它自己的时长内重复 n 次** ✓ —— 与 `!n`（改**结构** ✓）
    # 和 `*n`（那**一格**里塞多份 ✓）都是**不同的东西** ✓，见规格 §2 ✓。
    #
    # 例 ✓：`pply(ppattern("hh*4"), 2)` ✓ → 每个 hh 变成两个 ✓（间隔减半 ✓）。
    def pply(pattern, n)
      ppattern(pattern).ply(n)
    end

    # `pswing(模式, n)` / `pswing_by(模式, amount, n)` ✓ —— **摇摆** ✓（普查 ④ ✓）。
    #
    # `pswing(模式, 4)` = `pswing_by(模式, 1/3, 4)` ✓（上游的同款简写 ✓）——
    # 每 4 份里，**后半份推后** ✓ → 八分音变成"**长-短**" ✓（就是摇摆 ✓）。
    #
    # ⚠️ **素材密度要够** ✗：摇摆要"**窗口里有多条事件**"才看得见 ✓ ——
    # `ppattern("hh*8")` 配 `pswing(_, 4)` 正好每窗 2 条 ✓（上游文档的例子就是它 ✓）。
    def pswing(pattern, n)
      ppattern(pattern).swing(n)
    end

    def pswing_by(pattern, amount, n)
      ppattern(pattern).swing_by(amount, n)
    end

    # `peuclid_legato(模式, k, n[, rotation])` ✓ —— **欧几里得的"连奏"版** ✓（普查 ⑤ ✓）。
    #
    # 与 `(k,n)`（`euclid` ✓）的**唯一区别是时长** ✓：
    #   * `"c3(3,8)"` ✓（euclid ✓）：三个**短**音 ✓（各 1/8 ✓）—— **有**空隙 ✓，适合打击 ✓；
    #   * `peuclid_legato("c3", 3, 8)` ✓：三个音**占满整圈** ✓（3/8、3/8、2/8 ✓）——
    #     **没有空隙** ✓（"gapless" ✓），适合低音 / 铺底 ✓。
    #
    # **起点完全相同** ✓（都在欧几里得的位上 ✓）。
    def peuclid_legato(pattern, k, n, rotation = 0)
      ppattern(pattern).euclid_legato(k, n, rotation)
    end

    # `plast_of(模式, n) { |p| … }` ✓ —— **每 n 圈里最后一圈**做变换 ✓（普查 ⑤ ✓）。
    #
    # ⚠️ 与 `<…>` 交替的区别 ✗：`<a b>` 是**每圈换一项** ✓；
    # `plast_of(p, 3) { |x| x.rev }` 是"**3 圈里只有第 3 圈不同**" ✓。
    # n = 2 时两者恰好一样 ✓（`<p rev(p)>` ✓）—— 价值在 n > 2 ✓。
    # ⚠️ **签名改成"模式作为第一个参数"** ✓ —— 我第一版写的是 `plast_of(n) { … }` ✓，
    # 并且在里面引用了**不存在的** `ppattern_self` ✗（那是我想当然写的 ✓）。
    # 报错当场抓到 ✓ —— 但**根本原因是我把签名定错了** ✗：
    # 我们所有动词都"**模式在前**" ✓（`piter(模式, n)` ✓、`piter_back(模式, n)` ✓ …），
    # 所以这里也该一致 ✓。
    def plast_of(pattern, n, &f)
      raise ArgumentError, "plast_of 需要一个块，形如 plast_of(模式, 3) { |p| p.rev }" unless f
      ppattern(pattern).last_of(n, &f)
    end

    # `ppalindrome(模式)` ✓ —— **每隔一圈 `rev`** ✓（上游 = `lastOf(2, rev)` ✓，普查 ⑤ ✓）。
    #
    # 第 0 圈原样 ✓、第 1 圈倒放 ✓、第 2 圈原样 ✓ …—— 听感是"**正-反-正-反**" ✓。
    # ⚠️ **与 `rev` 不同** ✗：`rev` 是**每一圈**都倒 ✓。
    def ppalindrome(pattern)
      ppattern(pattern).palindrome
    end

    # `prun(n)` ✓ —— **一圈里离散地走 `0..n-1`** ✓（第六阶段 ⑥ ✓）。
    #
    # ⚠️ **它给的是"值"，不是"控制"** ✓ —— 单用它听起来没意义 ✓（值就是数字 ✓）。
    # 它的用途是**喂给别的算子** ✓（如 `ptranspose` ✓），这正是上游文档里那个用法的意思 ✓：
    # `n(run(4)).scale("C4:pentatonic")` ✓。
    #
    # 它和 `ppattern("0 1 2 3")` **在默认字典下一样** ✓ —— `prun` 的好处是 **n 可以是表达式** ✓。
    def prun(n)
      Pattern.run(n)
    end

    # `ppitch_range(n, lo, hi)` ✓ —— **在 `[lo, hi]` 上取 n 个等分点** ✓（`prun` 的搭档 ✓）。
    #
    # ⚠️ **名字不叫 `prange`** ✗ —— 那个名字**已经被信号的"区间映射"占了** ✓
    #（`prange(信号, lo, hi)` ✓，第三阶段 ✓）。
    # **同一个名字两种意思** ✗ 正是本项目一贯避免的 ✓ —— 所以这里用**更长但明确**的名字 ✓。
    def ppitch_range(n, lo, hi)
      Pattern.range_of(n, lo, hi)
    end

    # `ptranspose(模式, n)` ✓ —— **按半音移调** ✓（第六阶段 ⑥ ✓）。
    #
    # ⚠️ **只对数字值有效** ✓ —— 非数字的值**原样通过** ✓（不崩 ✓）。
    # 所以它适合"**值已经是音高数字**"的模式 ✓（如 `prun` 出来的 ✓、或 `ppattern("60 62 64")` ✓）；
    # 对 `:bd` 这类样本名**不做事** ✓。
    #
    # ⚠️ **它不做音阶映射** ✗ —— "把度数映射到音阶"是另一件事 ✓（见规格 §3 ✓）：
    # 那个要**复用 Sonic Pi 的 `scale`** ✓，而它**只能在 Sonic Pi 会话里验证** ✓，
    # 所以**单独一轮**做 ✓（不在这里悄悄塞一个没法离线验证的东西 ✗）。
    def ptranspose(pattern, n)
      ppattern(pattern).transpose(n)
    end

    # `pzoom(模式, s, e)` / `pcompress(模式, b, e)` / `pfast_gap(模式, k)` / `plinger(模式, t)` ✓
    # —— **窗口类算子** ✓（第六阶段 ⑦ ✓）。四个都是"**在一圈里挑一段**" ✓：
    #
    #   * `pzoom(p, s, e)` ✓：只播一圈的 `[s, e)` 段 ✓，并**拉伸到整圈** ✓；
    #   * `pcompress(p, b, e)` ✓：播**整段** ✓，但**压进** `[b, e)` ✓，其余静音 ✓；
    #   * `pfast_gap(p, k)` ✓：**加速 k 倍但不重复** ✓（= `pcompress(p, 0, 1/k)` ✓）——
    #     ⚠️ **别和 `fast` 混** ✗：`fast` 是**重复填满** ✓、`fast_gap` 是**留空** ✓；
    #   * `plinger(p, t)` ✓：取前 `t` 份 ✓ 并**拉满** ✓（介于两者之间的混合 ✓）。
    #
    # ⚠️ **`pzoom` 与 `pcompress` 最容易混** ✗ —— 同一段、两种处理 ✓：
    #   `pzoom(p, 0, 1/2)` ✓ → 前一半**拉长**成整圈 ✓（两个音各占 1/2 ✓）；
    #   `pcompress(p, 0, 1/2)` ✓ → 前一半**压短**到前一半 ✓（两个音各占 1/4 ✓）。
    def pzoom(pattern, s, e)
      ppattern(pattern).zoom(s, e)
    end

    def pcompress(pattern, b, e)
      ppattern(pattern).compress(b, e)
    end

    def pfast_gap(pattern, k)
      ppattern(pattern).fast_gap(k)
    end

    def plinger(pattern, t)
      ppattern(pattern).linger(t)
    end

    # `pscale_to(模式, 根音, 音阶名)` ✓ —— **把音阶级数映射到音高** ✓（第六阶段 ⑨ ✓）。
    #
    # ⚠️ **名字不叫 `pscale`** ✗ —— 那个已经被**信号的数值缩放**占了 ✓（`pscale(sig, k)` ✓，第三阶段 ✓）。
    # **一个名字两种意思** ✗ 正是本项目一贯避免的 ✓ —— 所以这里用更明确的名字 ✓。
    #
    # **阶数不是半音** ✗：`0` → 根音 ✓、`1` → 音阶第二个音 ✓、
    # `7`（大调）→ 高八度 ✓、`-1` → 根音下面一个**音阶音** ✓。
    #
    # 例 ✓（上游文档那个用法 ✓ `n(run(4)).scale("C4:pentatonic")` ✓）：
    #   `pplay pscale_to(prun(8), 60, :major)`            # C 大调音阶上行 ✓
    #   `pplay pscale_to(prun(5), 60, :minor_pentatonic)` # 小调五声 ✓
    #   `pplay pscale_to(ppattern("0 2 4 7"), 60, :major)` # 挑几个音 ✓
    #
    # ⚠️ **音阶数据是我们自己带的** ✓（`PScale` ✓）—— **不依赖 Sonic Pi 的 `scale`** ✗。
    # 理由 ✓：那个 `scale` **只在 Sonic Pi 会话里存在** ✓（离线 `respond_to?(:scale)` 是 `false` ✓），
    # 依赖它 = 让我们的 pattern **只能在那个上下文里跑** ✗。
    # 而**音阶的音程是公有领域的乐理事实** ✓（大调 = 全全半全全全半 ✓），不是谁的私有数据 ✓。
    #
    # ⚠️ **支持的音阶见 `pscale_names`** ✓ —— 名字写错**立刻报错** ✓，不会静默 ✓。
    def pscale_to(pattern, root, name)
      ppattern(pattern).scale_degrees_of(root, name)
    end

# `pchord(模式, 根音)` ✓ —— **把和弦名变成音高** ✓（第六阶段 ⑩ ✓）。
#
# 例 ✓：
    #   `pplay pchord(ppattern("minor minor major7 minor"), 57), use: :play`
    #   `pplay pchord(parrange([4, "minor"], [4, "major"]), 57), use: :play`
    #
    # ⚠️ **从根音往上堆，不做转位** ✓ —— 想要"就近走 / 留共同音"那是**声部排布** ✓，
    # 它**还没实现** ✗（设计记在 `docs/plan/pattern-chord-spec.md` ✓）。
    # **分开是故意的** ✓：替你选一个摆法 = 做一个你看不见的决定 ✗。
    #
    # ⚠️ **数据是我们自己按乐理公式写的** ✓（`PChord::INTERVALS` ✓，**23 个**常用和弦 ✓），
    # **不 require 上游任何文件** ✓。名字是**通用乐理记号** ✓（`major` / `minor7` / `dom7` ✓）。
    #
    # 名字写错**报错** ✓，不会静默没声音 ✗。
    # ⚠️⚠️ **`pchord` 只做一件事：把值翻译成音高** ✓
    #
    #   它是**翻译器** ✓，不是"播放器" ✗、也不是"时序" ✗：
    #     * 时序由 `ppattern` / `parrange` 决定 ✓（§4 ✓）
    #     * **值**由这里翻译 ✓：`"57:minor"` → `[57, 60, 64]` ✓（用 23 个和弦的音程表 ✓）
    #
    #   ⚠️ **根音必须写进值里** ✓（`"57:minor"` ✓ / `"e3:minor7"` ✓）——
    #   曾经有第二个参数 `root` ✗，它在"根音会动"的进行里是**噪声** ✓（还是得每段写一次 ✗），
    #   2026-10-19 按用户的意思**去掉了** ✗。**一个概念一条路** ✓。
    #
    #   ⚠️ 旧写法 `pchord(pat, 57)` 会**明确报错并给出新写法** ✓（不静默忽略 ✗）。
    def pchord(pattern, *extra)
      unless extra.empty?
        raise ArgumentError,
              "`pchord` 现在只收一个参数（模式）✓ —— 根音请写进值里：`pchord(ppattern(\"57:minor\"))` ✓" \
              "（收到多余的 #{extra.inspect} ✓）"
      end
      ppattern(pattern).chord_pitches_of
    end

    # `pchord_names` ✓ —— **我们支持哪些和弦名** ✓
    def pchord_names
      PChord::INTERVALS.keys.map(&:to_s).sort
    end

    # `pscale_ring(根音, 音阶名[, 八度数])` ✓ —— **音阶本身的音高表** ✓（不发声 ✓）。
    #
    # 形态与 Sonic Pi 的 `scale` 一致 ✓（**末尾带高八度** ✓）：
    #   `pscale_ring(60, :major)` → `[60, 62, 64, 65, 67, 69, 71, 72]` ✓
    def pscale_ring(root, name, octaves = 1)
      PScale.ring_of(root, name, octaves)
    end

    # `pscale_names` ✓ —— **我们支持哪些音阶名** ✓
    def pscale_names
      PScale::SCALES.keys.sort
    end

    # ── 查询：把一段时间里的事件拿出来（不发声 ✓）────────────────────────────────────────
        #
        # 这是声明式语义最直接的用处 ✓：**能问"第 8 圈是什么"，而不用真的播到那里** ✓。
        def pquery(pattern, from = 0, to = 1)
          pattern.query_arc(from.to_r, to.to_r).select(&:whole).map do |h|
            { value: h.value, begin: h.whole.begin, end: h.whole.end }
          end
        end

    # ⚠️ **这里原来有一个 `pseed(n)`** ✓ —— **已删除** ✗（第五阶段之后的决定 ✓，见
    # `docs/plan/pattern-scope-architecture.md` §3.4 ✓）：
    # 它是**进程级可变状态** ✓ → 一个 buffer 调它**会改到所有 buffer 的随机** ✗，
    # 而且**不报错** ✗ —— 那与"**共享的是定义，不是进度**"这条直接矛盾 ✓。
    # 换花样的出口改为 **`pplay(..., seed: n)`** ✓：它是**线程本地**的 ✓、
    # 只影响那一个播放器 ✓、**不串味** ✓（第五阶段已实现并验收 ✓）。



    # Stop our own players only — never touch the user's `live_loop`s.

    # ── 驱动循环：**逻辑拍 + time_warp + sleep**（读完 Sonic Pi 调度机制之后重写的 ✓）─────────
    #
    # ⚠️ 这一版之前错了三次 ✗，根因是**我没有先掌握 Sonic Pi 的调度机制** ✗。现在按机制写 ✓：
    #
    #   **机制一：`sleep` 是"逻辑时间"的推进器，也是排入引擎的时机** ✓（`core.rb:4657`）
    #       def sleep(beats)
    #         __schedule_delayed_blocks_and_messages!   # ① 先把攒着的消息排进引擎 ✓
    #         __change_spider_beat_and_time_by_beat_delta!(beats)   # ② 再推进逻辑时间 ✓
    #         ...
    #         sleep_t = (new_vt - now) - 0.2            # ③ 只真等一部分，其余交给下一轮 ✓
    #
    #   **机制二：`time_warp Δ` 只推进逻辑时间、不等墙钟** ✓（靠 `sonic_pi_spider_in_time_warp` 标志 ✓）
    #       在 warp 里 `sleep` 直接 return ✓，所以 `play` 的 timetag = 逻辑时间 ✓
    #       → **`time_warp(绝对拍) { play }` 就是"把这条事件排在那个时刻"** ✓
    #
    #   **机制三：`__schedule_delayed_blocks_and_messages!` 会 `sleep` 到
    #       "最后一条消息的逻辑时间 + sched_ahead"** ✓
    #       → 这**就是提前量的硬边界** ✓：一次排入的消息必须落在 `sched_ahead`（默认 0.5 s）之内 ✓
    #
    # **由此得到正确写法** ✓（三条都直接来自上面）：
    #
    #   ① 一次只排**一个短窗**（≤ sched_ahead，默认 0.5 s = 1 拍）✓ —— 不是一整圈 ✗
    #   ② 每条事件用 `time_warp(beats_ahead) { deliver }` 排 ✓ —— timetag 精确 ✓
    #   ③ 窗口末尾 `sleep(窗长)` ✓ —— 它既**排入**残余、又**推进逻辑时间**、又**真等到墙钟跟上** ✓
    #      于是循环自然落到"逻辑时间落后墙钟 sched_ahead"的稳态 ✓（这正是 live_loop 的稳态 ✓）
    #
    # **为什么不用 `Kernel.sleep` 自己掐秒**（我前几版的做法 ✗）：
    # 那会让 `play` 的 timetag 变成"调用那一刻的逻辑时间"✗ —— 逻辑时间是**拍**，
    # 不是墙钟 ✓；混着用就会出现"整串排到过去、一个音不响、日志无错" ✗。
    # 子线程里补上 Sonic Pi 需要的线程本地状态（否则 `play` 找不到自己的组/总线 ✗）

    # 秒级的真实等待。**不使用 Sonic Pi 的 `sleep`**（那是拍 ✗）——
    # 关于为什么，见上面投递处的长注释 ✓。
    #
    # 走 `Kernel.sleep`：在 Sonic Pi 的线程里，`sleep` 这个名字被**拍版**覆盖了 ✓
    # （`core.rb` 的 `sleep` 带 `advances_time: true` ✓），要拿回 Ruby 的睡眠得走 `Kernel` ✓。
    # 轮询同时给了我们"中途可被打断"的能力 ✓（`stop_flag` 能立刻生效 ✓）。
    #
    # ⚠️ **这里也必须是 `while`，不能是 `loop do`** ✗ —— 第一版写的是 `loop do` ✓，
    # 而 `Core#loop` 会检查"这一轮有没有 `sleep` 或 `sync`"（`core.rb:2338-2350` ✓）：
    # 我们调的是 `Kernel.sleep`（**逻辑时间的睡眠不是它** ✗）→ 判定为"空转循环" ✗ →
    # 抛 `ZeroTimeLoopError: loop did not sleep or sync!` ✓（实测撞到过 ✓）。
    # 改用 `while` 就绕开了这个**包在 `Kernel.loop` 外面的检查** ✓。
    def __pwait_until(target_wall)
      remain = target_wall - Time.now.to_f
      while remain > 0
        Kernel.sleep(remain > 0.05 ? 0.02 : remain)
        remain = target_wall - Time.now.to_f
      end
    end

    # 当前**逻辑拍**（现成动词 `beat` ✓，`core.rb:4435`）。
    #
    # ⚠️ 这个 `beat` 是**线程本地的 sleep 计数器** ✓（文档原文：*"Beats are advanced only by calls to
    # `sleep` and `sync`"* ✓，且初值任意 ✓）—— 它**不是**音乐网格 ✗。
    # 但在**我们自己的循环内部**，它正是我们要的东西 ✓：
    # `time_warp(Δ) { play }` 里的 Δ 是**相对我当前逻辑拍的提前量** ✓，
    # 而"我当前的逻辑拍"就是 `beat` ✓ —— **同一个线程、同一个计数器** ✓，所以配对正确 ✓。
    def __pcurrent_beat
      beat.to_f
    rescue StandardError
      0.0
    end

    # 当前 bpm（现成动词 ✓）
    def __pcurrent_bpm
      (defined?(current_bpm) && current_bpm) || 60.0
    rescue StandardError
      60.0
    end

    # 起始墙钟时刻。`:bar` 时锚到引擎的小节线 ✓（实测做法见 pattern-scheduler.rb --align ✓）
    def __panchor_wall(cycle_seconds, mode)
      base = Time.now.to_f + 0.4          # 留一点点余量，别把第一条排进过去 ✗
      return base unless mode == :bar

      require_relative "./scheduler"      # 复用探针里已实测的引擎时钟读取 ✓
      info = PampaPattern::Scheduler.engine_bar_anchor
      info ? info[:anchor_unix] : base
    rescue StandardError
      base
    end

    # 引擎当前待发事件数（用于限流 ✓）
    def __ppending_events
      require_relative "./scheduler"
      PampaPattern::Scheduler.engine_pending_events
    rescue StandardError
      0
    end
  end
end