# **播放位置**的纯计算 ✓ —— 与 Sonic Pi 运行时**完全解耦** ✓。
#
# ⚠️⚠️ **为什么位置必须这么算** ✗ —— 2026-10-16 用户把模型讲清了 ✓（原话 ✓）：
#
#   > *"我们的时序语义就相当于 daw 里的一个 track，在给定的 loop 小节数的前提下，
#   >   生产者写 pattern…… 节拍的播放进度是 sonic pi 原来的 bpm 设定，并且在单位节拍内对齐，
#   >   这样的话，无论时序的生产者还是消费者的代码更新，并且 reload 之后，
#   >   **会自动进行到当前的小节**，这个就是 live coding"*
#
#   ⚠️ **我之前错在哪** ✗：每个播放器维护**自己的游标** ✓（"我从启动那刻起走了多少拍" ✓）。
#   **那 reload 只能从第 0 小节重来** ✗ —— **与 live coding 正好相反** ✓。
#
#   **正确模型** ✓：**位置是全局时间轴上的绝对位置** ✓，**不是"这个播放器走了多远"** ✗：
#
#       位置（拍） = 锚点拍 + (现在墙钟 − 锚点墙钟) × 每秒拍数
#       圈号       = 位置（拍） / cycle_beats
#
#   → **与"谁在什么时候启动"无关** ✓ → reload 换的是**内容** ✓，**位置不变** ✓ → 接着当前小节 ✓。
#   → **多个 track 自动对齐** ✓（同一个 `f` ✓）—— 所以**不需要按 name 同步** ✓。
#
# ⚠️ **锚点必须全局共享一份** ✗（存 Time State ✓）：
#   若每个播放器各自 `link()` ✓，它们会在**不同的**小节线上锚 ✓ → 相位不同 ✗ → reload 后退回第 0 小节 ✗。
#   共享锚点之后 ✓：第一个播放器建立它 ✓，后续播放器与**reload 之后**的播放器都复用它 ✓。
module PampaPattern
  module Position
    module_function

    # 一个锚点 ✓：**网格上某一条线**的时刻（墙钟 ✓）与它对应的拍号 ✓。
    #
    # ⚠️ 两个量必须**一起**记 ✓ —— 只有墙钟没有拍号 ✓ 就不知道"那一刻是第几拍" ✗。
    def anchor(beat:, wall:)
      { beat: beat.to_f, wall: wall.to_f }
    end

    # 现在是第几拍 ✓（浮点 ✓，可以与拍号不同步 ✓ —— 那正是我们要的精度 ✓）。
    def beat_now(anchor, now_wall, bpm)
      seconds_per_beat = 60.0 / bpm.to_f
      anchor[:beat] + ((now_wall.to_f - anchor[:wall]) / seconds_per_beat)
    end

    # 现在是第几圈 ✓（可以是非整数 ✓）。
    def cycle_now(anchor, now_wall, bpm, cycle_beats)
      beat_now(anchor, now_wall, bpm) / cycle_beats.to_f
    end

    # 一个事件在**绝对拍**上的位置 ✓。
    #
    # ⚠️ **起点必须是锚点拍，不能是 0** ✗ —— 这正是我最早怀疑、后来又放弃的那个"基准不一致" ✓：
    #   旧代码 `abs_beat = onset_cycle * cycle_beats` ✓（从 **0** 起 ✓），
    #   而 `__pcurrent_beat` 是引擎拍（形如 `16.0` ✓）→ 两者差一大截 ✗ → `delta` 变负 ✓ → 一条都不发 ✗。
    def event_beat(anchor, onset_cycle, cycle_beats)
      anchor[:beat] + (onset_cycle.to_f * cycle_beats.to_f)
    end

    # 一条事件**还要等多少拍**才该被提交（`time_warp` 的提前量 ✓）。
    #
    # ⚠️ 上游 `play` 的 timetag 永远是 `虚拟时间 + sched_ahead` ✓
    #（`__get_spider_schedule_time` ✓），所以"在 T 拍发声"必须在 `T − sched_ahead` 提交 ✓。
    # 本函数给的就是"从**现在**到该提交那一刻"的拍数 ✓ —— 负值表示**已经过了** ✓（跳过 ✓）。
    def wait_beats(anchor, onset_cycle, cycle_beats, now_wall, bpm, sched_ahead_beats)
      submit_at = event_beat(anchor, onset_cycle, cycle_beats) - sched_ahead_beats
      submit_at - beat_now(anchor, now_wall, bpm)
    end

    # 这一轮该排哪些圈 ✓ —— 纯函数，返回 `[first_cycle, last_cycle]`（含 ✓）。
    #
    #   horizon_beats ✓ 一次往前排多少拍 ✓（**必须 ≤ sched_ahead** ✗）
    def cycle_range(anchor, now_wall, bpm, cycle_beats, horizon_beats, sched_ahead_beats)
      from_beat = beat_now(anchor, now_wall, bpm) + sched_ahead_beats
      to_beat   = from_beat + horizon_beats
      [(from_beat / cycle_beats.to_f), (to_beat / cycle_beats.to_f)]
    end

    # loop 长度（拍）✓ = 小节数 × 每小节拍数 ✓ —— **4/4 与 3/4 都靠这里** ✓。
    def loop_beats(loop_bars, beats_per_bar)
      loop_bars.to_f * beats_per_bar.to_f
    end

    # ── **进度：第几小节** ✓（Sonic Pi 里没有这个概念 ✓，**必须由我们算/记** ✗）──────────
    #
    # ⚠️ 用户原话 ✓：*"sonic pi 应该是不记录 loop 的全小节数和当前的进度小节数，
    # **可能需要我们增加变量来记录**"* ✓ —— 对 ✓。
    # 下面这几个是"把进度算出来"的**纯函数** ✓；**记录**那部分（锚点、loop 长度）在运行时 ✓。

    # 从锚点起过了几小节 ✓（**可负** ✓ —— 负表示"锚点在未来" ✓，调用方要能看见 ✓）。
    def bar_index(progress_beats, beats_per_bar)
      (progress_beats.to_f / beats_per_bar.to_f).floor
    end

    # 在 loop 里的第几小节 ✓（0 起 ✓）。**负数也落回 `[0, loop_bars)`** ✓。
    def bar_in_loop(progress_beats, beats_per_bar, loop_bars)
      n = loop_bars.to_i
      return 0 if n <= 0
      bar_index(progress_beats, beats_per_bar) % n
    end

    # 在这一小节里的第几拍 ✓（0 起 ✓，浮点 ✓）。
    def beat_in_bar(progress_beats, beats_per_bar)
      progress_beats.to_f % beats_per_bar.to_f
    end

    # ── **有限模式按自身长度循环** ✓（编排裹回 ✓ 2026-10-16 抽出来的 ✓）────────────────
    #
    # ⚠️⚠️ **为什么抽成纯函数** ✗：这段逻辑原来**写死在心跳里** ✓（`async.rb#__ptick_one` ✓）——
    # 于是它**只能靠真机观察** ✓，而"编排按自身长度循环"当时**只有一次真机观察** ✗、**没有离线判据** ✗。
    # 抽出来之后 ✓，它就能被纯算术钉死 ✓（判据见 `test-position.rb` ✓）。
    #
    # 语义 ✓：
    #   * `span` = 这个模式有几圈 ✓（编排有 ✓；**无限模式给 nil** ✗）
    #   * 全局圈号 `from_cycle` ✓ → 落回 `[0, span)` 的 `:from` ✓
    #   * `:base` = 这一轮编排从**全局**第几圈开始 ✓ ——
    #     事件的绝对位置 = `(onset + base) * cycle_beats` ✓
    def span_window(from_cycle, to_cycle, span)
      if span && span.to_f.positive?
        base = (from_cycle.to_f / span.to_f).floor * span.to_f
        { base: base, from: from_cycle.to_f - base, to: to_cycle.to_f - base }
      else
        # ⚠️ **无限模式不取模** ✗ —— 取模会把它截断 ✓（判据里有一条守着 ✓）
        { base: 0.0, from: from_cycle.to_f, to: to_cycle.to_f }
      end
    end

    # ── ⭐ **严格按 loop 对齐：截断 / 静音 / 每轮从 0 拍起** ✓（2026-10-16 语义变更 ✓）──────
    #
    # ⚠️⚠️ **loop 仍然循环** ✓ —— 改的只是"**一个 loop 内部**" ✗：
    #
    #   * **loop 每 `loop_beats` 拍重来一次** ✓（`loop_index` 加一 ✓，相位归零 ✓）
    #   * **一个 loop 内只播一遍** ✓ —— 短的不再被拉伸铺满 ✗、也不再取模自循环 ✗
    #   * **超出这条轨圈长的部分截断** ✓
    #   * **不足就静音** ✓（`phase >= cycle_beats` ✓）
    #   * **严格从 loop 第 0 拍起** ✓ —— **没有 offset** ✗
    #
    #   返回 ✓：
    #     * `:active`     —— 这一刻该响吗 ✓
    #     * `:from`/`:to` —— 在**圈坐标**里查哪一段 ✓（已被圈长与 loop 剩余截断 ✓）
    #     * `:loop_index` —— 第几轮 loop ✓（去重键用它 ✓：每轮重置 ✓）
    def loop_phase(global_beat, loop_beats)
      return 0.0 unless loop_beats.to_f.positive?
      global_beat.to_f % loop_beats.to_f
    end

    def loop_window(global_beat, loop_beats, cycle_beats, horizon)
      lb = loop_beats.to_f
      cb = cycle_beats.to_f
      raise ArgumentError, "loop_beats 必须为正（收到 #{loop_beats.inspect}）" unless lb.positive?
      raise ArgumentError, "cycle_beats 必须为正（收到 #{cycle_beats.inspect}）" unless cb.positive?

      phase = loop_phase(global_beat, lb)
      loop_index = (global_beat.to_f / lb).floor
      # **不足就静音** ✓（超出这条轨的圈长 ✓）
      return { active: false, from: 0.0, to: 0.0, loop_index: loop_index } if phase >= cb

      # ⚠️ **三重截断** ✓：本轨圈长 ✓、本 loop 剩余 ✓、查询地平线 ✓ —— 取最小 ✓
      to_phase = [phase + horizon.to_f, cb, lb].min
      { active: true, from: phase / cb, to: to_phase / cb, loop_index: loop_index }
    end

    # 圈坐标 → **全局绝对拍** ✓（在**当前这一轮 loop** 里 ✓，无 offset ✓）。
    def loop_beat(onset_cycle, loop_index, loop_beats, cycle_beats)
      loop_index.to_f * loop_beats.to_f + onset_cycle.to_f * cycle_beats.to_f
    end
  end
end
