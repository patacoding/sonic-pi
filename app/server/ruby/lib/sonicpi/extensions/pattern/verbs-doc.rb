# ⚠️ **生成物，不要手改** —— 由 `tools/pattern-probe/gen-verbs-doc.rb` 从
#   **教程索引**（`gen-verb-index.rb` 的输出）生成。
#
# **为什么要有这个文件**：编辑器自动补齐的候选来自 `ruby_help.h`，而它是
#   `qt-doc.rb` **构建期**从 `SonicPi::Lang::Core.docs` 生成的。`doc` 写进的是
#   DocSystem 的**类变量** `@@docs`（所有 includer 共用），所以这里注册一下，
#   `qt-doc.rb` 就会**自动**把我们的动词收进补全。
#
# ⚠️ 没有 `frozen_string_literal`：上游 `docs_html_map` 会**原地改**这些字符串，
#   冻结了就抛 `FrozenError`（实测）。
# ⚠️ `args:` 必须有：上游没有它会抛 `no args defined`；类型统一 `:anything`
#   （上游存在这个类型），**不编造**。
# ⚠️ 只有 `qt-doc.rb` 重跑 + GUI 重编之后，编辑器里才看得到（构建期生效）。
module PampaPattern
  # 用户动词 → 条目（纯数据）
  VERB_DOCS = [
      { name: "pplay", usage: "pplay pattern", summary: "起一个播放器 （自己循环 ，下一个网格点加入 ）", args: [[:pattern, :anything]], opts: {name: "player name, used by pstop and pstats", cycle_beats: "how many beats one cycle spans (defaults to the loop length)", seed: "random seed, so a pattern with ? or | always picks the same things", use: "the Sonic Pi verb each event is delivered to", map: "how an event value becomes the verb argument"}, source: "extensions/pattern/async.rb" },
      { name: "pstop", usage: "pstop", summary: "按名字停 ，或不带名字停\"此刻已存在的全部\"", args: [], opts: nil, source: "extensions/pattern/async.rb" },
      { name: "pquery", usage: "pquery pattern", summary: "把某个时间区间的事件拿出来 （不发声 ）", args: [[:pattern, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pbar", usage: "pbar", summary: "当前进度 （读 Sonic Pi 的全局拍 ）", args: [], opts: nil, source: "extensions/pattern/async.rb" },
      { name: "pstats", usage: "pstats name", summary: "某个播放器发过几条事件 （判\"有没有出声\"用这个 ，不用\"注册了\" ）", args: [[:name, :anything]], opts: nil, source: "extensions/pattern/async.rb" },
      { name: "pstats_clear", usage: "pstats_clear —", summary: "清空所有播放器的计数 （测试收尾用 ）", args: [[:—, :anything]], opts: nil, source: "extensions/pattern/async.rb" },
      { name: "ppattern", usage: "ppattern spec", summary: "从 mini 语法造一个模式 —— 唯一入口 （可带 cycle_beats: ）", args: [[:spec, :anything]], opts: {cycle_beats: "how many beats one cycle spans (defaults to the loop length)"}, source: "extensions/pattern/runtime.rb" },
      { name: "prun", usage: "prun n", summary: "prun(n) —— 一圈里离散地走 0..n-1 （第六阶段 ⑥ ）。", args: [[:n, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "parrange", usage: "parrange", summary: "parrange([4, 模式], [2, 模式], …) —— 曲式 （第六阶段 ）。", args: [], opts: {cycle_beats: "how many beats one cycle spans (defaults to the loop length)"}, source: "extensions/pattern/runtime.rb" },
      { name: "pscale_to", usage: "pscale_to pattern root name", summary: "pscale_to(模式, 根音, 音阶名) —— 把音阶级数映射到音高 （第六阶段 ⑨ ）。", args: [[:pattern, :anything], [:root, :anything], [:name, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pscale_ring", usage: "pscale_ring root name", summary: "pscale_ring(根音, 音阶名[, 八度数]) —— 音阶本身的音高表 （不发声 ）。", args: [[:root, :anything], [:name, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pscale_names", usage: "pscale_names —", summary: "pscale_names —— 我们支持哪些音阶名", args: [[:—, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pchord", usage: "pchord pattern root", summary: "pchord(模式, 根音) —— 把和弦名变成音高 （第六阶段 ⑩ ）。", args: [[:pattern, :anything], [:root, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pchord_names", usage: "pchord_names —", summary: "pchord_names —— 我们支持哪些和弦名", args: [[:—, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "piter", usage: "piter pattern n", summary: "piter(模式, n) / piter_back(模式, n) —— 变奏 （第六阶段 ② ）。", args: [[:pattern, :anything], [:n, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "piter_back", usage: "piter_back pattern n", summary: "≡ piter 的倒序版本 （从最后一个变体开始 ）", args: [[:pattern, :anything], [:n, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pply", usage: "pply pattern n", summary: "pply(模式, n) —— 加花 （普查里的 ③ ）。", args: [[:pattern, :anything], [:n, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pearly", usage: "pearly pattern x", summary: "pearly(模式, x) / plate(模式, x) —— 对齐与摇摆 （第六阶段 ④ ）。", args: [[:pattern, :anything], [:x, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "plate", usage: "plate pattern x", summary: "把整段内容推后 x 圈 （pearly 是提前 ；", args: [[:pattern, :anything], [:x, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pswing", usage: "pswing pattern n", summary: "pswing(模式, n) / pswing_by(模式, amount, n) —— 摇摆 （普查 ④ ）。", args: [[:pattern, :anything], [:n, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pswing_by", usage: "pswing_by pattern amount n", summary: "≡ .swing_by(amount, n) （按份推后 ）", args: [[:pattern, :anything], [:amount, :anything], [:n, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pzoom", usage: "pzoom pattern s e", summary: "pzoom(模式, s, e) / pcompress(模式, b, e) / pfast_gap(模式, k) / plinger(模式, t)", args: [[:pattern, :anything], [:s, :anything], [:e, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pcompress", usage: "pcompress pattern b e", summary: "≡ .compress(b, e) （把整圈压进 [b, e) ）", args: [[:pattern, :anything], [:b, :anything], [:e, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pfast_gap", usage: "pfast_gap pattern k", summary: "≡ .fast_gap(k) （加速但保留间隔 ）", args: [[:pattern, :anything], [:k, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "plinger", usage: "plinger pattern t", summary: "≡ .linger(t) （每个事件拖着尾巴 ）", args: [[:pattern, :anything], [:t, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "plast_of", usage: "plast_of pattern n", summary: "plast_of(模式, n) { |p| … } —— 每 n 圈里最后一圈做变换 （普查 ⑤ ）。", args: [[:pattern, :anything], [:n, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "ppalindrome", usage: "ppalindrome pattern", summary: "ppalindrome(模式) —— 每隔一圈 rev （上游 = lastOf(2, rev) ，普查 ⑤ ）。", args: [[:pattern, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "peuclid_legato", usage: "peuclid_legato pattern k n", summary: "peuclid_legato(模式, k, n[, rotation]) —— 欧几里得的\"连奏\"版 （普查 ⑤ ）。", args: [[:pattern, :anything], [:k, :anything], [:n, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "ptranspose", usage: "ptranspose pattern n", summary: "ptranspose(模式, n) —— 按半音移调 （第六阶段 ⑥ ）。", args: [[:pattern, :anything], [:n, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "ppitch_range", usage: "ppitch_range n lo hi", summary: "ppitch_range(n, lo, hi) —— 在 [lo, hi] 上取 n 个等分点 （prun 的搭档 ）。", args: [[:n, :anything], [:lo, :anything], [:hi, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "psine", usage: "psine —", summary: "── 连续信号（第三阶段 ）──────────────────────────────────────────────────────────────", args: [[:—, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "psaw", usage: "psaw —", summary: "锯齿信号 （一圈内 0→1 线性上升 ）", args: [[:—, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "psquare", usage: "psquare —", summary: "方波信号 （一圈内前一半 0、后一半 1 ）", args: [[:—, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "ptriangle", usage: "ptriangle —", summary: "三角波信号 （0→1→0 ）", args: [[:—, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "prand", usage: "prand —", summary: "prand：每圈一个随机数 （圈内恒定 ）—— 与 pnoise 的区别要写清", args: [[:—, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pnoise", usage: "pnoise —", summary: "pnoise：连续随机 （任意时刻不同 ）", args: [[:—, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "psegment", usage: "psegment sig n", summary: "psegment(信号, n)：离散化 —— 每圈分成 n 份 ，每份一条事件 ，", args: [[:sig, :anything], [:n, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "prange", usage: "prange sig lo hi", summary: "prange(信号, lo, hi)：把 [0,1] 映到 [lo, hi] —— 最常用的一个", args: [[:sig, :anything], [:lo, :anything], [:hi, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pscale", usage: "pscale sig k", summary: "≡ 信号缩放 k 倍 （map_signal ）", args: [[:sig, :anything], [:k, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "padd", usage: "padd a b", summary: "padd(a, b)：信号 + 信号 / 常量 （本阶段只做加法 ，够用且好验 ）", args: [[:a, :anything], [:b, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "poffset", usage: "poffset sig d", summary: "≡ 信号在时间上提前 d （结果(t) = sig(t + d) ，实测方向 ）", args: [[:sig, :anything], [:d, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pfast_sig", usage: "pfast_sig sig k", summary: "≡ 信号时间压缩 k 倍", args: [[:sig, :anything], [:k, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
      { name: "pslow_sig", usage: "pslow_sig sig k", summary: "pslow_sig(sig, k) / pfast_sig(sig, k)：在时间上拉伸/压缩", args: [[:sig, :anything], [:k, :anything]], opts: nil, source: "extensions/pattern/runtime.rb" },
  ].freeze

  # 注册进 Sonic Pi 的 docs 注册表（`@@docs` 共享）。
  # 上游不在时（离线测试）**静默跳过**，不报错。
  def self.register_verb_docs!
    return 0 unless defined?(SonicPi::Lang::Core) && SonicPi::Lang::Core.respond_to?(:docs)
    n = 0
    VERB_DOCS.each do |d|
      SonicPi::Lang::Core.doc(
        name: d[:name],
        summary: d[:summary].dup,
        usage_example: d[:usage].dup,
        args: d[:args].map { |a| [a[0], a[1]] },
        opts: (d[:opts] && !d[:opts].empty? ? d[:opts] : nil),
        doc: "pampa pattern: #{d[:summary]}",
        introduced: (defined?(SonicPi::Version) ? SonicPi::Version.new(5, 0, 0) : nil)
      )
      n += 1
    end
    n
  rescue StandardError
    0
  end
end
