# 运行时的**投递层**：把 pattern 事件交给 Sonic Pi 自己的动词。
#
# 这是 P3 的核心 ✓（见 docs/plan/pattern-dev-plan.md 阶段 P3）。
#
# ⚠️ **为什么必须走 Sonic Pi 的动词，而不是直发 OSC** ✗ —— 这条是本项目付过代价的：
#
# 早期探针**直发 `/s_new` 到引擎**，结果是**绕过了 Sonic Pi 的音频图** ✓：
#   * 引擎的录音抓的是 **bus 0（主输出）** ✓（`studio.rb` 的 `recording_start` 注释原文：
#     "always records bus 0 (the main output mix)" ✓）；
#   * 而 Sonic Pi 自己的 `play` 是经 **`@mixer_bus`** 进 bus 0 的 ✓（`studio.rb`：`"out_bus" => @mixer_bus.to_i`）。
# 所以直发 = 旁路混音、旁路 FX、旁路录音 ✗ —— **能听见，但不是"在 Sonic Pi 里"** ✗。
#
# 投递层因此只做三件事 ✓：
#   1. **把事件的值绑到动词的参数上**（默认 `note:`，可用 `map:` 改）✓；
#   2. **把其余键值原样转发** ✓（于是 MIDI/OSC/采样/插件**不需要新接口** ✓）；
#   3. **一条事件 = 一次动词调用** ✓ —— 时间由**谁在什么时刻调**决定 ✓，本层不管时间 ✓。
#
# **本层不认识时间** ✓ —— 这是"描述与调度分离"的落点：调度器决定"何时调"，投递层决定"调谁" ✓。
# 所以它**可以在没有 Sonic Pi 的环境里被测试** ✓（传一个假的 receiver 进去）—— 见
# `test-pattern-lib.rb` 的投递层部分 ✓。

# ⚠️ **签名表是生成物** ✓（`tools/pattern-probe/gen-verb-signatures.rb` ✓）——
# 从上游每个动词的 `doc` 的 `args:` / `opts:` 抽出 ✓，见下面 `call_for` 的说明 ✓。
require_relative 'verb-signatures-gen'

module PampaPattern
  # ── 圈长（一圈 = 几拍）✓（第六阶段 ⑪ ✓）────────────────────────────────────────────────
  #
  # ⚠️ **为什么单独抽一个纯函数** ✗：算圈长本来在驱动循环里 ✓，
  # 而那里碰 Sonic Pi 的运行时（`link` / `sleep` / `beat` ✓）→ **离线测不了** ✗。
  # **抽出来就能离线测** ✓ —— 上一轮我在真应用里发了错的测试代码 ✗，
  # 根因之一就是"没法离线先跑一遍" ✓。**能离线验的，就别留到开机验** ✓。
  #
  # **语义** ✓：
  #   * **默认 4 拍** ✓（= 1 小节 ✓ —— 本扩展一直以来的约定 ✓，**逐字不变** ✓）；
  #   * `pplay(…, cycle_beats: n)` ✓ **个体覆盖** ✓；
  #   * 全局默认走 `set :pampa_cycle_beats, n` ✓ —— 那是上游**专为跨线程共享**提供的机制 ✓，
  #     **不是裸全局变量** ✗；由调用方取出来传进 `global` ✓。
  #
  # ⚠️ **"中途改圈长"是不允许的** ✗ —— 已经排出去的事件时间**已经定了** ✓，
  # 改了**不会追回** ✓，只会前后不一致 ✗。所以**每个 `pplay` 启动时读一次** ✓。
  #
  # ⚠️ **必须是正数** ✗ —— 0 会让 `total_beats` 算成 0 ✓（静默什么都不播 ✗）、
  # 负数会算出过去的时间 ✓。**报错而不静默** ✓。
  DEFAULT_CYCLE_BEATS = 4.0
  CYCLE_BEATS_KEY = :pampa_cycle_beats

  # ⚠️ **全局 loop 的两半** ✓（2026-10-16 用户要求 ✓：*"4/4，3/4 不同的节拍要都能支持"* ✓）：
  #
  #   `loop_bars`       ✓ 几小节一循环 ✓（默认 **1** ✓）
  #   `beats_per_bar`   ✓ 每小节几拍 ✓（默认 **4** ✓ = 4/4 ✓；3/4 就设 3 ✓）
  #
  #   loop 长度（拍）= `loop_bars × beats_per_bar` ✓。
  # ⚠️ **默认必须是 1 × 4 = 4 拍** ✗ —— 这样 `DEFAULT_CYCLE_BEATS = 4.0` 的既有行为
  # **逐字不变** ✓（回归快照守着 ✓）。
  LOOP_BARS_KEY = :pampa_loop_bars
  BEATS_PER_BAR_KEY = :pampa_beats_per_bar
  DEFAULT_LOOP_BARS = 1
  DEFAULT_BEATS_PER_BAR = 4

  # 全局 loop 长度（拍）✓ —— **纯函数** ✓。
  def self.loop_beats_for(loop_bars = nil, beats_per_bar = nil)
    bars = (loop_bars || DEFAULT_LOOP_BARS)
    bpb  = (beats_per_bar || DEFAULT_BEATS_PER_BAR)
    unless bars.is_a?(Numeric) && bars.positive?
      raise ArgumentError, "`#{LOOP_BARS_KEY}` 要是正数（收到 #{loop_bars.inspect}）"
    end
    unless bpb.is_a?(Numeric) && bpb.positive?
      raise ArgumentError, "`#{BEATS_PER_BAR_KEY}` 要是正数（收到 #{beats_per_bar.inspect}）"
    end
    bars.to_f * bpb.to_f
  end

  def self.normalize_cycle_beats(value, source)
    unless value.is_a?(Numeric) && value.positive?
      raise ArgumentError,
            "圈长必须是**正数**（#{source} 收到 #{value.inspect}）。" \
            "默认是 #{DEFAULT_CYCLE_BEATS} 拍（= 1 小节）"
    end
    value.to_f
  end

  # 算一条播放器的圈长（拍 ✓）。**纯函数** ✓ —— 不碰运行时 ✓。
  #
  # 优先级 ✓（**甲方案** ✓，2026-10-16 用户定 ✓）：
  #   ① `pplay(..., cycle_beats:)` ✓ —— **消费处说了算** ✓（最硬 ✓）
  #   ② **模式自带** `ppattern(..., cycle_beats:)` ✓ —— **定义处** ✓
  #   ③ `set :pampa_cycle_beats, n` ✓ —— **全局默认** ✓
  #   ④ `DEFAULT_CYCLE_BEATS` = 4.0 ✓ —— 不变 ✓
  #
  # ⚠️ **为什么"定义处"比"全局"硬** ✗：用户原话是
  # *"最简单的是可以设定全局的 cycle 时间，**更好的是每个定义处可以指定 cycle**"* ✓ ——
  # 既然"定义处"是更好的那个 ✓，它就该**压过全局** ✓；
  # 否则"我全局设了 3，为什么这个模式不听"这条**会反向出现** ✗（**全局成了唯一权威** ✓）。
  # 消费处仍然最硬 ✓：同一个模式可以被两条播放器用不同圈长消费 ✓（**这是编排的常见需求** ✓）。
  #
  # ⚠️ **"没指定"与"指定了 nil"要一样对待** ✓ —— `ppattern(..., cycle_beats: nil)` ✓
  # 不能把默认值锁成 nil ✓（那会让全局设置失效 ✗）。
  def self.cycle_beats_for(opts, global = nil, declared = nil, loop_beats: nil)
    if opts.key?(:cycle_beats) && !opts[:cycle_beats].nil?
      normalize_cycle_beats(opts[:cycle_beats], 'cycle_beats:')
    elsif !declared.nil?
      normalize_cycle_beats(declared, '定义处的 cycle_beats:')
    elsif !global.nil?
      normalize_cycle_beats(global, 'set :pampa_cycle_beats')
    elsif !loop_beats.nil?
      # ⚠️ **默认 = 全局 loop 长度** ✓（用户模型 ✓：*"先写死这个 pattern 的 cycle 长度
      # 等于全局设定的 loop 小节数"* ✓）。4/4 与 3/4 都从这里来 ✓。
      normalize_cycle_beats(loop_beats, '全局 loop 长度')
    else
      DEFAULT_CYCLE_BEATS
    end
  end

# ⚠️ **读"这个模式自身有多少圈"** ✓（编排有 ✓，无限模式没有 ✓）。
#
# **为什么需要** ✗：编排只有 N 圈 ✓，而全局拍无限往下走 ✓ → 心跳必须按 N 取模循环 ✓
#（实测：`parrange([1,bd],[1,sd])` 在全局第 12 圈时**一条都发不出** ✗）。
def self.loop_cycles_of(pattern)
  return nil unless pattern.respond_to?(:pampa_loop_cycles)
  n = pattern.pampa_loop_cycles
  n.nil? ? nil : n.to_f
end

# 从模式上读它自带的圈长 ✓（没有就是 nil ✓，**不猜** ✗）。
def self.cycle_beats_of(pattern)

    return nil unless pattern.respond_to?(:pampa_cycle_beats)
    pattern.pampa_cycle_beats
  end

  # `use:` 的简写 → 真实动词名。
  #
  # **简写只映射到最常用的那个变体** ✓（架构文档定的规则 ✓）：
  # 要用别的变体（如 `midi_cc`）就写**全名** ✓ —— 全名直接透传 ✓。
  USE_ALIASES = {
    play:   :play,
    sample: :sample,
    midi:   :midi_note_on,
    osc:    :osc_send,
  }.freeze

  # 一条事件要调用的动词名
  def self.verb_for(use)
    USE_ALIASES.fetch(use, use)     # 未知的 key 当全名用 ✓
  end

  # 把一条事件变成一次动词调用的参数。
  #
  #   event_value            事件的值
  #   opts                   用户给的键值（含 use:/map:/name: 等）
  #   -> [verb_symbol, args_hash, positional_args]
  #
  # ⚠️ **动词的参数形状不同** ✓ —— 这是实测得来的一条（我先前漏了 ✗）：
  #
  #   `play(n, **opts)`      → 音高是**第一个位置参数** ✓，也可以走 `note:` 键 ✓（`play` 内部转成 note ✓）
  #   `sample(*args, &blk)`  → 采样名是**第一个位置参数** ✓
  #                            **传成键（`sample: :x`）不报错但无声** ✗ ——
  #                            它走 `filts_and_sources.size == 0` → `BlankNode` ✓（实测证实 ✓：
  #                            位置参数给出 `SonicPi::SynthNode` ✓，键给出 `BlankNode` ✗）
  #   `midi_note_on(...)`    → 音高走 `note:` 键 ✓
  #   `osc_send(...)`        → 参数走 `args:` ✓（通常它是位置参数，但 OSC 的形状特殊，见下）
  #
  # 所以投递层必须知道"哪个动词要位置参数" ✓ —— 这就是它作为**适配层**该做的事 ✓。
  def self.call_for(value, opts)
    verb = verb_for(opts[:use] || :play)
    # ⚠️ 默认 map **在这里解析** ✓，不是只在外层（`pplay`）解析 ✗ ——
    # 第一版把这个默认放在 `pplay` 里 ✓，结果**直接调 `deliver` 的路径拿不到它** ✗
    # （投递层单测当场抓到 ✓：`sample` 收到的是 `note:` 键 ✗ → 会**静默无声** ✗）。
    # **默认值要在"最终使用它的那一层"解析** ✓。
    map_to = opts[:map] || default_map_for(opts[:use])
forwarded = opts.reject { |k, _| CONTROL_KEYS.include?(k) }
# ⚠️⚠️ **同一个参数既手写又被模式映射 → 报错，不静默覆盖** ✗
#
#   为什么 ✗：`merge` 会**悄悄把用户的写法吃掉** ✓ ——
#   比如 `pplay pat, use: :play, note: prange(psine, 55, 75)` ✓：
#   模式和用户都想管 `note` ✓ → merge 之后**用户的信号消失** ✓，**不报错** ✗。
#   那正是本项目一路在打的那种错 ✓（**静默失效** ✗）。
#   **要么用户不写 ✓，要么换个键** ✓（比如音高用模式、音量用 `amp:` ✓）。
if forwarded.key?(map_to) && forwarded[map_to] != value
  raise ArgumentError,
        "参数 #{map_to.inspect} 同时来自**模式的值**和**你手写的键**（#{forwarded[map_to].inspect}）。" \
        "要么去掉手写的 #{map_to}:，要么用 `map:` 指定别的键"
end
forwarded = forwarded.merge(map_to => value)


    # ⚠️⚠️ **位置参数由引擎的签名决定** ✓ —— **不再按动词写分支** ✗。
    #
    #   旧写法是 `case verb when :sample / :play / :osc_send` ✗ ——
    #   **只有这三个**知道"值该走位置参数" ✓，其余三百多个全靠用户手写 `map:` 才不会错 ✗。
    #
    #   **现在统一** ✓：按上游 `doc` 的 `args:` **名字顺序**，把对应键从 forwarded 里取出来 ✓。
    #   三个例子都自然成立 ✓：
    #     `sample(name_or_path)` ✓、`osc_send(hostname, port, path, args)` ✓（`args` 展开成多个 ✓）、
    #     `midi_pitch_bend(delta)` ✓。
    positional = []
    sig = PampaPattern::VERB_SIGNATURES[verb]
    if sig && sig[:pos]
      if sig[:pos].include?(:args)
        # ⚠️ **`args` 是那个"整个位置参数表"的口** ✓ —— 上游把它声明成 `[:args, :list]` ✓
        # （`osc_send(hostname, port, path, args)` ✓）。我们的值就是**一张表** ✓
        # （`["127.0.0.1", 4560, "/x", 7]` ✓）→ **整张表当位置参数** ✓。
        v = forwarded.delete(:args)
        positional = Array(v) unless v.nil?
      else
        # ⚠️⚠️ **位置参数必须是从第一个起"连续的一段"** ✗ —— 不能有洞 ✓。
        #
        #   实测反例 ✓：`midi_cc(control_num, value)` ✓，我们只映射了 `value` ✓
        #   → 若直接把它塞进位置参数 ✓ → Ruby 侧 `params = [74]` ✓
        #   → **被当成 `control_num`** ✗✗（值跑到 CC 编号上 ✓，而 Sonic Pi **不报错** ✗）。
        #   所以**遇到第一个缺的名字就停** ✓，后面的留在关键字里 ✓
        #   （`midi_cc` 的 `value:` 本来就在它的 `opts` 里 ✓）。
        sig[:pos].each do |arg_name|
          next if arg_name.nil?
          break unless forwarded.key?(arg_name)   # ★ 连续前缀 ✓
          positional << forwarded.delete(arg_name)
        end
      end
    end

    [verb, forwarded, positional]
  end

  # 我们自己的控制键 —— **不转发给 Sonic Pi 的动词** ✓
  # （否则 `play` 会收到一个它不认识的 `:use`，轻则警告、重则报错 ✗）
  # ⚠️ 这个清单**必须覆盖所有我们自己的选项** ✗ —— 漏一个，它就会被转发给 Sonic Pi 的动词 ✓，
  # 轻则噪音、重则报错。第一版漏了 `anchor` ✓（单测当场抓到：`play {anchor: :now, ...}` ✗）。
  # 教训：**"哪些是本层选项"要和 `pplay` 的参数表逐条对** ✓，不能靠记忆 ✗。
  # ⚠️ **每一个 `pplay` 的选项都必须在这里** ✗ —— 漏一个就会被**转发**给 Sonic Pi 的动词 ✓
    #（`anchor` 与 `cycle_beats` 都踩过这一处 ✓）。判据里有一条**逐个对**的检查 ✓。
    # ⚠️⚠️ **`loop_beats` 必须在表里** ✗（2026-10-16 真机 "根本没声音" ✓）：
    #   我把它加进 `spec` ✓ 之后，它同时出现在 opts 里 ✓ →
    #   **漏给了消费方** ✗ → `sample(:hh, loop_beats: 8.0)` ✓ →
    #   Sonic Pi 的 `sample_split_filts_and_opts` 认为**没有采样源** ✗ →
    #   日志 `sample [:hh] - no match found, skipping` ✓ → **完全没声音** ✗。
    #   **控制键不齐 = 静默失声** ✓ —— 这与 `anchor` / `cycle_beats` 当年是**同一个坑** ✗。
    # ⚠️ **只放我们真的会设进 opts 的键** ✓ —— 多放一个的含义是"它会被静默吞掉" ✗，
    #   于是用户写它**没有任何效果** ✗（`window_beats` / `seed` / `align` / `max_pending`
    #   / `lookahead_ms` 那一批"假选项"就是这么来的 ✓）。
    #   其余键现在会像普通选项一样被**转发** ✓ → 写错了会**当场报错** ✓，不会静默失效 ✗。
    CONTROL_KEYS = %i[use map name seed cycle_beats beats_per_bar loop_beats].freeze
  # ⚠️ `sync` 已从表里**去掉** ✓（2026-10-16 用户定 ✓）——
  # *"pplay 的开始处如何与 Sonic Pi 按 name 同步，还是就简化到节拍同步"* ✓ → **简化到节拍** ✓。
  # 理由 ✓：**按 name 同步会把两个消费方在时间上绑死** ✗，
  # 与用户定的"**消费方彼此独立**"直接矛盾 ✗；而且它把 Sonic Pi 的 cue 命名空间
  # 引进编排 ✓（**换个 buffer 就失效** ✗）。**节拍同步（`align:`）才是编排需要的东西** ✓。
  #
  # ⚠️ `beats_per_bar` 也是 **2026-10-16 加的** ✓ —— 它跟 `window_beats` 一样
  # **是我们自己的** ✓，**绝不能转发给 Sonic Pi 的动词** ✗。
  # 实测症状 ✓：`osc_send` 报 `Unknown arg type to encode: {beats_per_bar: ...}` ✗
  #（它把 Hash 当 OSC 参数编码 ✓）。**这条是先在真机上炸出来的** ✗。
  #
  # ⚠️ `window_beats` 是 **2026-10-16 加的** ✓（同步路径的"一步走几拍" ✓）——
  # 加它是因为**判据当场抓到漏了** ✗（`test-consumers.rb` 那条"选项表都在 CONTROL_KEYS 里" ✓）：
  # 同步 `pplay` 收 `window_beats:` 却没登记 ✓ → 它会**被原样转发**给 Sonic Pi 的动词 ✗
  #（`sample` 收到一个不认识的键 ✓，而**不报错** ✗）。**这条判据值钱就值在这里** ✓。

  # 投递一条事件。
  #
  # `receiver` 是**任何响应动词名的对象** ✓ ——
  # 在 Sonic Pi 里它就是 `self`（用户脚本的运行时，`play`/`sample`/`midi_note_on` 都在上面 ✓）；
  # 在测试里它是个假的记录器 ✓。**这就是本层可测的原因** ✓。
  #
  # `at` 是**这条事件的中点**（第三阶段之后才有 ✓，可为 nil ✓）——
  # 参数里的**连续信号**要用它求值 ✓（第四阶段 ✓，见下 `resolve_signals` ✓）。
  def self.deliver(receiver, value, opts, at = nil)
    verb, args, positional = call_for(value, opts)
    args = resolve_signals(args, at) if at
    unless receiver.respond_to?(verb)
      raise ArgumentError, "动词不存在：#{verb.inspect}（use: #{opts[:use].inspect}）"
    end
  result = receiver.public_send(verb, *positional, **args)
  # ⚠️⚠️ **`BlankNode` = Sonic Pi 把这一下跳过了** ✗（2026-10-16 实测）：
  #   `sample :bd`（不存在的名字）→ `resolve_sample_path` 为 nil → 返回 `BlankNode` → **完全没声音**；
  #   `sample :bd_haus`（真名字）→ 返回 `LazyNode` → 真发声。
  #   **这是唯一能在 Ruby 侧区分"响了"和"被跳过"的信号** ——
  #   那条 `no match found` 只进 GUI 面板，不落 `spider.log`，所以 `pstats[:sent]` 会骗人。
  #   ⚠️ **必须喊出来**：静默跳过是这一轮最贵的教训。
  if result.class.name.to_s.end_with?('BlankNode')
    warn "[pplay] 没响：use=#{opts[:use].inspect} 值=#{positional.first.inspect} 被 Sonic Pi 跳过" \
         "（名字不存在？）"
  end
  result
end

  # 参数里的**连续信号** → 在 `at` 处取样 ✓（第四阶段 ✓）。
  #
  # ⚠️ **语义：每事件一次取样，取事件的中点** ✓ —— 查上游定的 ✓
  #（`appLeft`/`appRight` 以"结构事件自己的 whole"为 span 去问信号 ✓，
  #  而信号取该 span 的中点 ✓ —— hap.mjs 的 *"halfway between the start and end"* ✓）。
  # **与 `psegment` 同一条规则** ✓（它也取每份中点 ✓）→ 两种写法结果相同 ✓（有判据 ✓）。
  #
  # ⚠️ **不改变事件数** ✓：每条事件仍是一次动词调用 ✓，只是参数值不同 ✓。
  # 要"音符内部也在变"就提高 pattern 密度 ✓（`ppattern("c4*32")` ✓）——
  # **不自动加密** ✗，理由与第三阶段一致 ✓：那是替用户选一个他看不见的密度 ✓。
  def self.resolve_signals(args, at)
    return args unless args.is_a?(Hash)
    args.transform_values do |v|
      v.is_a?(SignalPattern) ? v.fn.call(at) : v
    end
  end

  # 用**指定种子**查询一个 pattern ✓（第五阶段 ✓）。
  #
  # ⚠️ 为什么要这一层 ✗：`Mini.seed` 是**全局**的 ✓，而播放器是**多线程**的 ✓ ——
  # 若"进线程时设一次"，别的播放器会覆盖它 ✓ → 结果串味 ✓ 且**不报错** ✗。
  # 所以种子必须在**用到它的那一刻**套上 ✓，用完立刻还原 ✓（`ensure` ✓）。
  # `seed` 为 `nil` 时**不动全局** ✓（这是默认路径 ✓ —— 不开种子就没有额外开销 ✓）。
  def self.query_with_seed(pattern, from_cycle, to_cycle, seed = nil)
    return pattern.query_arc(from_cycle, to_cycle) if seed.nil?
    Mini.with_seed(seed) { pattern.query_arc(from_cycle, to_cycle) }
  end

  # `use: :sample` 时**默认** `map:` 是 `:sample` ✓（否则默认的 `:note` 会给出 `sample(note: ...)`
  # —— 那正是实测过的"静默无声" ✗）。所以这里给一个**按动词取默认 map** ✓。
  # ⚠️⚠️ **默认 map 由引擎的签名推导** ✓ —— 不再是我手写的 `case` ✗。
  #
  #   规则 ✓（三条，按顺序 ✓）：
  #     ① 有 `:args` 这个位置参数 → `:args` ✓（`osc_send(hostname, port, path, args)` ✓，
  #        它要展开成**多个**位置参数 ✓）
  #     ② 有 `:value` → `:value` ✓（`midi_cc` ✓、`track_control(parameter, value)` ✓）
  #     ③ 否则取**第一个**位置参数 ✓（`play → note` ✓、`sample → name_or_path` ✓、
  #        `midi_note_on → note` ✓、`midi_pitch_bend → delta` ✓、`synth → synth_name` ✓）
  #
  #   ⚠️ **第一版我写的是"取最后一个"** ✗ → `midi_note_on(note, velocity)` 拿到 `velocity` ✗
  #   （**实测抓到的** ✓：`default_map_for(:midi)` 返回 `:velocity` ✗）。**多参数动词不能用"最后一个"** ✗。
  #
  #   ⚠️ 签名表里没有这个动词（用户自定义 ✓ / 上游新加 ✓）→ 退回 `:note` ✓，**不报错** ✓ ——
  #   **报错会挡住"引擎能控制的都能控制"** ✗，那正是这条重构要保的东西 ✓。
  def self.default_map_for(use)
    verb = verb_for(use || :play)
    sig = PampaPattern::VERB_SIGNATURES[verb]
    pos = (sig && sig[:pos]) || []
    return :args  if pos.include?(:args)
    return :value if pos.include?(:value)
    pos.first || :note
  end
end
