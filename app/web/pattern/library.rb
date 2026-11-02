# Strudel 式时序语义的**最小可复用实现**：pattern 是「时间区间 -> 事件集合」的纯函数，时间是有理数。
#
# 从 tools/pattern-probe/rat-time.rb 抽出来的 —— 那份是**探针**（27 项判据，跑一次给结论），
# 这份是**库**（被探针与调度器共用）。抽出来的理由很实际：探针 1 的调度器要用同一个 Pattern，
# 而探针文件一被 require 就会跑完整套判据、打印一堆东西。**一份实现，两处引用。**
#
# 这里**故意**只做子集：`[ ]`、`~`、`*n`、空格序列，以及 fast/slow/rev/map_values。
# 完整 Strudel 语法（`< > , ! ?`、欧几里得、连续信号）**不在范围内** —— 见
# docs/plan/pattern-timing-research.md §8 的风险 3、5。
#
# 三个曾经的坑都写在各自的实现旁边（Range 身份、rev 的排序与过滤、嵌套组要按区间细分），
# 因为每一个都让探针失败过：**看懂它们是这份文件价值的一部分**。
# 探针 2：有理数时间的可见性 —— 纯 Ruby，不需要 Sonic Pi、不需要引擎、不占音频设备。
#
#   ruby tools/pattern-probe/rat-time.rb
#
# 目的（见 docs/plan/pattern-timing-research.md §7 探针 2）：证明 Strudel 时序语义里
# **最本质的一条**能在 Ruby 里干净地成立 ——
#
#   * 一个 pattern 是「时间区间 -> 事件集合」的**函数**（queryArc），不是"醒来做一件事"；
#   * 时间是**有理数**，所以 fast/slow 的组合**永不漂**；
#   * 同一区间查询多次，结果**逐条相同**（纯函数）。
#
# 为什么这几条值得单独一个探针：它们是**整条路线的地基**。如果 Ruby 的有理数在这里
# 做不到"同一查询永远同一结果"，那么"提前 0.5 秒查一个窗、把事件带绝对时刻发出去"
# 这个方案就不成立 —— 因为每次查询都会给出不同的时刻。
#
# 它**不**测引擎（那是探针 1 的事）：这里一个字都不发给 Sonic Pi。
require "rational" if false   # Rational 是 Ruby 内置，这行只是说明来源

# ---------------------------------------------------------------------------------------------
# PRandom：**确定性的"随机"** ✓（第五阶段 ✓）。
#
# ⚠️ **要害是不用 `rand`** ✗ —— 本项目的两条不变量是"pattern 是纯函数"与
# "同一查询永远同一结果" ✓，而随机会直接威胁它们 ✗。
# 所以这里是 `(时间, 序号, 种子)` 的**确定性哈希** ✓：
#   * 同一段代码、同一次查询 → **永远同一个结果** ✓（可复现 ✓）；
#   * "随机"是**时间的函数** ✓，不是状态 ✓；
#   * 想换花样就**换种子** ✓（种子是**代码的一部分** ✓，不是状态 ✓）。
#
# ⚠️ **哈希的均匀性是被验证过的** ✓，不是假设的 ✗ ——
# 参照实现 `tools/pattern-probe/reference/random-semantics.rb` 实测：
#   p=0.10 → 0.0920   p=0.25 → 0.2380   p=0.50 → 0.5010
#   p=0.75 → 0.7550   p=0.90 → 0.8920   （全部偏差 < 0.013 ✓）
# 若不均匀 ✓，"以概率 p 丢弃"就**不是那个意思** ✗ —— 那会让判据测的是别的东西 ✓。
module PRandom
  module_function

  # FNV-1a（与 `Signal.hash01` 和两个参照实现**逐位一致** ✓ —— 判据靠它对齐 ✓）
  def hash01(*ints)
    h = 0x811c9dc5
    ints.each do |i|
      x = i.to_i & 0xffffffff
      4.times do
        h ^= (x & 0xff)
        h = (h * 0x01000193) & 0xffffffff
        x >>= 8
      end
    end
    h.to_f / 0xffffffff
  end

  # 时间 -> 整数键 ✓（用有理数的**分子分母** ✓，避免浮点 —— 浮点会让"可复现"变脆 ✗）
  def time_key(t, seed = 0)
    r = t.to_r
    [1, r.numerator, r.denominator, seed]
  end

  # `?p`：以概率 p **丢掉** ✓（照上游 `degradeBy` ✓ —— 是"丢掉"不是"保留" ✓）
  def dropped?(t, p, seed = 0)
    hash01(*time_key(t, seed)) < p
  end

  # `|`：第 cycle 圈选第几个 ✓（`n <= 1` 时恒为 0 ✓）
  def choice_index(cycle, n, seed = 0)
    return 0 if n <= 1
    [(hash01(2, cycle.to_i, seed) * n).floor, n - 1].min
  end

  # `/n`：这个元素在第 cycle 圈出现吗 ✓
  def appears?(cycle, n)
    (cycle.to_i % n).zero?
  end
end

# ---------------------------------------------------------------------------------------------
# Signal：**连续**的量（第三阶段 ✓）—— 与"离散事件"是两套语义 ✓。
#
# 区别用一条**可测**性质分清 ✓（见 docs/plan/pattern-signal-spec.md §2 ✓）：
#   * 离散事件：换一个查询窗，**值不变** ✓，只有 part 变 ✓；
#   * 连续信号：换一个查询窗，**值随窗变** ✓ —— 它没有"存在的事件" ✓，
#     只有"在这个窗里取样得到的值" ✓。
#
# ⚠️ **值域一律 `[0,1]`（单极 ✓）** —— 这一条是查上游源码才定的 ✓，
# 我原先写"`[-1,1]`" ✗ **错了** ✓（signal.mjs：`sine` = `sine2.fromBipolar()` ✓，
# 而 `saw`/`square`/`tri`/`rand` 也都是 0..1 ✓；`pattern.mjs` 的 `range` 注释说
# "Assumes … unipolar values in the range 0..1" ✓）。
# 双极时 `range(200,2000)` 会给出 **−1600** ✓（实测 ✓）→ 喂给 `amp:` 就是垃圾 ✓ 且不报错 ✗。
#
# ⚠️ **取样点 = `part` 的中点** ✓ —— 上游 hap.mjs 原话 ✓：
#   "the given value will have been sampled from **the point halfway between the start and end
#    of the 'part' timespan**" ✓。
#
# ⚠️ **随机必须可复现** ✓：用 `(种类, 位置)` 的**确定性哈希**做种子 ✓，**不是 `rand`** ✗
# —— 这样"同一查询永远同一结果"这条不变量仍然成立 ✓（有判据 ✓）。
module Signal
  module_function

  TAU = 2 * Math::PI

  # ── 确定性哈希（FNV-1a ✓）────────────────────────────────────────────────────────────────
  # 与参照实现 `tools/pattern-probe/reference/signal-semantics.rb` **逐位一致** ✓
  # —— 因为判据要拿两者的数值对比 ✓（浮点相等要小心，所以判据里用**近似**比 ✓）。
  def hash01(*ints)
    h = 0x811c9dc5
    ints.each do |i|
      x = i.to_i & 0xffffffff
      4.times do
        h ^= (x & 0xff)
        h = (h * 0x01000193) & 0xffffffff
        x >>= 8
      end
    end
    h.to_f / 0xffffffff
  end

  # ── 六个信号（全部 [0,1] ✓）──────────────────────────────────────────────────────────────
  def sine(t)     = (Math.sin(TAU * (t % 1r).to_f) + 1) / 2   # 0.5 → 1 → 0.5 → 0 ✓
  def saw(t)      = (t % 1r).to_f                             # 0 → 1 ✓
  def square(t)   = ((t % 1r) < 1r / 2) ? 0.0 : 1.0           # 前半 0、后半 1 ✓
  def triangle(t)                                             # 0 → 1 → 0 ✓
    x = (t % 1r).to_f
    x < 0.5 ? x * 2 : (1 - x) * 2
  end

  # `prand`：**每圈一个**值 ✓ → 分段常量 ✓（圈内恒定 ✓）
  def prand(t) = hash01(1, t.floor)

  # `pnoise`：**连续**随机 ✓ —— 在 1/1000 圈的格上取随机、再线性插值 ✓
  def pnoise(t)
    x = (t % 1r).to_f * 1000
    i = x.floor
    a = hash01(2, i)
    b = hash01(2, i + 1)
    a + (b - a) * (x - i)
  end

  # ── 变换 ────────────────────────────────────────────────────────────────────────────────
  def range(v01, lo, hi) = lo + (hi - lo) * v01
  def offset(v, d)       = v + d
  def scale(v, k)        = v * k
  def add(a, b)          = a + b
end

# ---------------------------------------------------------------------------------------------
# 最小事件模型，照着 Strudel 的形状：whole（事件占据的整个区间）/ part（本次查询命中的部分）
# ---------------------------------------------------------------------------------------------
Hap = Struct.new(:whole, :part, :value) do
  def to_s
    w = whole ? "[#{whole.begin.to_r},#{whole.end.to_r})" : "[continuous]"
    "#{w} #{value.inspect}"
  end

  # 判据用：两条事件是否"同一条"。默认**只比 whole 与 value**，因为 part 随查询窗变化是
  # **正确的**（同一事件被不同的窗裁出不同的一部分）—— 所以需要比 part 的地方必须显式要求
  # （见 ⑥⑧：那里 `with_part: true`）。
  #
  # 区间**按端点比，不按 Range 对象比** —— 这是探针 2 最后一次失败教会的：
  # `[0,1/4)` 用 `..` 写成 `0..1/4`、用 `...` 写成 `0...1/4`，**端点完全相同**，
  # 但 `Range#==` 因为 exclude_end? 不同而给出 false。第一版因此报了假失败，
  # 而逐条打印一出来就一目了然（a 是 `..`、b 是 `...`）。区间语义只由端点决定。
  def same_event?(other, with_part: false)
    return false unless other.is_a?(Hap)
    return false unless value == other.value
    return false unless self.class.span_eq?(whole, other.whole)
    with_part ? self.class.span_eq?(part, other.part) : true
  end

  def self.span_eq?(x, y)
    x.begin == y.begin && x.end == y.end
  end
end

# ---------------------------------------------------------------------------------------------
# Pattern：时间区间 -> 事件。这是 Strudel 的核心抽象，不是调度器。
# ---------------------------------------------------------------------------------------------
class Pattern
  attr_reader :query

  # ⚠️ **本模式自带的圈长（拍）** ✓ —— 2026-10-16 加的 ✓（用户的要求：
  # *"可以设定全局的 cycle 时间，更好的是每个定义处可以指定 cycle"*）。
  #
  # **它只是一个标记** ✓ —— **不改事件、不改查询** ✓：模式的事件位置是
  # **圈坐标**（`[k, k+1)` ✓），"一圈几拍"只决定**消费时怎么换算成拍** ✓。
  # 所以 `ppattern("c2 e2 g2", cycle_beats: 8)` 与不加时的**事件完全相同** ✓，
  # 只有"一圈多长"这个解释不同 ✓。
  #
  # 优先级见 `PampaPattern.cycle_beats_for` ✓：`pplay(...)` > **本标记** > 全局 > 默认 4.0 ✓。
  attr_accessor :pampa_cycle_beats

  # ⚠️ **编排自身的长度（圈数）** ✓ —— 2026-10-16 加 ✓。
  #
  # **为什么需要** ✗：编排只有 N 圈 ✓（`parrange([4, a], [2, b])` = 6 圈 ✓），
  # 而**全局拍是无限往下走的** ✓ → 请求"第 12 圈"时编排里**什么都没有** ✗
  # → `sent 0` ✓（实测 ✓）。**所以轨道必须按自身长度循环** ✓ ——
  # 心跳拿这个数把查询坐标取模 ✓。
  #
  # ⚠️ 普通 `ppattern` 是**无限**的 ✓ → 这里保持 `nil` ✓（不取模 ✓）。
  attr_accessor :pampa_loop_cycles

  def initialize(&query)
    @query = query
    @pampa_cycle_beats = nil
  end

  # ⚠️ **变换必须**继承**圈长标记** ✗ —— 否则
  # `ppattern("c2 e2 g2", cycle_beats: 8).iter(2)` 会把它弄丢 ✓ → 静默退回默认 4.0 ✓。
  # 所以 `Pattern` 的**每个变换**都走这里 ✓，而不是直接 `Pattern.new` ✓。
  def derive(&query_fn)
    # ⚠️ 这里必须是 `Pattern.new`（**不能**写 `derive` ✓ —— 那会无限递归 ✗，实测炸过 ✓）
    np = Pattern.new(&query_fn)
    np.pampa_cycle_beats = @pampa_cycle_beats
    np
  end

  # 查询一个区间，拿到落在里面的事件。区间一律用 Rational。
  def query_arc(begin_t, end_t)
    b = begin_t.to_r
    e = end_t.to_r
    raise ArgumentError, "query_arc needs begin < end (got #{b}..#{e})" unless b < e
    @query.call(b, e)
  end

  # 一整圈（Strudel 里 "一圈" = [0,1)），可选第 n 圈
  def cycle(n = 0)
    query_arc(n.to_r, n.to_r + 1)
  end

  # fast(k)：k 倍速 = 把时间**压缩** k 倍，即查询时把区间放大 k 倍再看
  def fast(k)
    k = k.to_r
    derive { |b, e| @query.call(b * k, e * k).map { |h| scale(h, 1 / k) } }
  end

  def slow(k) = fast(1.to_r / k.to_r)

  # `early(x)` / `late(x)`：把内容**提前 / 推后 x 圈** ✓（普查里的 ④ ✓）。
  #
  # 上游原文 ✓（`pattern.mjs:2502` ✓）：
  #
  #     early(offset, pat) { return pat.withQueryTime((t) => t.add(offset))
  #                                  .withHapTime((t) => t.sub(offset)); }
  #
  # 即：**查询时间 +x ✓、事件时间 −x ✓** —— 两边一减，净效果就是"**内容左移 x**" ✓。
  # `late` 同理，符号相反 ✓。
  #
  # ⚠️ **`withHapTime` 里 `whole` 与 `part` 都要移** ✗ —— 只移一个会让"事件归属"判断出错 ✓
  #（我们的 `rev` 就在这上面栽过 ✓：过滤按 `part` 而不是 `whole` ✓）。
  def early(x)
    x = x.to_r
    shift(x)
  end

  def late(x)
    x = x.to_r
    shift(-x.to_r)
  end

  # `euclid_legato(k, n, rotation)`：**起点在欧几里得位，每个音延续到下一起点** ✓（普查 ⑤ ✓）。
  #
  # 上游原文 ✓（`packages/core/euclid.mjs:145` ✓）：
  #
  #     const _euclidLegato = function (pulses, steps, rotation, pat) {
  #       var bin_pat = _euclidRot(pulses, steps, 0);
  #       const firstOnset = bin_pat.indexOf(1);
  #       bin_pat = rotate(bin_pat, firstOnset);              // 转到"第一起点在开头"
  #       steps = Math.abs(steps);
  #       const gapless = bin_pat.join('').split('1').slice(1)
  #         .map((s) => [s.length + 1, true]);                // 每段 = 到下一起点的**步数**
  #       return pat.struct(timeCat(...gapless).late((rotation + firstOnset) / steps));
  #     };
  #     euclidLegato(k, n, pat) = _euclid(k, -n, 0, pat)       // ← 负步数是开关
  #
  # ⚠️ **它的净效果比它的实现简单** ✓ —— 上游绕了一大圈（`struct` + `timeCat` + `late` ✓），
  # 但**净效果就是两句话** ✓：
  #
  #   * **起点** 落在**欧几里得的位**上 ✓；
  #   * 每个音的**时长** = **到下一个起点**（最后一个延伸到圈末 ✓）—— 这就是 "gapless" ✓。
  #
  # 所以我们**照这两句话直写** ✓（**不移植 `struct`/`timeCat`** ✗ ——
  # 那套"步数记账"我们没有 ✓，而且移植它等于为了一个净效果引入一整套概念 ✗）。
  # **推导有据** ✓：上游那个 `gapless` 数组算的正是"到下一起点的步数" ✓
  #（`3,8` → 位 `10010010` → 段 `[3,3,2]` ✓ → 起点 `0, 3/8, 3/4` ✓）。
  #
  # ⚠️ **它与 `euclid` 的区别** ✗（用例 ✓）：
  #   * `euclid(3,8)` ✓：三个**短**音 ✓（各占 1/8 ✓）—— 有**空隙** ✓；
  #   * `euclid_legato(3,8)` ✓：三个音**占满整圈** ✓（3/8、3/8、2/8 ✓）—— **没有空隙** ✓。
  # 所以它适合**低音 / 铺底** ✓，`euclid` 适合**打击** ✓。
  #
  # ⚠️ **`rotation` 的单位是"步"** ✓（不是圈 ✓）—— 与 `euclid` 一致 ✓。
  def euclid_legato(k, n, rotation = 0)
    k = k.to_i
    n = n.to_i
    raise ArgumentError, "euclid_legato 的 n 必须是正整数（给了 #{n}）" if n < 1
    raise ArgumentError, "euclid_legato 的 k 必须在 1..n 之间（给了 #{k}，n=#{n}）" unless k.between?(1, n)
    rot = rotation.to_i % n
    # 欧几里得的位（用我们已有的 bjorklund ✓）+ rotation 左旋 ✓
    # ⚠️ 它在顶层 `Mini` 里 ✓（不是 `Pattern` 的方法 ✓，也不用带 `PampaPattern::` ✓）——
    # 这里我连错两次 ✓，两次都是**报错当场抓到** ✓（不是静默 ✓，这点很好 ✓）。
    bits = Mini.euc_pattern(k, n, rot)
    onsets = (0...n).select { |i| bits[i] == 1 }
    return derive { |_b, _e| [] } if onsets.empty?
    # 每段的**起点位置** ✓ 与**时长** ✓（都按"步"算 ✓，再除以 n 换到圈 ✓）
    segs = onsets.each_with_index.map do |pos, idx|
      nxt = onsets[(idx + 1) % onsets.size]
      len = ((nxt - pos) % n)
      len = n if len.zero? # 只有一个起点时，它占满整圈 ✓
      [Rational(pos, n), Rational(len, n)]
    end
    derive do |b, e|
      # ⚠️ **内层只查一次** ✓（第一版我在循环里逐条查 ✓ —— 那样又慢又可能取不到 ✓）
      base = @query.call(b, e).select(&:whole).sort_by { |h| h.whole.begin }
      out = []
      # 每圈的起点都相同 ✓（欧几里得是"每圈重复"的 ✓）
      (b.floor..(e.ceil - 1)).each do |c|
        segs.each_with_index do |(pos, len), idx|
          s = c + pos
          f = c + pos + len
          pb = [s, b].max
          pe = [f, e].min
          next unless pb < pe
          # 该段用内层的第 idx 条（不足则循环取 ✓ —— 内层事件一般比段少 ✓）
          val = base.empty? ? nil : base[idx % base.size].value
          out << Hap.new(s..f, pb..pe, val)
        end
      end
      out.compact.sort_by { |h| [h.part.begin, h.whole.begin] }
    end
  end

  # `last_of(n) { … }`：**每 n 圈里，最后一圈**做那个变换 ✓（普查 ⑤ ✓）。
  #
  # 上游原文 ✓（`pattern.mjs:2433` ✓）：
  #
  #     lastOf(n, func, pat) { const pats = Array(n - 1).fill(pat); pats.push(func(pat));
  #                            return slowcatPrime(...pats); }
  #
  # **读法** ✓：`slowcatPrime(p, p, …, f(p))` ✓ = 第 0..n−2 圈用**原样** ✓、
  # 第 n−1 圈用**变换后**的 ✓ —— 然后**每 n 圈循环** ✓。
  #
  # ⚠️ **`slowcatPrime` 与我们已有的 `<…>` 交替的区别** ✗：
  # `<a b>` 是"**每圈换一项**" ✓（周期 = 项数 ✓）；
  # `lastOf` 是"**n 圈里只有最后一圈不同**" ✓（周期 = n ✓）。
  # 两者在 n = 2 时**恰好一样** ✓（`<p f(p)>` ✓）—— 所以 `lastOf` 的价值在 n > 2 ✓。
  #
  # ⚠️ **`f` 是"接受 pattern、返回 pattern"的函数** ✓（`rev` / `slow` 那类 ✓）。
  def last_of(n, &f)
    n = n.to_i
    raise ArgumentError, "last_of 的圈数必须是正整数（给了 #{n}）" if n < 1
    derive do |b, e|
      out = []
      (b.floor..(e.ceil - 1)).each do |c|
        src = (c % n) == (n - 1) ? f.call(self) : self
        lo = [c, b].max
        hi = [c + 1, e].min
        next unless lo < hi
        src.query_arc(lo, hi).each { |h| out << h }
      end
      out.sort_by { |h| [h.part.begin, h.whole ? h.whole.begin : 0r] }
    end
  end

  # `palindrome`：**每隔一圈 `rev`** ✓（上游 = `lastOf(2, rev)` ✓，`pattern.mjs:2871` ✓）。
  #
  # → 第 0 圈原样 ✓、第 1 圈倒放 ✓、第 2 圈原样 ✓ … ✓
  #
  # ⚠️ **它与 `rev` 不同** ✗：`rev` 是**每一圈**都倒 ✓；
  # `palindrome` 是**隔着来** ✓ —— 听感是"正-反-正-反" ✓。
  def palindrome
    last_of(2) { |p| p.rev }
  end

  # `ply(n)`：**每条事件在它自己的时长内重复 n 次** ✓（普查里的 ③ ✓）。
  #
  # 上游原文 ✓（`pattern.mjs:2337` ✓）：
  #
  #     ply(factor, pat) { return pat.fmap((x) => pure(x)._fast(factor)).squeezeJoin(); }
  #
  # **读法** ✓：把每条事件换成"**它自己的值、加速 n 倍**" ✓，再"**挤进**它原先那一段时间" ✓
  # → 那一段里出现 n 个同样的音 ✓。
  #
  # ⚠️ **`ply` / `!n` / `*n` 是三件事** ✗（最容易混 ✓）：
  #
  #   | 写法 | 作用对象 | 效果 |
  #   |---|---|---|
  #   | `a!2` ✓ | **结构** ✓ | 那个元素**变成 2 个 step** ✓（`bd!2 cp` = `bd bd cp` ✓）|
  #   | `a*2` ✓ | **元素自己** ✓ | 那**一个 step** 里塞 2 份 ✓（`bd*2 cp` = `bd bd` 挤在原位 ✓）|
  #   | `ply(2)` ✓ | **每条事件** ✓ | 事件**产生之后** ✓，在**它自己的时长**内重复 ✓ |
  #
  # `ply` 与 `*n` 的差别在**不等分**时显形 ✓：`"a@3 b"` 用 `ply(2)` ✓ →
  # `a` 在它那 3/4 圈里重复 2 次 ✓、`b` 在 1/4 圈里重复 2 次 ✓（**各按自己的时长** ✓）。
  def ply(n)
    n = n.to_i
    raise ArgumentError, "ply 的次数必须是正整数（给了 #{n}）" if n < 1
    return self if n == 1
    derive do |b, e|
      out = []
      @query.call(b, e).each do |h|
        # 连续信号没有 `whole` ✓ → 原样返回（`ply` 对信号无意义 ✓，但别崩 ✗）
        if h.whole.nil?
          out << h
          next
        end
        ws = h.whole
        step = (ws.end - ws.begin) / n
        (0...n).each do |i|
          s = ws.begin + step * i
          f = ws.begin + step * (i + 1)
          pb = [s, b].max
          pe = [f, e].min
          next unless pb < pe
          out << Hap.new(s..f, pb..pe, h.value)
        end
      end
      out.sort_by { |h| [h.part.begin, h.whole ? h.whole.begin : 0r] }
    end
  end

  # `inside(f) { … }`：**在一个窗内部**做变换 ✓ —— `swing` 的构件 ✓（普查 ④ ✓）。
  #
  # 上游原文 ✓（`pattern.mjs:2407` ✓）：
  #
  #     inside(factor, f, pat) { return f(pat._slow(factor))._fast(factor); }
  #
  # **读法** ✓：先**按 f 把时间放大** ✓（于是"一整圈"变成"f 圈" ✓）、
  # 在这个放大后的坐标里做变换 ✓、**再压回来** ✓ ——
  # 效果是"变换只在**这个窗的内部**发生" ✓，而不是跨圈 ✓。
  #
  # ⚠️ `f` 是"**接受 pattern、返回 pattern**"的函数 ✓（`slow` / `late` 都是这种 ✓）。
  def inside(factor, &f)
    f.call(slow(factor)).fast(factor)
  end

  # `swing_by(amount, n)` ✓ —— 每 `n` 份里，**后半份推后** `amount` ✓（摇摆 ✓）。
  #
  # 上游原文 ✓（`pattern.mjs:2699` ✓）：
  #
  #     swingBy(swing, n, pat) { return pat.inside(n, late(seq(0, swing / 2))); }
  #     swing(n, pat)          { return pat.swingBy(1 / 3, n); }
  #
  # **逐字翻译** ✓：
  #   * `seq(0, swing/2)` ✓ = 一个"**每窗交替 0 / swing/2**"的**位移量** ✓；
  #   * `late(那个位移量)` ✓：按它把内容推后 ✓ —— 在**放大后的坐标**里 ✓；
  #   * `inside(n, …)` ✓：把这一切限制在**每一圈**之内 ✓。
  #
  # ⚠️ **位移量要"随时间变"** ✓，而 `late` 收的是**一个数** ✗ ——
  # 所以这里让 `shift` 支持"**按窗算位移量**" ✓（见 `shift` 的注释 ✓），
  # 而**不引入 `seq`** ✗（那会多一个只在这里用一次的构造 ✓）。
  #
  # **效果** ✓：`swing(4)` = `swing_by(1/3, 4)` ✓ → 八分音变成"**长-短**"的摇摆 ✓。
  def swing_by(amount, n)
    amount = amount.to_r
    n = n.to_i
    raise ArgumentError, "swing_by 的份数必须是正整数（给了 #{n}）" if n < 1
    # 放大后的坐标里：第 i 窗（共 n 窗）→ 位移量 = i 为偶数 ? 0 : amount/2 ✓
    self.inside(n) { |pat| pat.shift_proc(->(win) { win.to_i.even? ? 0r : amount / 2 }) }
  end

  # `swing(n)` = `swing_by(1/3, n)` ✓（上游的简写 ✓）
  def swing(n)
    swing_by(Rational(1, 3), n)
  end

  # 位移量**按窗变化**的版本 ✓（`swing` 用它 ✓）：
  # `f` 收到"**这条事件所在的第几窗**"（整数 ✓），返回该窗的位移量 ✓。
  #
  # ⚠️ **这里我错了两次** ✗，两次都不报错、只是静默没效果 ✓（最坏那种 ✓）：
  #
  #   ① 把 `b` 本身当窗号 ✓ → 查询 `[0,1)` 时 `b = 0` ✓ → 永远第 0 窗 ✓；
  #   ② 改成 `b.floor` 之后**仍然错** ✗ —— 因为 **`Pattern#query` 每次查询只被调用一次** ✓，
  #      而一次查询会**横跨多个窗** ✓ → 用一个位移量搬走**窗内所有事件** ✓ → 仍然是错的 ✓。
  #
  # ⚠️ **正确的顺序是"先取事件、再按事件搬"** ✓：
  # 先原样查内层 ✓，再对**每一条事件**按它自己所在的窗算位移量 ✓，然后单独搬它 ✓。
  # **不能反过来** ✗（先搬查询区间 ✗）—— 那是 ①② 两次错误的共同根源 ✓。
  def shift_proc(f)
    derive do |b, e|
      out = []
      @query.call(b, e).each do |h|
        if h.whole.nil?
          out << h
          next
        end
        # 这条事件属于哪一窗 ✓（放大后的坐标里"一圈 = 一窗" ✓）
        x = f.call(h.whole.begin.floor).to_r
        out << Hap.new((h.whole.begin - x)..(h.whole.end - x),
                       (h.part.begin - x)..(h.part.end - x), h.value)
      end
      out.sort_by { |h| [h.part.begin, h.whole ? h.whole.begin : 0r] }
    end
  end

  #
  # 上游原文 ✓（`pattern.mjs:3057` ✓）：
  #
  #     const _iter = function (times, pat, back = false) {
  #       times = Fraction(times);
  #       return slowcat(...listRange(0, times.sub(1)).map((i) =>
  #         back ? pat.late(Fraction(i).div(times)) : pat.early(Fraction(i).div(times))));
  #     };
  #
  # **读法** ✓：`slowcat(p0…p_{n-1})` 让第 `i` 项占**第 i 圈** ✓；
  # 而第 `i` 项是 `pat.early(i/n)` ✓ → **每圈把内容多移一个子段** ✓。
  #
  # ⚠️ **平移量是 `i/n`，不是 `i`** ✗ —— 我先前猜 `i` ✓，**错了** ✓：
  # 文档那句 *"increments the starting **subdivision** each cycle"* ✓ 说的是**子段** ✓，不是元素 ✗。
  #
  # ⚠️ **不能简化成"把值循环移位"** ✗ —— 那对**等分**的 pattern 恰好等价 ✓，
  # 但对 `"a@3 b"` 这类**不等分**的就会错 ✗。所以这里**照机制**做 ✓（用 `early` ✓）。
  def iter(n)
    n = n.to_i
    raise ArgumentError, "iter 的次数必须是正整数（给了 #{n}）" if n < 1
    return self if n == 1
    derive do |b, e|
      # 逐圈处理 ✓（`slowcat` 的语义 ✓）
      out = []
      last = e.ceil - 1
      (b.floor..last).each do |c|
        i = c % n
        shifted = shift(Rational(i, n))
        lo = [c, b].max
        hi = [c + 1, e].min
        next unless lo < hi
        shifted.query_arc(lo, hi).select(&:whole).each { |h| out << h }
      end
      out.sort_by { |h| [h.part.begin, h.whole.begin] }
    end
  end

  # `iterBack(n)`：同上，但用 `late` ✓（上游 `back = true` ✓）
  def iter_back(n)
    n = n.to_i
    raise ArgumentError, "iterBack 的次数必须是正整数（给了 #{n}）" if n < 1
    return self if n == 1
    derive do |b, e|
      out = []
      last = e.ceil - 1
      (b.floor..last).each do |c|
        i = c % n
        shifted = shift(-Rational(i, n))
        lo = [c, b].max
        hi = [c + 1, e].min
        next unless lo < hi
        shifted.query_arc(lo, hi).select(&:whole).each { |h| out << h }
      end
      out.sort_by { |h| [h.part.begin, h.whole.begin] }
    end
  end

  private

  # 内容左移 `x` 圈 ✓（`x > 0` 提前 ✓、`x < 0` 推后 ✓）
  def shift(x)
    derive do |b, e|
      @query.call(b + x, e + x).map do |h|
        ws = h.whole ? ((h.whole.begin - x)..(h.whole.end - x)) : nil
        ps = (h.part.begin - x)..(h.part.end - x)
        Hap.new(ws, ps, h.value)
      end.sort_by { |h| [h.part.begin, h.whole ? h.whole.begin : 0r] }
    end
  end

  public

  # rev()：在一圈内左右翻转。
  #
  # 三个坑都是探针 2 跑出来的，第一次全写错了：
  #   * 取值必须对**数与 Range 都成立** —— 只处理数时 `lo + 1 - r` 在 r 是 Range 时抛
  #     "Range can't be coerced into Integer"；
  #   * **过滤必须按 whole，不能按 part** —— 翻转后 part 的两端互换了，拿它去和原查询窗比较
  #     等于把条件反过来，于是事件被错误丢弃。Strudel 的规则也是这个：一条事件属于某个查询，
  #     当且仅当它的 **whole** 与查询区间相交；
  #   * **必须按 whole.begin 重新排序** —— 事件顺序是由 whole 定的（`Mini.pattern` 就是这么给的），
  #     而翻转后取到的还是翻转前的顺序，不排序就会表现为"rev 一次好像没变"。
  def rev
    derive do |b, e|
      # ⚠️ **必须把查询窗覆盖到的**每一圈**都翻** ✗ ——
      # 第一版只取 `b.floor` 那一圈 ✓，于是**跨圈查询会丢掉别圈的事件** ✗。
      # **这个 bug 被回归快照瞒了很久** ✓：快照里 `rev` 的用例**全是单圈查询** ✗（`0, 1` ✓），
      # 所以一直没显形 ✓ —— 直到 `inside`（也就是 `swing`）需要"跨圈查 `rev`" ✓ 才暴露 ✓。
      # **教训** ✓：**新算子会用到旧算子的"没被测过的用法"** ✓ ——
      # 所以"跨圈查询"应当成为**每个算子的常规判据** ✓，而不是特例 ✓。
      out = []
      (b.floor..(e.ceil - 1)).each do |lo|
        @query.call(lo, lo + 1).each do |h|
          # ⚠️ **连续信号进 rev 是无意义的** ✗ —— 它没有"事件区间"可供翻转 ✓
          #（`whole` 是 nil ✓）。**报错，不静默** ✓，也不让它以 `nil.begin` 崩掉 ✗
          #（第一版就是崩的 ✓，测试当场中断 ✓）。
          raise ArgumentError, "rev 不能用在连续信号上（它没有可翻转的事件区间）—— 先用 psegment 离散化" if h.whole.nil?
          out << Hap.new(reflect(h.whole, lo), reflect(h.part, lo), h.value)
        end
      end
      out.select { |h| h.whole.begin < e && h.whole.end > b }
         .sort_by { |h| h.whole.begin }
    end
  end

  def map_values
    derive { |b, e| @query.call(b, e).map { |h| Hap.new(h.whole, h.part, yield(h.value)) } }
  end

  # ── ⚠️ **第六阶段 ⑥：音高类算子** ✓ ─────────────────────────────────────────────────────
  #
  # **前提** ✓（普查 §8 第 3 项 ✓）：**音阶复用 Sonic Pi 自己的** ✓ ——
  # 因为我们在 Sonic Pi 里跑 ✓，而它**已经有** `scale` / `chord` ✓。
  # **造第二套音阶名字** ✗ 会让同一个文件里出现两套说法 ✓（`scale(:c3, :major)` 与
  # `"C:major"` ✗）—— 那是本项目一贯避免的 ✓。
  #
  # ⚠️ **代价** ✓：这一族**不能在离线环境里独立验证** ✗（`scale` 只在 Sonic Pi 会话里有 ✓）。
  # 所以这里的做法是 ✓：**纯运算的那部分照常离线判据** ✓（`run` / `transpose` ✓），
  # 而**依赖 Sonic Pi 的那部分**用一个**可注入的查表函数** ✓ ——
  # 离线时注入一张**测试用的小音阶** ✓（判据能跑 ✓），在线时注入 **Sonic Pi 的 `scale`** ✓。
  # 这样"**音阶数据**"一定是 Sonic Pi 的 ✓，而"**映射算法**"仍然可测 ✓。

  # `transpose(n)`：**按半音移调** ✓
  def transpose(n)
    raise ArgumentError, "transpose 需要数字（给了 #{n.class}）" unless n.is_a?(Numeric)
    map_values do |v|
      # ⚠️ 合成后的字典值不能做数值变换 ✓（用户决定 6 ✓，规格 §11.2 ✓）
      if v.is_a?(Hash)
        raise ArgumentError, 'ptranspose 不能作用在逐事件参数（Hash）上；请对**各层**分别做移调'
      end
      v.is_a?(Numeric) ? v + n : v
    end
  end

  # ⚠️ **`step` 我去掉了** ✗（原计划里有一个 ✓）—— 理由如下 ✓：
  #
  # 我凭记忆以为 Strudel 有 `step` ✓（还写了"上游是 `x + x * i`" ✓ —— **那是我编的** ✗）。
  # **查证结果** ✓：把 `packages/core/` 下的
  # `pattern.mjs` / `signal.mjs` / `controls.mjs` / `euclid.mjs` / `stepwise.mjs` / `util.mjs` / `fraction.mjs`
  # **全搜了一遍** ✓ —— **没有 `step` 这个算子** ✗（只有 `signal.mjs:343` 的 `run` ✓）。
  #
  # **为什么不"自己发明一个"** ✗：那正是本项目一贯反对的 ✓ ——
  # 从 Strudel 抄来的写法**行为不同** ✗ 会让人踩坑 ✓，而"我们发明的 `step`"**没有上游可对照** ✓，
  # 将来对不上也没法判断谁对 ✓。**所以宁缺勿滥** ✗。
  #
  # ⚠️ **如果将来真需要"`0 k 2k 3k`"** ✓，正确的做法是**给个不含糊的名字** ✓
  #（如 `pstep_by(模式, k)` ✓），并**在文档里说明它不是上游的** ✓ —— 而不是借用一个我记错的算子名 ✗。

  # ── ⚠️ **第六阶段 ⑦：窗口类算子** ✓ ─────────────────────────────────────────────────────
  #
  # 四个都是"**在一圈里挑一段**"的不同处理 ✓。上游的实现都是"查询区间与事件区间各做一次映射" ✓
  #（`withQuerySpan` / `withHapSpan` ✓），但**净效果都很简单** ✓ —— 所以我们照净效果直写 ✓。
  #
  # ⚠️ **为什么不做上游那种"映射查询区间"** ✗：我们的模型里 ✓ **一个查询可能横跨多圈** ✓
  #（甚至很多圈 ✓），而"映射"必须**逐圈**做 ✓ —— 所以本来就得分圈 ✓。
  # 分圈之后"**查哪一段、结果搬回哪儿**"就很直白 ✓，不需要那套 span 变换 ✓。

  # `zoom(s, e)` ✓：**只播一圈的 `[s, e)` 段，并把它拉伸到整圈** ✓
  #
  # 上游原文 ✓（`pattern.mjs:2541` ✓）：
  #
  #     zoom(s, e, pat) { const d = e.sub(s);
  #       return pat.withQuerySpan((span) => span.withCycle((t) => t.mul(d).add(s)))
  #                 .withHapSpan((span) => span.withCycle((t) => t.sub(s).div(d)))
  #                 .splitQueries(); }
  #
  # **读法** ✓：查询时间 `t` → 源码里的 `s + t·d` ✓；事件时间 `u` → 输出的 `(u − s)/d` ✓。
  # **两个映射互为逆** ✓ —— 净效果就是"**把 `[s,e)` 抠出来铺满整圈**" ✓。
  #
  # ⚠️ **第一版"逐圈调用 `@query`"是错的** ✗（这修法值得记下来 ✓）：
  # 我按每一圈各算一个子区间、各查一次 ✓ —— 结果**跨圈的事件被两个子区间都查到** ✓
  # → **同一条事件出现两次** ✗（`linger` 里 `slow(1/2)` 让事件跨圈 ✓ 就暴露了 ✓）。
  # **正确做法** ✓：**先查一次**（覆盖整个映射后的区间 ✓），
  # 再按"**事件的 `whole` 落在哪一圈**"把它映射过去 ✓ —— 这样每条事件**只会被算一次** ✓。
  # ⚠️ 归属要用 **`whole`**（事件本身 ✓）而不是 `part`（被查询窗裁过 ✓）——
  # 这与 `rev` 那条规矩是同一个 ✓（见 `docs/dev-discipline.md` ✓）。
  def zoom(s, e)
    s = s.to_r
    e = e.to_r
    raise ArgumentError, "zoom 要求 s < e（给了 #{s}..#{e}）" unless s < e
    d = e - s
    derive do |b, qe|
      # ⚠️ **映射是仿射的** ✓（`t → s + t·d` ✓），所以"输出的 `[b, qe)`"整段映射过去就是
      # **一个区间** ✓ —— 不需要逐圈算 ✗（我第一版逐圈算，正是重复事件的根因 ✓）。
      out = @query.call(s + b * d, s + qe * d).select(&:whole).map do |h|
        ws = ((h.whole.begin - s) / d)..((h.whole.end - s) / d)
        ps = ((h.part.begin - s) / d)..((h.part.end - s) / d)
        Hap.new(ws, ps, h.value)
      end
      # 过滤按 **`whole`** ✓（事件本身 ✓，不是被查询窗裁过的 `part` ✓ —— 与 `rev` 同一条规矩 ✓）
      out.select { |h| h.whole.begin < qe && h.whole.end > b }
         .sort_by { |h| [h.part.begin, h.whole.begin] }
    end
  end

  # `compress(b, e)` ✓：**把整段压进一圈的 `[b, e)`** ✓、**其余静音** ✓
  #
  # 上游原文 ✓（`pattern.mjs:2262` ✓）：
  #
  #     compress(b, e, pat) { return pat._fastGap(1/(e-b))._late(b); }
  #
  # **读法** ✓：先"**加速 `1/(e−b)` 倍但不重复**" ✓（=`fast_gap` ✓ → 只有前 `(e−b)` 份有内容 ✓），
  # 再**推后 `b`** ✓ → 内容落在 `[b, e)` ✓、其余为空 ✓。
  #
  # ⚠️ **与 `zoom` 的区别** ✗（最容易混 ✓）：
  #   * `zoom(b, e)` ✓：**只播**这一段 ✓，**拉伸到整圈** ✓ → **整圈都有内容** ✓；
  #   * `compress(b, e)` ✓：播**整段** ✓，但**压进** `[b, e)` ✓ → **圈里其余部分为空** ✓。
  def compress(b, e)
    b = b.to_r
    e = e.to_r
    raise ArgumentError, "compress 要求 0 <= b < e <= 1（给了 #{b}..#{e}）" unless b >= 0 && b < e && e <= 1
    d = e - b
    derive do |qlo, qhi|
      # 输出 `[qlo, qhi)` → 压缩后坐标减去 `b` ✓，再乘 `d` 换到源码坐标 ✓
      slo = (qlo - b) * d
      shi = (qhi - b) * d
      @query.call(slo, shi).map do |h|
        ws = h.whole ? ((h.whole.begin / d + b)..(h.whole.end / d + b)) : nil
        ps = (h.part.begin / d + b)..(h.part.end / d + b)
        Hap.new(ws, ps, h.value)
      end.sort_by { |h| [h.part.begin, h.whole ? h.whole.begin : 0r] }
    end
  end

  # `fast_gap(k)` ✓：**加速 k 倍，但不重复** ✓（后面留空 ✓）
  #
  # 上游原文 ✓（`pattern.mjs:2283` ✓）：查询位置按 `k` 缩放并**截到 1** ✓（`min(1)` ✓）
  # → 超过 1 的部分**没有内容** ✓ → **只有前 `1/k` 份有内容** ✓、**不重复** ✗。
  # **这正是它与 `fast` 的区别** ✓（上游文档：*"leave a gap in the remaining space of the cycle"* ✓）。
  #
  # **实现** ✓：**查询级**变换 ✓（照上游 `pattern.mjs:2283` 的 `qf`/`ef` 两个映射 ✓）：
  #   * 查询窗口：`[b, e)` 先乘 `k` ✓，**再截到 1** ✓（`min(1)` ✓）；起点已经 ≥1 → **没有内容** ✓
  #   * 事件时间：除以 `k` ✓，同样**截到 1** ✓
  #
  # ⚠️⚠️ 两个错都踩过 ✗（2026-10-19 ✓）：
  #   ① 只写 `compress(0, 1/k)` ✗ —— 那是**拉伸** ✗（实测：`a b` 只出 **1** 个事件、`a` 占满一圈 ✗）
  #   ② 写 `fast(k).compress(0, 1/k)` ✗ —— 压回去又拉长 ✗（实测：`a@0–0.5, b@0.5–1` ✗）
  #   **都不能用"组合"表达** ✗ —— 必须像上游那样做**两个映射** ✓。
  #   判据抓不到的原因 ✗：`test-verb-coverage` 只比"动词 ≡ 方法" ✓ → **两边一起错**就看不出来 ✗。
  class FastGap < Pattern
    def initialize(pat, factor)
      @pat = pat
      @k = factor.to_r
      @query = lambda do |b, e|
        out = []
        c0 = b.floor
        c1 = (e - Rational(1, 1_000_000)).floor
        (c0..c1).each do |c|
          sb = [b, c.to_r].max
          se = [e, c + 1r].min
          ib = (sb - c) * @k
          ie = (se - c) * @k
          ib = 1r if ib > 1
          ie = 1r if ie > 1
          next if ib >= 1 || ie <= ib

          @pat.query_arc(c + ib, c + ie).each do |h|
            nb = ((h.part.begin - c) / @k) + c
            ne = ((h.part.end - c) / @k) + c
            nw = h.whole && (((h.whole.begin - c) / @k) + c)..(((h.whole.end - c) / @k) + c)
            nb = c + 1r if nb > c + 1
            ne = c + 1r if ne > c + 1
            next if nb >= ne

            out << Hap.new(nw, nb..ne, h.value)
          end
        end
        out.sort_by { |h| [h.part.begin, h.whole ? h.whole.begin : 0r] }
      end
    end
  end

  def fast_gap(k)
    k = k.to_r
    raise ArgumentError, "fast_gap 的倍数必须 > 0（给了 #{k}）" unless k.positive?
    FastGap.new(self, k)
  end

  # `linger(t)` ✓：**只播一圈的前 `t` 份，并拉伸到整圈** ✓（其余静音 ✓）
  #
  # 上游原文 ✓（`pattern.mjs:2664` ✓）：
  #
  #     linger(t, pat) { if (t == 0) return silence;
  #                      else if (t < 0) return pat._zoom(t+1, 1)._slow(t);
  #                      return pat._zoom(0, t)._slow(t); }
  #
  # **读法** ✓：`zoom(0, t)` 把前 `t` 份**压缩**铺满整圈 ✓；
  # 再**拉伸 `1/t` 倍** ✓ → 它只占**前 `t` 份** ✓、**后面留空** ✓。
  #
  # ⚠️ **方向我搞反过一次** ✗，值得记下来 ✓：
  # 上游写的是 `_slow(t)` ✓，我照着写 `slow(t)` ✓ —— 但**我们的 `slow(k)` 是"压缩"** ✓
  #（实测：`"a b".slow(2)` 在前两圈只给一条 `a @0..1` ✓ —— 那是**压缩** ✓，不是拉伸 ✗）。
  # 而我要的是"**把前 `t` 份拉伸到整圈**" ✓ → 所以该是 **`slow(1/t)`** ✓（= 拉伸 ✓）。
  # **教训** ✓：**`slow` 这个名字在两边方向相反** ✗ ——
  # 照名字抄会错 ✓，**照可观察行为写才不会错** ✓（实测一跑就露 ✓）。
  #
  # ⚠️ **它同时是 `zoom` 与 `compress` 的混合** ✓ —— 是"**取前 `t` 份并拉满**" ✓，
  # 而**不是**"取前 `t` 份放在开头、其余静音" ✗（那要用 `compress` ✓）。
  def linger(t)
    t = t.to_r
    raise ArgumentError, "linger 的份数不能为 0" if t.zero?
    if t.negative?
      zoom(t + 1, 1r).slow(1r / t)
    else
      zoom(0r, t).slow(1r / t)
    end
  end

  # `scale_degrees_of(name)` ✓：把**值当音阶级数**映射到音高 ✓（第六阶段 ⑨ ✓）
  #
  # ⚠️ **阶数不是半音** ✗：`0` → 根音 ✓、`1` → 音阶的第二个音 ✓、
  # `7`（大调里）→ 高八度 ✓、`-1` → 根音下面一个**音阶音** ✓。
  # 非数字的值**原样通过** ✓（不崩 ✓，也不做事 ✓）。
  def scale_degrees_of(root, name)
    root = root.to_i
    # 先验一次音阶名 ✓ —— 名字写错要**立刻报** ✓，而不是等到查询时才炸 ✓
    PScale.degrees_of(name)
    map_values do |v|
      # ⚠️ 合成后的字典值不能做数值变换 ✓（用户决定 6 ✓）
      if v.is_a?(Hash)
        raise ArgumentError, 'pscale_to 不能作用在逐事件参数（Hash）上；请对**各层**分别做音阶映射'
      end
      v.is_a?(Numeric) ? PScale.pitch_of(v, root, name) : v
    end
  end

# `chord_pitches_of(root = nil)` ✓：把**值当和弦名**映射成音高数组 ✓（第六阶段 ⑩ ✓）
#
# ⚠️ **一个事件的值会是"多个音"** ✓（数组 ✓）—— 那是**和弦** ✓。
# 非名字的值**原样通过** ✓（不崩 ✓）；名字写错**报错** ✓（不静默 ✗）。
#
# ⚠️ **一律从根音往上堆** ✓ —— **不做任何"聪明"的事** ✗（转位 / 就近走是 `pvoicing` ✓，
# 它**还没实现** ✗，设计见 `docs/plan/pattern-chord-spec.md` ✓）。
#
# ## `root` 可以给 `nil` ✓ —— 那就**从每个值里自带根音** ✓
#
# 写法 ✓：`"57:minor"` / `"e3:minor7"` ✓（和 Strudel 的 `Am` 一个意思 ✓：根音 + 性质在一个 token 里 ✓）。
# 于是和弦演进可以写成 ✓：
#   `pplay parrange([4, "57:minor"], [4, "53:major"]), use: :play_chord` ✓
# 不用为每段单独写一次 `pchord(...)` ✓。
def chord_pitches_of
  map_values do |v|
    # ⚠️ 合成后的字典值不能做数值/名字变换 ✓（用户决定 6 ✓）
    if v.is_a?(Hash)
      raise ArgumentError, 'pchord 不能作用在逐事件参数（Hash）上；请对**各层**分别做'
    end
    next v unless v.is_a?(Symbol) || v.is_a?(String)
    name = v.to_s
    # `根音:性质` —— 冒号右侧是性质，左侧是根音（MIDI 数字或音名）
    left, sep, right = name.rpartition(':')
    this_root = (sep.empty? || left.empty? || right.empty?) ? nil : PChord.root_to_midi(left)
    if this_root.nil?
      raise ArgumentError,
            "`pchord` 的值要写成 `根音:性质`（例 `\"57:minor\"` 或 `\"e3:minor7\"`）；" \
            "收到 #{v.inspect}"
    end
    PChord.pitches_of(this_root, right)
  end
end


  # `run(n)`：**一圈里离散地走 `0..n-1`** ✓（第六阶段 ⑥ ✓）
  #
  # 上游文档 ✓："A discrete pattern of numbers from 0 to n-1" ✓ ——
  # `n(run(4)).scale("C4:pentatonic")` ✓ 等价于 `n("0 1 2 3")` ✓。
  #
  # ⚠️ **它是"值序列"，不是"控制"** ✓ —— 所以 `prun(4)` 给的是四条事件、值分别是 `0..3` ✓。
  # 单用它听起来是"没意义"的 ✓（值就是数字 ✓）—— 它的用途是**喂给别的算子** ✓
  #（如 `ptranspose` / 音阶 ✓），这正是上游文档里那个用法的意思 ✓。
  #
  # 它和 `ppattern("0 1 2 3")` **在默认字典下恰好一样** ✓ —— 但 `run` 的好处是
  # **n 可以是表达式** ✓（`prun(k)` ✓），不必拼字符串 ✓。
  def self.run(n)
    raise ArgumentError, "run 的数量必须是正整数（给了 #{n.inspect}）" unless n.is_a?(Integer) && n.positive?
    Mini.pattern((0...n).to_a.join(" "))
  end

  # `range_of(n, lo, hi)`：**在 `[lo, hi]` 上离散地取 n 个值** ✓（`run` 的常用搭档 ✓）
  #
  # 上游有 `range(lo, hi)` ✓（默认 8 步 ✓）—— 这里**显式给 n** ✓，
  # 因为"默认几步"是个**方言** ✓（上游是 8 ✓），而显式更清楚 ✓。
  def self.range_of(n, lo, hi)
    raise ArgumentError, "range_of 的数量必须是正整数（给了 #{n.inspect}）" unless n.is_a?(Integer) && n.positive?
    raise ArgumentError, "range_of 的 lo 必须小于 hi（给了 #{lo}..#{hi}）" unless lo < hi
    Mini.pattern((0...n).map { |i| (lo + (hi - lo) * Rational(i, [n - 1, 1].max)).round(4).to_f.to_s }.join(" "))
  end

  private

  # 在一圈内翻转一个时间点或一个区间：t -> lo + (lo + 1 - t)。
  # 数与 Range 都要能过 —— Range 要**反向**构造（end 先算），否则会得到倒置的区间。
  # 把一条事件的时间量**关于第 `lo` 圈做反射** ✓（`rev` 用 ✓）。
  #
  # **一个公式，数与区间通用** ✓（上游也是这么写的 ✓，`pattern.mjs` 的 `rev`）：
  #     reflect(t) = lo + (lo + 1 - t)          # 关于 [lo, lo+1) 的中点反射 ✓
  #
  # ⚠️ **区间的端点必须交换** ✗：反射把 `begin` 映到 `end` 之后 ✓，
  # 所以 `[u, v)` 反射后是 `[reflect(v), reflect(u))` ✓ —— 直接照原序写会得到**倒置的区间** ✗
  #（`rev` 最早就是这么错的 ✓，测试当场抓到 ✓）。
  #
  # ⚠️ **这件事对"跨圈的事件"同样成立** ✓ —— 这正是 `inside`/`swing` 暴露出来的那个 bug 的根源 ✓：
  # 我原来按**事件自己的区间**翻转 ✓（`lo + 1 - x.end` 之类 ✓），
  # 那对"整条落在本圈内"的事件恰好正确 ✓，但 `slow(2)` 之后的事件**跨圈** ✓
  # → 翻转结果跑到本圈之外 ✓ → 被过滤掉 ✓ → **静默丢音** ✗。
  # **关于圈反射**（而不是关于事件自己反射 ✓）才对所有情况都成立 ✓。
  def reflect(x, lo)
    if x.is_a?(Range)
      (lo + Rational(lo + 1) - x.end)...(lo + Rational(lo + 1) - x.begin)
    else
      lo + (lo + 1 - x)
    end
  end

  # 旧名字保留 ✓（`flip_span` 与 `reflect` 是同一件事 ✓，见上面的说明 ✓）
  def flip_span(x, lo)
    reflect(x, lo)
  end

  # 把一条事件的区间按比例缩放（用于 fast/slow）
  def scale(h, factor)
    Hap.new(h.whole.begin * factor..h.whole.end * factor,
            h.part.begin * factor..h.part.end * factor,
            h.value)
  end
end

# ---------------------------------------------------------------------------------------------
# Arrange：**曲式** ✓（第六阶段 ✓）—— "前 4 圈这样、后 2 圈那样" ✓。
#
# ⚠️ **机制是照上游实现写的** ✓（`pattern.mjs:1876` ✓）：
#
#     export function arrange(...sections) {
#       const total = sections.reduce((sum, [cycles]) => sum + cycles, 0);
#       sections = sections.map(([cycles, section]) => [cycles, section.fast(cycles)]);
#       return stepcat(...sections).slow(total);
#     }
#
# ⚠️ **后果必须说清** ✗ —— 这条机制有反直觉的地方 ✓，而**我推不出它的净效果** ✗
#（`fast` + `stepcat` + `slow` 的复合 ✓，我推了多次都不自洽 ✓ —— 见提交记录 ✓）。
# 所以我**照机制实现** ✓，并把可观察的后果**测出来、写进文档** ✓ ——
# **不替它编一个"我觉得应该"的语义** ✗：
#
#   * `arrange([4, "<c a f e>"], [2, "<g a>"])` ✓：
#     段 1 占圈 0..3 ✓、段 2 占圈 4..5 ✓ —— **段的顺序与圈数**是稳的 ✓（有判据 ✓）；
#   * ⚠️ **段内是不是"每圈重复"** ✗：按机制**不是** ✓，而是"**把这段素材铺满它的圈数**" ✓ ——
#     `arrange([2, "c4"], …)` 会得到**一个长音**（占 2 圈 ✓），**不是两个 `c4`** ✗。
#     要重复就**自己写** ✓：`arrange([2, ppattern("c4*2")], …)` ✓。
#
# **为什么不做成"每圈重复"** ✗：那是**我们自己的**语义 ✓，与上游**不一致** ✓ ——
# 而"从 Strudel 抄来的写法行为不同" ✗ 正是本项目一贯避免的 ✓
#（与 `!` vs `*` 那次同一个理由 ✓）。
# ---------------------------------------------------------------------------------------------
# PScale：**音阶数据与映射** ✓（第六阶段 ⑨ ✓）—— **自己带数据** ✓，不依赖 Sonic Pi 的上下文 ✓。
#
# ⚠️ **为什么自己带、而不是去调某个软件的 `scale`** ✗：
# * 那样的函数**只在它自己的会话里存在** ✓（离线实测 `respond_to?(:scale)` 是 `false` ✓）；
#   依赖它 = 让我们的 pattern **只能在那个上下文里跑** ✗ —— 与"能在别处也能跑"的方向冲突 ✓；
# * 而**音阶的音程是公有领域的乐理事实** ✓（大调全全半全全全半 ✓），
#   不是谁的私有数据 ✓。
#
# ⚠️ **写法本身是一个乐理事实** ✓ —— **七种中古调式就是同一个音程序列的七种旋转** ✓：
#
#     ionian = [2, 2, 1, 2, 2, 2, 1]        # 全全半全全全半 ✓
#     major  = ionian
#     dorian = ionian.rotate(1)             # 从第二个音起 ✓ = 全半全全全半全 ✓
#     …                                    # 其余同理 ✓
#
# **这是"算法"而不是"抄表"** ✓ —— 少一份抄错的机会 ✓，也少一份维护负担 ✓。
module PScale
  # 常用音阶 ✓（**够用就好** ✗ —— 不追求覆盖 Sonic Pi 那 100 多个 ✓）
  IONIAN = [2, 2, 1, 2, 2, 2, 1].freeze   # 大调 ✓
  HEX = [2, 2, 1, 2, 2, 3].freeze
  PENTA = [3, 2, 2, 3, 2].freeze          # 小调五声 ✓

  # 音阶名 → **音程序列** ✓（相邻两音之间的半音数 ✓）
  SCALES = {
    # 七种中古调式（**同一个序列的七种旋转** ✓）
    'major' => IONIAN, 'ionian' => IONIAN, 'diatonic' => IONIAN,
    'dorian' => IONIAN.rotate(1),
    'phrygian' => IONIAN.rotate(2),
    'lydian' => IONIAN.rotate(3),
    'mixolydian' => IONIAN.rotate(4),
    'minor' => IONIAN.rotate(5), 'aeolian' => IONIAN.rotate(5),
    'locrian' => IONIAN.rotate(6),
    # 五声 ✓（**一个序列的旋转** ✓，如 Sonic Pi 那样 ✓）
    'minor_pentatonic' => PENTA,
    'major_pentatonic' => PENTA.rotate(1),
    # 六声 ✓
    'hex_major6' => HEX,
    'hex_dorian' => HEX.rotate(1),
    'hex_phrygian' => HEX.rotate(2),
    # 布鲁斯 ✓（六个音 ✓）
    'blues' => [3, 2, 1, 1, 3, 2],
    'minor_blues' => [3, 2, 1, 1, 3, 2],
    # 和声 / 旋律小调 ✓（各一个音不同 ✓ —— 这两条**不是旋转** ✓，所以单独写 ✓）
    'harmonic_minor' => [2, 1, 2, 2, 1, 3, 1],
    'melodic_minor' => [2, 1, 2, 2, 2, 2, 1],
    # 全音阶 ✓
    'whole_tone' => [2, 2, 2, 2, 2, 2]
  }.freeze

  module_function

  # 音阶名 → `[0, 第一个音到根的半音数, …]`（**含高八度 ✓**，与 Sonic Pi 的 `scale` 一致 ✓）
  #
  # `scale(:c3, :major)` 在 Sonic Pi 里给的是 `(60, 62, 64, 65, 67, 69, 71, 72)` ✓ ——
  # **结尾那个 72 是根音的高八度** ✓（所以长度 = 音数 + 1 ✓）。
  def degrees_of(name)
    key = name.to_s.downcase
    seq = SCALES[key]
    raise ArgumentError, "不认识的音阶 `#{name}`（我们支持的见 PScale::SCALES）" unless seq
    acc = 0
    out = [0]
    seq.each { |i| acc += i; out << acc }
    out
  end

  # 把**度数**映射到音高 ✓（度数可以任意大 / 负 ✓ —— 会自动跨八度 ✓）
  #
  # ⚠️ **度数是"音阶里的第几个音"** ✓，**不是半音** ✗ ——
  # 所以 `0 → 根音` ✓、`1 → 根音 + 第一个音程` ✓、`7 → 高八度` ✓。
  #
  # **负数也支持** ✓：`-1` 是根音下面一个音阶音 ✓（不是"根音减半音"✗）。
  def pitch_of(degree, root, name)
    degs = degrees_of(name)
    size = degs.size - 1 # 一个八度里的**音数** ✓（去掉结尾那个高八度 ✓）
    raise ArgumentError, "音阶 `#{name}` 里一个八度没有音" if size < 1
    d = degree.to_i
    oct, idx = d.divmod(size)
    # `idx` 一定在 `0...size` ✓ → `degs[idx]` 有效 ✓
    root + oct * degs.last + degs[idx]
  end

  # 音阶名 → 从一个根音起的一串音高 ✓（`octaves` 个八度 ✓，**末尾带高八度 ✓**）
  #
  # 与 Sonic Pi 的 `scale` 形态一致 ✓：`scale(:c, :major)` → `(60, 62, 64, 65, 67, 69, 71, 72)` ✓ ——
  # **7 个音 + 结尾的高八度 = 8 项** ✓。
  def ring_of(root, name, octaves = 1)
    octaves = octaves.to_i
    raise ArgumentError, "octaves 必须是正整数（给了 #{octaves}）" if octaves < 1
    size = degrees_of(name).size - 1 # 一个八度里的**音数** ✓
    # 取 `octaves` 个八度的音 ✓，再加**结尾的高八度** ✓
    (0..(size * octaves)).map { |i| pitch_of(i, root, name) }
  end
end

# ---------------------------------------------------------------------------------------------
# PChord：**和弦** ✓（第六阶段 ⑩ ✓）—— **数据自己带** ✓，**零依赖** ✓。
#
# ⚠️ **写这一段的规矩** ✓（用户拍的板 ✓）：**乐理事实与任何代码都无关** ✓。
# 所以下面的音程**全部按公式写** ✓，**不抄任何人的表** ✗：
#
#     大三和弦 = 根音 + 4 + 3            （大三度 + 小三度）
#     小三和弦 = 根音 + 3 + 4
#     属七     = 大三和弦 + 10 − 7  =  + 10
#     …
#
# ⚠️ **这与 `PScale` 是同一条决定** ✓：音阶与和弦**都是公有领域的乐理事实** ✓，
# **不是谁的私有数据** ✗。而且**名字也是通用乐理记号** ✓（`major` / `minor7` / `dom7` ✓），
# 更**不是**某个软件的私有词汇 ✓ —— 所以**用它不构成依赖** ✓。
#
# ⚠️ **这一条我犯过两次** ✗：`scale` 那次做对了 ✓（自己带 ✓），
# **`chord` 这次做反了** ✗ —— 我去 `require` 了上游的文件、抄了它 85 条 ✓，
# 于是**判据反过来依赖上游** ✓（上游一改、我们的判据就碎 ✗）。
# **用户一句话点破** ✓：*"乐理事实都不需要跟上游代码有关联"* ✓。
#
# **只挑编曲用得上的** ✓（**23 个** ✓）—— 不追求覆盖一切 ✓。
# 需要更冷门的和弦时，**自己用 `ptranspose` 叠** ✓，或者用原生 `chord()` ✓。
module PChord
  # 名字 → **音程表** ✓（从根音起算的半音数 ✓）
  #
  # ⚠️ **12 = 一个八度** ✓。下表里**只有一条超过 12** ✓（`add9` 的 14 ✓ = 高八度的九音 ✓），
  # 那是**上方延伸** ✓，不是错误 ✓。
  INTERVALS = {
    # ── 三和弦 ✓（three notes ✓）────────────────────────────────────────────────────────
    major:            [0, 4, 7],          # 大三和弦 ✓ 4+3
    minor:            [0, 3, 7],          # 小三和弦 ✓ 3+4
    dim:              [0, 3, 6],          # 减三和弦 ✓ 3+3
    aug:              [0, 4, 8],          # 增三和弦 ✓ 4+4
    sus2:             [0, 2, 7],          # 挂二 ✓（三音换成二音 ✓）
    sus4:             [0, 5, 7],          # 挂四 ✓（三音换成四音 ✓）
    # ── 七和弦 ✓（four notes ✓）─────────────────────────────────────────────────────────
    major7:           [0, 4, 7, 11],      # 大七 ✓（大三和弦 + 11 ✓）
    dom7:             [0, 4, 7, 10],      # 属七 ✓（大三和弦 + 10 ✓）
    minor7:           [0, 3, 7, 10],      # 小七 ✓（小三和弦 + 10 ✓）
    halfdim7:         [0, 3, 6, 10],      # 半减七 ✓（减三和弦 + 10 ✓）
    dim7:             [0, 3, 6, 9],       # 减七 ✓（减三和弦 + 9 ✓ —— **三个小三度叠起来** ✓）
    minmaj7:          [0, 3, 7, 11],      # 小大七 ✓（小三和弦 + 11 ✓）
    # ── 六和弦 ✓（four notes ✓）─────────────────────────────────────────────────────────
    major6:           [0, 4, 7, 9],       # 大六 ✓（大三和弦 + 9 ✓）
    minor6:           [0, 3, 7, 9],       # 小六 ✓（小三和弦 + 9 ✓）
    # ── 九和弦与挂留 ✓（five notes ✓）───────────────────────────────────────────────────
    major9:           [0, 4, 7, 11, 14],  # 大九 ✓（大七 + 14 ✓）
    dom9:             [0, 4, 7, 10, 14],  # 属九 ✓（属七 + 14 ✓）
    minor9:           [0, 3, 7, 10, 14],  # 小九 ✓（小七 + 14 ✓）
    dom7sus4:         [0, 5, 7, 10],      # 属七挂四 ✓
    dom9sus4:         [0, 5, 7, 10, 14],  # 属九挂四 ✓
    # ── 加音与省略 ✓（常见于流行 / 爵士 ✓）─────────────────────────────────────────────
    add9:             [0, 4, 7, 14],      # 加九 ✓（大三和弦 + **上方**九音 ✓ —— 不加七音 ✓）
    minoradd9:        [0, 3, 7, 14],      # 小加九 ✓
    six_nine:         [0, 4, 7, 9, 14],   # 六九 ✓
    power:            [0, 7]              # 空五度 ✓（无三音 ✓ —— 摇滚与垫底常用 ✓）
  }.freeze

  module_function

  # 名字 → `[0, …]` 音程 ✓（符号与字符串都收 ✓ —— `:major` 与 `"major"` 等价 ✓）
  def intervals_of(name)
    key = name.is_a?(Symbol) ? name : name.to_s.to_sym
    iv = INTERVALS[key]
    raise ArgumentError,
          "不认识的和弦 `#{name}`（支持 #{INTERVALS.size} 个：#{INTERVALS.keys.map(&:to_s).sort.join(' ')}）" unless iv
    iv
  end

  # 根音 + 名字 → **音高数组** ✓
  #
  # ⚠️ **一律从根音往上堆** ✓ —— **不做任何"聪明"的事** ✗
  #（转位、就近走、留共同音 —— 那是**声部排布** ✓，
  #  它**还没实现** ✗，设计记在 `docs/plan/pattern-chord-spec.md` ✓）。
  # **分开是故意的** ✓：猜你想要的摆法 ✗ = 替你做了一个你看不见的决定 ✗。
  def pitches_of(root, name)
    r = root.to_i
    intervals_of(name).map { |i| r + i }
  end

  # `根音` → MIDI 数字 ✓（`"57"` ✓ / `"e3"` ✓ / `"eb3"` ✓ / `"c#4"` ✓）
  #
  # ⚠️ **自己解析，不依赖上游** ✓ —— 与 `PScale` / `PChord` 的数据同一个理由 ✓：
  #   上游的 `note` 只在 Sonic Pi 会话里存在 ✓，离线就是 `NoMethodError` ✗。
  # ⚠️ 解析不了就**报错** ✓（不猜 ✗、不静默给 0 ✗）。
  NOTE_BASE = { 'c' => 0, 'd' => 2, 'e' => 4, 'f' => 5, 'g' => 7, 'a' => 9, 'b' => 11 }.freeze
  def root_to_midi(str)
    return nil if str.nil?
    s = str.to_s.strip.downcase
    return s.to_i if s.match?(/\A-?\d+\z/)
    m = s.match(/\A([a-g])([#b]?)(-?\d+)\z/)
    return nil if m.nil?
    semi = NOTE_BASE[m[1]]
    semi += 1 if m[2] == '#'
    semi -= 1 if m[2] == 'b'
    # MIDI：C4 = 60 ✓（八度 -1 起算 ✓）→ c3 = 48 ✓，e3 = 52 ✓
    12 * (m[3].to_i + 1) + semi
  end

  # 支持哪些名字 ✓（自省用 ✓）
  def names
    INTERVALS.keys
  end
end

module Arrange
  module_function

  # `sections` = [[圈数, Pattern], ...] ✓
  # 返回一个**跨多圈**的 Pattern ✓（它的"圈"就是绝对圈 ✓）
  def build(sections)
    raise ArgumentError, "arrange 至少要一段" if sections.empty?
    sections.each do |cycles, pat|
      raise ArgumentError, "arrange 的圈数必须是正整数（收到 #{cycles.inspect}）" unless cycles.is_a?(Integer) && cycles.positive?
      raise ArgumentError, "arrange 的一段必须是 Pattern（收到 #{pat.class}）" unless pat.respond_to?(:query_arc)
    end
    total = sections.sum { |c, _| c }
    # 各段在**总时间轴**上的起止（以圈为单位 ✓）
    spans = []
    acc = 0
    sections.each do |c, pat|
      spans << [acc, acc + c, pat, c]
      acc += c
    end

    __arr = Pattern.new do |b, e|
      out = []
      spans.each do |t0, t1, pat, cycles|
        # 与总时间轴相交吗 ✓
        next unless b < t1 && e > t0
        lo = [b, t0].max
        hi = [e, t1].min
        next unless lo < hi
        # ⚠️ 段内坐标：把 [t0, t1) 映到该段落自己的 `[0, cycles)` ✓
        #（这正是 `fast(cycles)` 之后"那一段的圈" ✓）
        u0 = lo - t0
        u1 = hi - t0
        pat.query_arc(u0, u1).each do |h|
          # 搬回总时间轴 ✓
          ws = h.whole ? ((h.whole.begin + t0)..(h.whole.end + t0)) : nil
          ps = (h.part.begin + t0)..(h.part.end + t0)
          out << Hap.new(ws, ps, h.value)
        end
      end
      out.sort_by { |h| [h.part.begin, h.whole ? h.whole.begin : 0r] }
    end
    # ⚠️ **把编排长度记上去** ✓ —— 心跳靠它取模循环 ✓（见 `pampa_loop_cycles` 的说明 ✓）。
    __arr.pampa_loop_cycles = total
    __arr
  end
end

# ---------------------------------------------------------------------------------------------
# PVal：**一个值，里面是一组数**（和弦 / vec3 那种）
#
# 为什么要一个**标记对象**：
#   裸数组 `[57, 60, 64]` 在 `ppattern` 里已经是"三个事件"（每个元素一个事件）。
#   要说"一个事件、值是三个数"，就得用标记包一下。
#   这样将来把"嵌套 = 细分"开放也不会冲突（嵌套管节奏，PVal 管值）。
class PVal
  attr_reader :list
  def initialize(list)
    @list = list.freeze
    freeze
  end
  def inspect = "pval(#{@list.inspect})"
  alias to_s inspect
  def ==(other) = other.is_a?(PVal) && other.list == @list
end

# ---------------------------------------------------------------------------------------------
# Combine：**每个事件多个参数** ✓（规格：docs/plan/pattern-combine-spec.md ✓）
#
# 一层 = 一个**单值** pattern ✓。请求某窗口时，各层分别查询 ✓，**起点集合必须完全相同** ✓
# —— 这既是"对齐"的定义 ✓，也是用户定的**硬失败**规则 ✓（不允许不同密度 ✗）。
#
# ⚠️ 为什么比的是 `whole.begin` ✓（而不是 `part` / `whole.end`）✗：
#   * `part` 会随**查询窗**被裁 ✓ —— 同一事件被不同窗裁出不同部分 ✓（这是对的 ✓），
#     拿它比会把"窗口边界"误当成"结构不同" ✗；
#   * `whole.end` 允许不同 ✓ —— `plinger` 之类会改长度 ✓（用户也可能对各层做了不同处理 ✓）；
#   * **起点是"这一拍有几个事件"的唯一稳定表达** ✓。
#
# ⚠️ 值 = `{层名 => 值}` ✓（`Hap#value` 是任意对象 ✓ —— 这一步没有新机制 ✓）。
module Combine
  module_function

  # `layers` = `{ Symbol => Pattern }` ✓（已在 `ppattern` 里把 String/Array/Pattern 归一 ✓）
  # `outer_cycle_beats` = 外层显式给的圈长 ✓（nil = 没给 ✓）
  def build(layers, outer_cycle_beats: nil)
    raise ArgumentError, 'ppattern({…}) 至少要有 2 个键（1 个键请用普通写法）' if layers.size < 2
    layers.each do |k, p|
      unless p.respond_to?(:query_arc)
        raise ArgumentError, "层 #{k.inspect} 不是 Pattern（收到 #{p.class}）"
      end
    end

    # ── 元数据：各层不一致就报错 ✓（用户决定 7 ✓）────────────────────────────
    marks = layers.values.map(&:pampa_cycle_beats).compact.uniq
    if marks.size > 1 && outer_cycle_beats.nil?
      raise ArgumentError,
            "各层的 cycle_beats 不一致：#{layers.map { |k, p| "#{k}=#{p.pampa_cycle_beats.inspect}" }.join(' ')}。" \
            '要么统一，要么在外层显式给 ppattern({…}, cycle_beats: N)'
    end
    cycles = layers.values.map(&:pampa_loop_cycles).compact.uniq
    if cycles.size > 1
      raise ArgumentError,
            "各层的编排总圈数不一致：#{layers.map { |k, p| "#{k}=#{p.pampa_loop_cycles.inspect}" }.join(' ')}"
    end

    names = layers.keys
    pats  = layers.values

    # ── 查询时：逐层查、比起点、不合就报错 ✓ ────────────────────────────────
    q = lambda do |b, e|
      per = pats.map { |p| p.query_arc(b, e).select(&:whole).sort_by { |h| [h.whole.begin, h.whole.end] } }
      starts = per.map { |list| list.map { |h| h.whole.begin } }
      unless starts.uniq.size == 1
        # 诊断必须能定位 ✓（规格 §6 ✓）
        counts = names.zip(starts.map(&:size)).map { |k, n| "#{k}=#{n}" }.join(' ')
        diff_at = nil
        base = starts[0]
        starts.each_with_index do |s, i|
          next if i.zero?
          diff_at = (base - s).first || (s - base).first
          break if diff_at
          # 数量相同但顺序不同 ✓
          if s != base
            s.each_index { |j| (diff_at = base[j]; break) if s[j] != base[j] }
            break if diff_at
          end
        end
        where = diff_at ? " 第一处不同在 #{diff_at}（第 #{b.floor} 圈 ✓）" : ''
        raise ArgumentError,
              "逐事件参数对齐失败：每层的事件数 #{counts}（查询窗 #{b}..#{e}）。#{where}\n" \
              '如何修：让各层的事件起点完全相同；密度不同时用 psegment(信号, n) 生成等密度层'
      end

      base_list = per.first
      base_list.each_with_index.map do |h, i|
        val = {}
        names.each_with_index { |k, li| val[k] = per[li][i].value }
        Hap.new(h.whole, h.part, val)
      end
    end

    pat = Pattern.new(&q)
    pat.pampa_cycle_beats = outer_cycle_beats.nil? ? marks.first : outer_cycle_beats.to_f
    pat.pampa_loop_cycles = cycles.first
    pat
  end
end

# ---------------------------------------------------------------------------------------------
# SignalPattern：**连续**的量 ✓ —— 查询任意区间时返回**一条**事件 ✓，
# `whole` = **nil** ✓（它不属于任何"事件区间" ✓）、`part` = **整个查询区间** ✓、
# 值 = **在 `part` 中点取样** ✓（上游 hap.mjs 的原话 ✓：
# "the given value will have been sampled from **the point halfway between the start and end
#  of the 'part' timespan**" ✓）。
#
# ⚠️ 这个 `whole` 为 nil 的形状**不是新发明** ✓ —— `Hap#to_s` 里的
# `"[continuous]"` 分支从第一阶段就写在那儿了 ✓，只是当时没有东西产生它 ✓。
#
# ⚠️ 定义位置必须在 `Pattern` **之后** ✗ —— 我第一版放在它前面 ✓，
# 于是 `class SignalPattern < Pattern` 在父类还不存在时求值 ✓ → `uninitialized constant Pattern` ✗。
class SignalPattern < Pattern
  attr_reader :fn

  def initialize(fn)
    @fn = fn
    super() do |b, e|
      # 取样点 = 中点 ✓（**不是**左端 ✗ —— 上游明确写的是 halfway ✓）
      t = (b + e) / 2
      [Hap.new(nil, b...e, fn.call(t))]
    end
  end

  # `psegment(n)`：把**每一圈**分成 n 份 ✓，每份产出一条**离散**事件 ✓（`whole` = 那一份 ✓）。
  #
  # 手法照上游 ✓：上游的 `segment` = `struct(pure(true)._fast(rate))` ✓，
  # 而 `struct` 内部走 `appRight` ✓ —— "以结构 hap 的 whole 为 span 去问信号" ✓，
  # 于是信号在**每个分段的中点**被取样 ✓。
  # 我们直接按"分段格"复现同一个结果 ✓，不引入 `struct` 那一整套 ✓。
  def segment(n)
    n = n.to_i
    raise ArgumentError, "psegment 的份数必须 ≥ 1（给了 #{n}）" if n < 1
    Pattern.new do |b, e|
      out = []
      last = e.ceil - 1
      (b.floor..last).each do |c|
        (0...n).each do |i|
          ws = c + Rational(i, n)
          we = c + Rational(i + 1, n)
          pb = [ws, b].max
          pe = [we, e].min
          next unless pb < pe
          # 取样点 = 这一份的中点 ✓（与"查询中点"**同一条规则** ✓ —— 分段就是一次查询 ✓）
          t = (ws + we) / 2
          out << Hap.new(ws..we, pb..pe, fn.call(t))
        end
      end
      out.sort_by { |h| [h.part.begin, h.whole.begin] }
    end
  end

  # 变换：返回的还是**信号** ✓（所以能继续变换 ✓）
  def map_signal(&blk)
    SignalPattern.new(->(t) { blk.call(fn.call(t)) })
  end
end

# ---------------------------------------------------------------------------------------------
# mini-notation 的**最小子集**：只够证明时间语义，**不是**完整 Strudel 语法。
# 支持：空格=序列、~=休止、[..]=子序列（**一个元素**）、*n=在其区间内细分。
#
# 第一版把它写成了"展开成扁平列表、每项等分" —— 于是 `bd [~ sd]` 变成三样东西各占 1/3，
# 而正确语义是：`[~ sd]` 是**一个**元素占 1/2，它再在自己的区间里细分。探针 2 第一次运行
# 就是靠"bd 占前半"这条判据把这个错误抓出来的。所以现在是**基于区间**的递归：
# 每个元素拿到的是一段区间，组在自己的区间里继续分。
# ---------------------------------------------------------------------------------------------
module Mini
  # ⚠️ **种子必须在 `module_function` 之前定义** ✗ ——
  # `module_function` 会把**它之后**定义的方法变成模块方法 ✓，
  # 而我第一版把种子写在它**之后** ✓ → `Mini.seed` 报
  # `undefined method 'seed' for module Mini` ✓（实测撞到 ✓）。
  # **顺序有语义** ✓ —— 这不是风格问题 ✓。
  class << self
    attr_accessor :seed
  end
  @seed = 0

  # 临时设种子跑一段（保证异常时也还原 ✓）
  def self.with_seed(v)
    old = @seed
    @seed = v.to_i
    yield
  ensure
    @seed = old
  end

  module_function

  # -> [[区间, 值], ...]，区间是 [0,1) 内的 Rational
  #
  # ⚠️ 顶层有三种"分层"符号 ✓，**它们是三种不同的东西** ✗：
  #   * `,` → **并行** ✓（每个子层各自占满整圈 ✓）；
  #   * `|` → **择一** ✓（每圈**只选一个** ✓ —— 第五阶段 ✓）；
  #   * `<...>` → **交替** ✓（按圈轮换 ✓ —— 第二阶段 ✓，它是**元素级**的 ✓ 不在这里 ✓）。
  #
  # ⚠️ **`|` 与 `,` 同时出现在顶层时报错** ✗（规格 §3.4 ✓）——
  # 我们**不猜**优先级 ✓：两个都是顶层分隔符 ✓，混用几乎一定是写错了 ✓，
  # 而**猜错不会报错** ✗（只是结构变了 ✓）→ 那正是最贵的那类静默失败 ✓。
  def spans(str)
    # ── ⚠️ **`{}` 多项式** ✓（第六阶段 ⑧ ✓）—— 要**在最前面**判 ✓，
    # 因为 `{}` 里可以有自己的顶层逗号（那是**分支**分隔 ✓，不是并行 ✓）。
    return polymeter(str) if str.strip.start_with?("{")
    has_par = split_top(str, ",").size > 1
    has_alt = split_top(str, "|").size > 1
    if has_par && has_alt
      raise ArgumentError,
            "顶层同时出现了 `,`（并行）与 `|`（择一）—— 我们不猜优先级。" \
            "请说清你要哪个，例如：a, (b | c)"
    end
    # ⚠️ `|` 在**选项层**展开 ✓：每个选项是**一个序列** ✓，各占整圈 ✓，
    # 然后按**圈号**选一个 ✓ → 用与交替同一套"按圈生成片段"的 Proc ✓（规格 §3.2 ✓）。
    return choice(str) if has_alt
    layers = split_top(str, ",")
    return seq(tokenize(layers.first), 0r, 1r) if layers.size <= 1
    layers.flat_map { |l| seq(tokenize(l), 0r, 1r) }
  end

  # `|` 择一 ✓：**选项在 token 层**（`spans_of` 会在片段层，那就切不开了 ✗）。
  #
  # 返回一个**按圈号选择**的片段生成器 ✓（与交替同一套机制 ✓）：
  # 每个选项各占**整圈** ✓，第 `c` 圈只输出被选中的那一个 ✓。
  def choice(str)
    alts = split_top(str, "|").map { |s| seq(tokenize(s), 0r, 1r) }
    seed = Mini.seed
    [->(cycle) { alts[PRandom.choice_index(cycle, alts.size, seed)] }]
  end

  # `{A, B}%n` **多项式序列** ✓（第六阶段 ⑧ ✓）—— 语义**由真引擎定的** ✓，不是推的 ✓。
  #
  # ── 模型（**v2 ✓，50 圈引擎数据全对** ✓）─────────────────────────────────────────────────
  #
  #   一圈分成 **`n` 个槽** ✓（间隔恒为 **`1/n`** ✓）；槽 `s` 的值取该分支的
  #   **`[(c · n + s) mod 步数]`** ✓，其中 `c` 是**圈号** ✓。
  #
  #   * `n` = `%n` ✓（显式 ✓）；
  #   * `n` **没给时 = 第一个分支的步数** ✓（⚠️ **不是 lcm** ✗ —— 见下 ✓）；
  #   * **步数** ✓：该分支**展开后的元素个数** ✓（`@` 权重按权重展开 ✓，如 `a@2 b c` → 4 ✓）。
  #
  # ⚠️ **我在这上面推了五次、错了五次** ✗（见 `docs/plan/pattern-polymeter-spec.md` ✓）。
  # **最后是靠"装起真引擎来问它"定下来的** ✓（`node` + `@strudel/mini` ✓，临时目录 15 秒 ✓），
  # 而不是靠读源码推 ✓ —— ⚠️ **而且我读的那份源码版本比引擎新** ✗（它的 AST 还不认 `{}` ✓），
  # 所以"对着源码推"从一开始就是错的 ✗。
  #
  # ⚠️ **`n` 默认取第一个分支的步数** ✗（不是 lcm ✓）—— 这一条**违反直觉** ✓，
  # 但它解释了 `{bd bd bd bd, cp cp hh}` 里 `cp` 支为何是**三圈一循环** ✓
  #（`n = 4` ✓ → `cp` 每圈推进 4 格 ✓ → `4 mod 3` ✓ → 三圈 ✓）**与引擎实测一致** ✓。
  #
  # ⚠️ **`%` 在 Tidal 里本来是个"数值比率"** ✓（`6%3` = 2 ✓）——
  # `{}%n` 是**多项式专用**的"细分步数" ✓（Tidal 文档的 *"Polymetric Sequences with Subdivision"* ✓）。
  def polymeter(str)
    m = str.strip.match(/\A\{(.*)\}(?:%(\d+))?\z/m)
    raise ArgumentError, "多项式写法要 `{A, B}` 或 `{A, B}%n`（收到 #{str.inspect}）" unless m
    inner = m[1]
    explicit = m[2]
    branch_specs = split_top(inner, ",")
    # ⚠️ **空分支要报 `ArgumentError`** ✗ —— 我第一版让它 `nil.size` 崩成 `NoMethodError` ✓：
    # `split_top` 对空串返回 `[]` ✓ → `branches.first` 是 `nil` ✓ → 报的是**内部实现细节** ✗，
    # 而不是"你写错了什么" ✓。**测试当场抓到** ✓（`{ }` 与 `{}` 两条 ✓）。
    raise ArgumentError, "多项式的分支不能为空（#{str.inspect}）" if branch_specs.empty?
    # 每条分支 → `[[值, 权重], …]` ✓（`@n` 给权重 ✓、默认 1 ✓）
    branches = branch_specs.map { |spec| parse_weighted(tokenize(spec)) }
    raise ArgumentError, "多项式的分支不能为空（#{str.inspect}）" if branches.any?(&:empty?)
    # **权重和** ✓ = 该分支一个周期占多少个"单位" ✓
    weight_sums = branches.map { |b| b.sum { |_v, w| w } }
    # ⚠️ **`n` 默认 = 第一个分支的权重和** ✓（**不是 lcm** ✗ —— 见上面的说明 ✓）——
    # 不带 `@` 时权重和 = 元素个数 ✓，所以这与已验通的那一支**一致** ✓。
    n = explicit ? explicit.to_i : weight_sums.first
    raise ArgumentError, "`%n` 的 n 必须是正整数（收到 #{explicit.inspect}）" if n < 1

    # ⚠️ **规律是从引擎固件里读出来的** ✓，不是推的 ✗（推过几次、都对不上 ✗）：
    #
    #   ① **每条事件的时长 = `权重 / n`** ✓
    #      （实测 `{a@2 b c}%8` → `a` 占 `2/8` ✓、`b` 与 `c` 各 `1/8` ✓；
    #       `%4` → `1/2, 1/4, 1/4` ✓；`%2` → `a` 占满整整一圈 ✓）；
    #   ② **起点 = 把这些时长累加** ✓（一个**滑动窗口** ✓，每圈推进 1 ✓）；
    #   ③ **不带 `@` 时权重全是 1** ✓ → 每条时长 `1/n` ✓ → **退化成"`n` 个均匀槽"** ✓
    #      —— 即我已经验通的那一支 ✓（**两支是同一套** ✓，不是两套 ✓）。
    #
    # 固件 ✓：`tools/pattern-probe/reference/weight-engine-expected.json` ✓（63 用例 × 4 圈 ✓）。
    [
      lambda do |cycle|
        out = []
        branches.each_with_index do |branch, bi|
          wsum = weight_sums[bi]
          # 该分支的**周期**（以输出圈为单位 ✓）= `wsum / n` ✓
          period = Rational(wsum, n)
          lo_c = Rational(cycle, 1)
          hi_c = lo_c + 1
          # ⚠️ **不要"每个周期分别铺一遍"** ✗ —— 我第一版就是那样 ✓，结果只有圈 0 对 ✓，
          # 因为周期起点与圈的边界一般不重合 ✓（圈 1 里该出现的音被切到了别的 k 上 ✓）。
          # **正确做法** ✓：按**全局**铺（第 `k` 遍的起点 = `k · period` ✓），
          # 再把与 `[lo_c, hi_c)` 相交的**裁出来** ✓ —— 与本项目别的算子同一套写法 ✓。
          first = (lo_c / period).floor - 1
          last = (hi_c / period).ceil
          (first..last).each do |k|
            base = k * period
            pos = 0r
            branch.each do |val, w|
              s = base + pos / n
              e = base + (pos + w) / n
              # ⚠️ **不要裁剪** ✗ —— 我删了两版裁剪 ✓，两版都是错的 ✓：
              #   * 第一版**完全不裁** ✓：区间越界 → 被消费端丢掉 → **整圈为空** ✗；
              #   * 第二版**把区间裁到本圈** ✓：**跨度被改短了** ✗ ——
              #     引擎保留**完整跨度** ✓（实测 `{a@2 b c}%1` 是 `a@0..2` ✓，不是 `a@0..1` ✓）。
              # **正确** ✓：**只按"与窗相交"取舍** ✓，**区间原样保留** ✓
              #（与本项目别的算子一致 ✓：`zoom` / `ply` / `arrange` 都是这个规则 ✓）。
              out << [(s - lo_c)...(e - lo_c), val] if s < hi_c && e > lo_c
              pos += w
            end
          end
        end
        out
      end
    ]
  end

  # 把一条分支的 token 解析成 `[值, 权重]` ✓：`a@2` → `["a", 2]` ✓、`b` → `["b", 1]` ✓。
  #
  # ⚠️ 只处理**原子 token** ✓ —— 分支里的嵌套组 / 算子会作为**单个元素**进来 ✓
  #（那一路**还没与引擎核对** ✗，见规格 §6.2 ✓）。
  def parse_weighted(tokens)
    tokens.map do |tok|
      if (mm = tok.match(/\A(.+?)@(\d+)\z/))
        w = mm[2].to_i
        raise ArgumentError, "`@` 的权重必须 ≥ 1（收到 #{tok.inspect}）" if w < 1
        [mm[1], w]
      else
        [tok, 1]
      end
    end
  end

  # 按顶层分隔符切分（**跳过所有成对符号内部** ✓）—— 逗号/空格的切分都要这层保护 ✓。
  #
  # ⚠️ **必须跟踪 `()`** ✗ —— 第一版只跟踪 `[]` 与 `<>` ✓，
  # 于是 `bd(3,8)` 里的**逗号**被当成"顶层并行" ✗ → 被切成 `bd(3` 与 `8)` 两层 ✓，
  # 欧几里得**完全失效** ✓（实测：`bd(3,8)` 给出的格号是 `0,0` 而不是 `0,3,6` ✗）。
  # **成对符号有一个算一个** ✓ —— 漏一个就是一个静默的解析错误 ✗。
  PAIRS = { "[" => "]", "<" => ">", "(" => ")", "{" => "}" }.freeze

  def split_top(str, sep)
    out = []
    buf = +""
    depth = 0
    str.each_char do |c|
      if PAIRS.key?(c)
        depth += 1
        buf << c
      elsif PAIRS.value?(c)
        depth -= 1
        buf << c
      elsif c == sep && depth.zero?
        out << buf.strip unless buf.strip.empty?
        buf = +""
      else
        buf << c
      end
    end
    out << buf.strip unless buf.strip.empty?
    out
  end

  # 序列里的 token（**空格在顶层才切** ✓）—— 与 split_top 同一套保护 ✓。
  def tokenize(str)
    split_top(str, " ")
  end

  # 一个**序列**：按**权重**把区间分给各元素 ✓。
  #
  # ⚠️ 权重模型（规格 §3.4/§3.5）✓：
  #   * 默认权重 1 ✓；
  #   * `@n` 把权重设为 n ✓；
  #   * `!n` 让这个元素**变成 n 个元素** ✓（不是权重乘 n ✗ —— 见规格 §3.5.1 ✓，
  #     `bd!3 sd` ≡ `bd bd bd sd` ✓，即 4 个等权元素 ✓）；
  #   * `~` 权重 1 但**不产生事件** ✓（占位 ✓）。
  def seq(tokens, lo, hi)
    return [] if tokens.empty?
    items = tokens.flat_map { |t| unroll_bang(t) }
    total = items.sum { |t| weight_of(t) }.to_r
    return [] if total.zero?
    acc = lo
    items.flat_map do |tok|
      w = weight_of(tok).to_r
      s = acc
      e = acc + (hi - lo) * w / total
      acc = e
      element(tok, s, e)
    end
  end

  # `!n` 把元素**展开成 n 个** ✓（官方表格：`bd!3 sd` ≡ `bd bd bd sd` ✓）。
  # `!` 可以叠在别的修饰符上 ✓，所以这里返回**去掉 `!n` 之后**的 token 的 n 份副本 ✓。
  def unroll_bang(tok)
    if (m = tok.match(/\A(.+)!(\d+)\z/))
      inner = m[1]
      n = m[2].to_i
      return Array.new(n) { inner }
    end
    [tok]
  end

  # 一个 token 的**权重**（占几个"份额" ✓）。`@n` 设权重 ✓，`!n` 已在 unroll_bang 处理 ✓。
  def weight_of(tok)
    if (m = tok.match(/\A(.*?)@(\d+)\z/))
      n = m[2].to_i
      # ⚠️ `@0` **报错** ✓ —— 不静默 ✓（规格 §3.4 ✓）：用户写了就该被告知 ✓，
      # 静默丢弃会让他以为写对了 ✗。
      raise ArgumentError, "`@0` 无意义（权重必须 ≥ 1）：#{tok.inspect}" if n.zero?
      return n
    end
    1
  end

  # 一个**元素**：按修饰符**从外到内**剥 ✓。
  #
  # 顺序（规格 §4 ✓）：`@` 权重（已在 seq 处理 ✓）→ `*n` 细分 → `!n`（已展开 ✓）
  #                    → `(k,n[,o])` 欧几里得 → `[组]` → `~` → 原子 ✓
  def element(tok, lo, hi)
    # `*n`：把这个元素的**份额**再分 n 份 ✓（份额不变 ✓ —— 与 `!` 的区别见 §3.5.1 ✓）
    if (m = tok.match(/\A(.+)\*(\d+)\z/))
      inner = m[1]
      n = m[2].to_i
      return (0...n).flat_map do |i|
        s = lo + (hi - lo) * i / n
        e = lo + (hi - lo) * (i + 1) / n
        element(inner, s, e)
      end
    end

    # `(k,n)` / `(k,n,o)`：欧几里得 ✓ —— **Bjorklund 递推 + 右旋 offset** ✓（见规格 §3.3 ✓）
    if (m = tok.match(/\A(.+)\((\d+),(\d+)(?:,(\d+))?\)\z/))
      inner = m[1]
      k = m[2].to_i
      n = m[3].to_i
      off = (m[4] || "0").to_i
      raise ArgumentError, "欧几里得的分母必须 > 0：#{tok.inspect}" if n.zero?
      pattern = euc_pattern(k, n, off)
      # ⚠️ 必须是 `map` + `compact`，**不能是 `filter_map`** ✗ ——
      # `filter_map` 会把每个 (区间, 值) **对**当成块的值返回 ✓，
      # 于是返回的是"片段列表"本身而不是"片段列表的列表" ✗ →
      # `Mini.pattern` 拿到一个裸数组、当成 Proc/片段用 ✓ → 报 `span` 是 nil ✗。
      # 实测撞到过 ✓。**这一处的形状错，症状出现在很远的地方** ✓。
      return pattern.each_index.map do |slot|
        next nil unless pattern[slot] == 1
        s = lo + (hi - lo) * slot / n
        e = lo + (hi - lo) * (slot + 1) / n
        element(inner, s, e)
      end.compact.flatten(1)
    end

    # `@n`（若还留着 ✓）—— 单独出现时只是"权重"，在元素级无额外动作 ✓
    if (m = tok.match(/\A(.+)@(\d+)\z/))
      return element(m[1], lo, hi)
    end

    # `?p` 随机丢弃 ✓（第五阶段 ✓）—— `p` 可省 ✓，默认 0.5 ✓（照上游 `degradeBy` ✓）。
    #
    # ⚠️ 正则**必须匹配任意数字** ✗，然后在代码里校验 ✓ ——
    # 我第一版把数字写进了正则（只认 `0`/`1` 开头 ✓）✗ →
    # `bd?2` 与 `bd?-0.1` 就**落到了"省略概率"那个分支** ✓ → **静默按 0.5 处理** ✗
    #（实测：`bd?2` 没报错 ✓）。**该报的错没报** ✓ 正是本项目最贵的那类问题 ✓。
    #
    # ⚠️ 哈希的输入必须是 `(圈号, 圈内位置)` ✗ —— 第一版只传了 `lo` ✓（**圈内**位置 ✓），
    # 于是**每一圈**在同一位置的判定**完全相同** ✓ → `bd?0.5` 在 8 圈里**全留或全丢** ✗
    #（实测：8 条保留 ✓，而不是约 4 条 ✗）。
    # **只传圈内位置 = 丢掉了圈号** ✓ —— 那是"随机看起来有周期性"的根源 ✓。
    #
    # ⚠️ 判定必须**延后到按圈求值** ✓（返回 `Proc` ✓）—— 因为在 `element` 这一层
    # **还不知道圈号** ✗（圈号只在 `Mini.pattern` 的按圈循环里才有 ✓）。
    if (m = tok.match(/\A(.*?)\?(\S+)\z/))
      inner = m[1]
      raw = m[2]
      raise ArgumentError, "`?` 的概率必须是数字（给了 #{raw.inspect}）" unless raw =~ /\A-?\d*\.?\d+\z/
      p = raw.to_f
      raise ArgumentError, "`?` 的概率必须落在 [0,1]（给了 #{raw}）" unless p >= 0.0 && p <= 1.0
      return [->(cycle) { PRandom.dropped?(cycle + lo, p, Mini.seed) ? [] : element(inner, lo, hi) }]
    end
    if (m = tok.match(/\A(.*)\?\z/))
      return [->(cycle) { PRandom.dropped?(cycle + lo, 0.5, Mini.seed) ? [] : element(m[1], lo, hi) }]
    end

    # `/n` 减速 ✓（第五阶段 ✓）—— 这个元素**每 n 圈才出现一次** ✓（规格 §3.3 ✓）。
    # ⚠️ 与 `slow` 不同 ✗：`slow` 拉长**整个 pattern** ✓，`/n` 只影响**这一个元素** ✓。
    if (m = tok.match(/\A(.+)\/(\d+)\z/))
      inner = m[1]
      n = m[2].to_i
      raise ArgumentError, "`/n` 的 n 必须是正整数（给了 #{m[2]}）" if n < 1
      # 周期性 → 用**按圈生成片段**的 Proc ✓（与交替/择一同一套机制 ✓）
      return [->(cycle) { PRandom.appears?(cycle, n) ? element(inner, lo, hi) : [] }]
    end

    # `[组]`：在**自身区间**里再分 ✓
    if tok.start_with?("[") && tok.end_with?("]")
      return seq(tokenize(tok[1..-2]), lo, hi)
    end

    # `~` 休止：**位置在** ✓（combine 里要用来对齐 ✓）；单用时不出事件 ✓
    if tok == "~"
      return [] unless keep_rests?
      return [[lo...hi, REST]]
    end

    # `<...>` 交替 ✓ —— **值依赖圈号** ✓（规格 §3.1 ✓）。
    #
    # 关键形状问题 ✓（我第一版在这里绕了远路 ✗）：交替的**区间**也依赖圈号吗？
    # 不 ✗ —— 交替元素**占满它那一圈** ✓，而 `element` 拿到的区间正好就是那一圈 ✓。
    # 所以**区间不必依赖圈号** ✓，只有**值**依赖 ✓ → 用 `Proc` 足够了 ✓。
    #
    # 但"组"会推翻这条 ✗：`<a [b c]>` 的第 1 圈里，`[b c]` 要**再细分** ✓ →
    # 那会产生**多个** (区间, 值) ✓ —— 只靠"一个值 Proc"表达不了 ✗。
    # 所以：**交替的"元素"用 `element` 在当前区间上求值** ✓，
    # 而"第几圈"通过一个**按圈号生成片段列表的 Proc** 传下去 ✓（见 `spans` 的产物形状 ✓）。
    if tok.start_with?("<") && tok.end_with?(">")
      alts = split_top(tok[1..-2], " ")
      return [] if alts.empty?
      # 产物形状 ✓：**一项 = 一个 Proc** → `Mini.pattern` 按圈 call 它 ✓ 得到那一圈的片段 ✓。
      return [->(cycle) { element(alts[cycle % alts.size], lo, hi) }]
    end

    # 原子 ✓
    [[lo...hi, Mini.value_of(tok)]]
  end

  # 一个 token 的**值**：数字要还原成数字 ✓，其余当符号 ✓。
  #
  # ⚠️ 第一版一律 `to_sym` ✗ → `ppattern("60 62 64 66")` 给出 `:"60"` ✗，
  # 而 Sonic Pi 的 `play` 要的是**音高**（数字或 :c4 这类音名 ✓）。
  # 单测当场抓到（`play {note: :"60"}` ✗）。**"用起来能响"和"结构对"是两件事** ✓。
  def value_of(tok)
    return tok.to_i if tok =~ /\A-?\d+\z/
    return tok.to_f if tok =~ /\A-?\d+\.\d+\z/
    tok.to_sym
  end

  # ⚠️⚠️ **休止是一个位置** ✓（2026-10-21 用户纠正 ✗）——
  #
  #   我原来的处理是 `return [] if tok == "~"` ✗：休止**被丢掉** ✗ →
  #   `{ note: "57 ~ 60", amp: "0.5 0.8 0.3" }` 变成 **2 vs 3** ✗ → 报"密度不同" ✗
  #   → **休止符根本写不进 combine** ✗（用户："休止符怎么能不算事件" ✓）。
  #
  #   现在 ✓：**只在 combine 的层里**保留休止 ✓（值 = `REST` ✓）——
  #   位置在 ✓（对齐要用 ✓）、声音没有 ✓（投递时跳过 ✓）。
  #   `ppattern("57 ~ 60")` **单独用时**照旧 ✗ 不出休止事件 ✓（不然计数全变 ✗）。
  REST = Object.new
  def REST.inspect = '~'
  def REST.to_s = '~'
  REST.freeze

  def keep_rests? = Thread.current[:pampa_mini_keep_rests] ? true : false

  # 把解析结果包成 Pattern：片段在**每一圈**里重复
  #
  # ⚠️ 产物形状有两种 ✓：
  #   * `[区间, 值]` → 每一圈都用 ✓；
  #   * **`Proc`** → 它吃**圈号**、吐"那一圈的片段列表" ✓ —— 交替算子用它 ✓。
  # 两者都**不引入状态** ✓：圈号来自时间本身 ✓（规格 §2.2 ✓），
  # 所以"重放同一区间得到同样结果"仍然成立 ✓（有判据 ✓）。
  def pattern(str, keep_rests: false)
    # ⚠️ 开关只在**解析期**需要 ✓（`spans` 是急切求值的 ✓）
    prev = Thread.current[:pampa_mini_keep_rests]
    Thread.current[:pampa_mini_keep_rests] = keep_rests ? true : nil
    frags = begin
      spans(str)
    ensure
      Thread.current[:pampa_mini_keep_rests] = prev
    end
    Pattern.new do |b, e|
      out = []
      last = e.ceil - 1
      (b.floor..last).each do |c|
        frags.each do |frag|
          items = frag.is_a?(Proc) ? frag.call(c) : [frag]
          items.each do |span, val|
            ws = c + span.begin
            we = c + span.end
            pb = [ws, b].max
            pe = [we, e].min
            next unless pb < pe
            v = val.is_a?(Proc) ? val.call(c) : val
            out << Hap.new(ws..we, pb..pe, v)
          end
        end
      end
      out.sort_by { |h| [h.part.begin, h.whole.begin] }
    end
  end

  # ── 欧几里得：**Bjorklund 递推** ✓ + **右旋 offset** ✓ ──────────────────────────────────
  #
  # ⚠️ 这**不是** `floor(i·n/k)` 公式 ✗ —— 两者结果不同 ✓（规格 §3.3 ✓）：
  #   * `floor(i·n/k)` → `(3,8)` 得格号 `0,2,5` ✗
  #   * **Bjorklund** → `10010010` → 格号 `0,3,6` ✓ ← **那才是 tresillo** ✓
  #
  # 实现照 Strudel 的 `packages/core/euclid.mjs` 转写 ✓
  # （它注明 ported from Rohan Drape 的 Haskell Music Theory ✓）；
  # 独立参照在 `tools/pattern-probe/reference/euclid-bjorklund.rb` ✓
  # —— **两份实现独立存在** ✓，所以"一起错"的概率低 ✓（这是刻意的 ✓）。
  #
  # offset 是**左旋 offset 步** ✓（不是逐格加 ✗，也不是右旋 ✗）：
  # 上游 `_euclidRot` = `rotate(b, -rotation)` ✓，而 `rotate` 的注释写明 **"(to the left)"** ✓
  # → 负号与左旋抵消 ✓ = **左旋 rotation 步** ✓。
  #
  # 锚点 ✓：Tidal 文档把 `(3,8,1)` 画成 `~ ~ x ~ ~ x ~ x` → 格号 `2,5,7` ✓
  # → 左旋 1 步给出 `[2,5,7]` ✓（右旋会给 `[1,4,7]` ✗）。
  def euc_pattern(k, n, offset = 0)
    raise ArgumentError, "欧几里得的音数必须 ≥ 0：#{k}" if k.negative?
    return Array.new(n, 0) if k.zero?
    return Array.new(n, 1) if k >= n
    b = bjorklund(k, n)
    offset.zero? ? b : b.rotate(offset % n)   # Ruby 的 rotate(k) = 左旋 k 步 ✓
  end

  # 左旋 r 步 ✓（保留这个名字以便与规格对照 ✓；就是 Ruby 的 rotate ✓）
  def left_rotate(arr, r)
    r.zero? ? arr : arr.rotate(r)
  end

  # Bjorklund 递推 ✓（逐行转写上游 ✓）
  def bjorklund(ons, steps)
    offs = steps - ons
    ones = Array.new(ons) { [1] }
    zeros = Array.new(offs) { [0] }
    _n, x = _bjorklund([ons, offs], [ones, zeros])
    x[0].flatten + x[1].flatten
  end

  def _bjorklund(n, x)
    ons, offs = n
    return [n, x] if [ons, offs].min <= 1
    _bjorklund(*(ons > offs ? bj_left(n, x) : bj_right(n, x)))
  end

  def bj_left(n, x)
    ons, offs = n
    xs, ys = x
    a, b = xs[0...offs], xs[offs..] || []
    [[offs, ons - offs], [zip_concat(a, ys), b]]
  end

  def bj_right(n, x)
    ons, offs = n
    xs, ys = x
    a, b = ys[0...ons], ys[ons..] || []
    [[ons, offs - ons], [zip_concat(xs, a), b]]
  end

  def zip_concat(a, b)
    [a, b].transpose.map { |x, y| x + y }
  end
end

# ---------------------------------------------------------------------------------------------
# 判据
# ---------------------------------------------------------------------------------------------