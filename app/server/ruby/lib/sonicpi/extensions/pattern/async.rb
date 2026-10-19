require_relative 'position'
require_relative 'delivery'
require_relative 'pattern-lib'
# Verb documentation entries (generated) -> registered into Sonic Pi's shared docs
# registry, which is what makes them appear in the editor's autocompletion list.
require_relative 'verbs-doc'

# Driver for the timing extension.
#
# ARCHITECTURE (settled 2026-10-16, after the user described it):
#
#   Our timing semantics is one DAW track. A global loop length in bars is user-set
#   (`loop_bars` x `beats_per_bar`, so 4/4 and 3/4 both work). Playback progress comes from
#   Sonic Pi's own clock, and code edits take effect on the next grid line - the user accepts
#   waiting for the grid.
#
#   The consequence is that there is exactly ONE ticker thread, not one thread per player.
#   On every tick it reads the global beat, and for every registered player it emits the
#   events that fall in the next scheduling window. Position is a pure function of the
#   global beat, so there is no per-player cursor to drift and no per-player thread start-up
#   to be late.
#
# WHY ONE TICKER instead of a thread per player:
#   A thread per player was measured to start late. With `link(n)` in the child it blocked
#   for up to a whole cycle (measured: the loop itself paced correctly at dt 0.505, yet only
#   two iterations fitted in a four second window, so entry was about 3s late), and even
#   without `link` a four second window still showed a single iteration. One ticker moves
#   that startup cost from every player to the single ticker.
#
# WHY THE GLOBAL BEAT instead of a link()'d thread beat:
#   `link()` blocks to the next grid line and re-anchors the thread, which is exactly what a
#   ticker must not do. Instead we calibrate ONCE: `beats_offset = thread_beat - global_beat`,
#   then every delta is `(event_global_beat - global_beat) + beats_offset`.
#   Measured: offset 0.405 beats, no blocking.
#
# WHY RELOAD IS FREE:
#   Position is read from the global beat, never accumulated, so a reload at bar 7 continues
#   at bar 7. Edits are applied lazily: `pplay` and `pstop` only mark the registry dirty, and
#   the ticker swaps in a fresh snapshot at the start of a tick, i.e. on a grid line.
module PampaPattern
  module Runtime
    # How far ahead of the global beat each tick schedules, in beats. Must stay within
    # `sched_ahead` (0.5s on desktop), otherwise the engine scheduler queue is asked for more
    # than it holds and silently drops.
    TICK_SCHED_BEATS = 0.5

    # ---------------------------------------------------------------------------------
    # Public API
    # ---------------------------------------------------------------------------------

    # Start (or replace) a named player. Returns `{ name: name }` immediately; the player
    # joins on the next grid line, which is the point of live coding.
    def pplay(pattern, **opts)
      # ⚠️ **`cycles:` 已删除** ✗（2026-10-16 ✓）—— 它从来只是**占位** ✓：
      #   心跳**从没读过它** ✗ → 写了也不会停 ✓。**假选项比没有更糟** ✗
      #   （用户以为"播 8 圈就停" ✓，实际一直响 ✓）。要停用 `pstop` ✓。
      # ⚠️ **只有真的会被读的键**才配默认值 ✓ —— 假选项比没有更糟 ✗（见上方注释）
      opts = { use: :play, name: nil }.merge(opts)
      @__pseq = (@__pseq || 0) + 1
      name = opts[:name] || :"__ppattern_#{@__pseq}"
      opts[:map] = PampaPattern.default_map_for(opts[:use]) unless opts.key?(:map)

      loop_bars     = (get(PampaPattern::LOOP_BARS_KEY) rescue nil)
      beats_per_bar = (get(PampaPattern::BEATS_PER_BAR_KEY) rescue nil)
      loop_beats    = PampaPattern.loop_beats_for(loop_bars, beats_per_bar)
      opts[:beats_per_bar] = (beats_per_bar || PampaPattern::DEFAULT_BEATS_PER_BAR).to_f

      PampaPattern.normalize_cycle_beats(opts[:cycle_beats], 'cycle_beats:') if opts[:cycle_beats]
      opts[:cycle_beats] = PampaPattern.cycle_beats_for(
        opts,
        (get(PampaPattern::CYCLE_BEATS_KEY) rescue nil),
        PampaPattern.cycle_beats_of(pattern),
        loop_beats: loop_beats
      )

      __psrc = __pcaller_site
      spec = {
        name: name,
        # 身份 = 这一行代码（不同行 = 不同 track；用户定的语义）
        src_path: __psrc[:path],
        src_line: __psrc[:line],
        pattern: pattern,
        # ⚠️ **心跳要用 loop 长度** ✓（严格对齐 ✓、截断/静音 ✓）—— 原来只在 pplay 里算完就丢了 ✗
        loop_beats: loop_beats,
        # ⚠️ **属于哪一次 run** ✓ —— 同一次 run 起的播放器，随这次 run 结束一起停 ✓
        receiver: self,
        opts: opts,
        job_id: __pjob_id,
        stop: false,
        created_at: Time.now.to_f,
        sent: 0,
        first_sent_at: nil
      }

      __pplayers_mutex.synchronize do
        old = __pplayers[name]
        old[:stop] = true if old
        __pplayers[name] = spec
        $pampa_pattern_dirty = true
      end
      __pjob = spec[:job_id]
      $pampa_pattern_last_job = __pjob if __pjob
      # 每个文件各自记最新一版 job（多 buffer 互不干扰）
      $pampa_pattern_job_by_path = ($pampa_pattern_job_by_path || {})
      $pampa_pattern_job_by_path[__psrc[:path]] = __pjob if __pjob && __psrc[:path]
      # ⭐ **一条 track = 一个 Sonic Pi 线程**（和 `live_loop` 同构）
      #   * 它自己用 Sonic Pi 的 `sleep`（拍）走到每个事件的拍位 ✓
      #   * 位置**每次都从全局拍算**（每轮 loop 重新锚）✓ → 不漂 ✓、与其他 track 天然对齐 ✓
      #   * 小节边界的"热更新"只负责启停这些线程 ✓，不参与排程 ✓
      __pstart_track(spec)
      __pensure_bar_watcher
      $pampa_pattern_beats = ($pampa_pattern_beats || {})
      $pampa_pattern_beats[name] = spec[:beats] ||= []
      { name: name }
    end

    # Stop one player by name, or every player that exists right now.
    def pstop(name = nil)
      __pplayers_mutex.synchronize { __pstop_locked(name) }
      nil
    end

    # The unlocked body of `pstop`. Callers must already hold `__pplayers_mutex`.
    #
    # Named stop is exact. Stop-all marks the players that exist at that instant and also
    # advances a monotonic wall-clock mark, so a player created after the mark is never hit -
    # that race used to make freshly registered players emit nothing.
    def __pstop_locked(name = nil)
      if name
        s = __pplayers[name]
        if s
        s[:stop] = true
        (s[:thread].kill rescue nil)   # 立刻停 ✓（它会停在 sleep 里）
      end
      else
        now = Time.now.to_f
        $pampa_pattern_stop_before = [$pampa_pattern_stop_before || 0.0, now].max
        __pplayers.each_value { |s| s[:stop] = true if s[:created_at].to_f <= now }
      end
      $pampa_pattern_dirty = true
      nil
    end

    # Current progress. Rides the Link clock - Sonic Pi's own global beat - so it is the same
    # in every thread, continuous across reloads, and unaffected by engine restarts.
    #
    #   pbar  #=> { beat:, bar:, bar_in_loop:, beat_in_bar:, cycle:,
    #               loop_bars:, beats_per_bar:, loop_beats: }
    def pbar(cycle_beats: nil)
      beat = __pglobal_beat
      return nil if beat.nil?
      loop_bars     = ((get(PampaPattern::LOOP_BARS_KEY) rescue nil) || PampaPattern::DEFAULT_LOOP_BARS)
      beats_per_bar = ((get(PampaPattern::BEATS_PER_BAR_KEY) rescue nil) || PampaPattern::DEFAULT_BEATS_PER_BAR)
      lb = PampaPattern.loop_beats_for(loop_bars, beats_per_bar)
      cb = cycle_beats || (get(PampaPattern::CYCLE_BEATS_KEY) rescue nil) || lb
      {
        beat: beat,
        bar: PampaPattern::Position.bar_index(beat, beats_per_bar),
        bar_in_loop: PampaPattern::Position.bar_in_loop(beat, beats_per_bar, loop_bars),
        beat_in_bar: PampaPattern::Position.beat_in_bar(beat, beats_per_bar),
        cycle: beat / cb.to_f,
        loop_bars: loop_bars.to_f,
        beats_per_bar: beats_per_bar.to_f,
        loop_beats: lb
      }
    end

    # Per-player counters, so a test can ask "did it actually emit anything" instead of
    # "is it registered" - registration is synchronous and passes even when the player never
    # makes a sound (measured: that was a false pass for several rounds).
    #
    # The archive matters: once a player is stopped it leaves the registry, and a test that
    # stops first and reads afterwards would get nil and crash (measured: `pstats(:x)[:sent]`
    # raising NoMethodError on nil). Purged specs are copied into the archive before removal.
    def pstats(name)
      s = __pplayers[name] || $pampa_pattern_stats[name]
      return nil unless s
      {
        sent: s[:sent].to_i,
        first_sent_at: s[:first_sent_at],
        started_at: s[:created_at],
        ended_at: s[:ended_at]
      }
    end

    def pstats_clear
      $pampa_pattern_stats = {}
      nil
    end

    # ---------------------------------------------------------------------------------
    # Ticker
    # ---------------------------------------------------------------------------------

    def __pglobal_beat
      @link_api.link_get_beat_at_clock_time(Time.now.to_f)
    rescue StandardError
      nil
    end

# ── ⭐ **热更新：每个小节边界重新核对"这一版代码还声明了哪些播放器"** ──────────────
#
# ⚠️⚠️ **这是用户定的语义**（2026-10-16 重申）：
#   *"每个小节处需要检查当前所有代码 —— 不管是编辑更新了，还是注释掉了，
#     当用户 reload 的时候，都要在**下个小节**处进行热更新"* ✓。
#
# **实现** ✓：
#   * 每次 `pplay` 把 **`__current_job_id`**（= 这一版代码的标识 ✓）记进 spec ✓，
#     并把它记为 **`$pampa_pattern_last_job`**（最新一版 ✓）。
#   * 心跳**只在"小节编号变了"的那一刻** ✓ 做一次核对：
#       某个播放器的 job **不是**最新那版 ✓ **且** 那个 job **已经不在跑** ✓ → **停掉它** ✓
#     两个条件缺一不可 ✗：
#       - 只比 job → 同一版代码里分几次 `pplay` 会被误杀 ✗
#       - 只看死活 → 代码跑完但没被替换的那版会被立刻杀掉 ✗（那样就必须 `sleep` 了 ✗）
#
# **效果** ✓：
#   * 改一行再 Run → 下一小节生效 ✓（同名 `pplay` 替换 ✓）
#   * **注释掉一行再 Run → 下一小节那个播放器停** ✓
#   * 代码跑完不按 Run → **照常继续响** ✓（不需要 `sleep` ✓）
  # 调用点 = 用户代码里的 [文件, 行号]（跳过扩展自己的栈帧）
  def __pcaller_site
    here = File.expand_path('..', __dir__)
    caller_locations.each do |loc|
      p = loc.path.to_s
      next if p.empty?
      next if p.start_with?(here)
      return { path: p, line: loc.lineno }
    end
    { path: nil, line: nil }
  end

def __pjob_id
  jid = __current_job_id
  # ⚠️ 拿不到 job id → **热更新会静默失效**（注释掉的行不会停）→ **必须喊一声**，
  #   否则它就像这一轮一样：改了代码没反应，而且日志里什么也看不出来。
  warn '[pplay] 拿不到 __current_job_id —— 热更新（注释掉即停）将不生效' if jid.nil?
  jid
rescue StandardError
  nil
end

def __pjob_alive?(job_id)
  return true if job_id.nil?
  @user_jobs.running?(job_id)
rescue StandardError
  true
end

# 小节边界核对 ✓ —— **只在换小节时调用** ✓（不是每个 tick ✗）
def __preconcile_at_bar
  by_path = $pampa_pattern_job_by_path || {}
  __pplayers_mutex.synchronize do
    __pplayers.each_value do |s|
      next if s[:stop]
      next if s[:job_id].nil?
      latest = by_path[s[:src_path]]
      next if latest.nil?            # 这个文件还没记录过 → 不乱动
      next if s[:job_id] == latest   # 这一版还声明着 → 留着
      # ⚠️ **不在这里杀线程** ✗ —— 它杀的是"注册表里那个" ✓，而同名 `pplay` 早已把注册表
      #   换成新 spec ✗ → 旧线程成孤儿还活着 ✓、新线程被误杀 ✗
      #   （实测：旧线程 sent=9 仍在 pass ✓、新 spec 4 秒 0 条 ✗）。
      #   改成**线程自判生死** ✓（见 `__ptrack_loop` 开头的三个条件 ✓）。
      s[:stop] = true
    end
  end
  $pampa_pattern_dirty = true
  nil
end

    # ⭐ **每次 run 都记一条** —— 这是"注释掉一行就停"唯一靠谱的判据 ✓
    #
    # ⚠️ 之前只在 **`pplay` 被调用时**记 `by_path` ✗ → 把那一行注释掉之后，
    #   新一版代码**不会再调用 `pplay`** ✗ → `by_path` 还是旧 job ✗ →
    #   reconcile 认为"这一版还声明着" ✓ → **永远不停** ✗（这正是文档里那条已知限制 ✗）。
    #
    # 现在用上游的生命周期钩子 ✓（`LifeCycleHooks#on_init` ✓，**每次 run 都会调** ✓，
    #   而且在**那个 run 自己的线程里** ✓ → `__current_job_info` 读得到 `:workspace` ✓）。
    # ⚠️ 实测：`info[:workspace]` 与 `caller_locations.path` **是同一个标识** ✓（都是 "eval"/缓冲区名 ✓）。
    def __pinstall_lifecycle_hook
      return nil if $pampa_pattern_hook_installed
      @life_hooks.on_init do |job_id, _arg|
        info = (begin
          __current_job_info
        rescue StandardError
          {}
        end) || {}
        ws = info[:workspace]
        next if ws.nil?
        $pampa_pattern_job_by_path = ($pampa_pattern_job_by_path || {})
        $pampa_pattern_job_by_path[ws] = job_id
        $pampa_pattern_last_job = job_id
      end
      $pampa_pattern_hook_installed = true
      nil
    rescue StandardError => e
      warn "[pplay] 装生命周期钩子失败：#{e.class}: #{e.message}（注释即停将退化为不可用）"
      nil
    end

    def __pensure_ticker
      __pinstall_lifecycle_hook
      return nil if $pampa_pattern_ticker && $pampa_pattern_ticker.alive?
      $pampa_pattern_ticker = in_thread(name: :__pampa_ticker) do
        begin
          __pticker_loop
        rescue StandardError => e
          warn "[pticker] 停止：#{e.class}: #{e.message}`n" \
                "  #{e.backtrace&.first(4)&.join("`n  ")}"
        ensure
          $pampa_pattern_ticker = nil
        end
      end
      nil
    end

    # One thread, one grid. Every tick:
    #   1. lazily swap in the registry snapshot if anything changed (reload takes effect here)
    #   2. read the global beat once - it is the single source of position
    #   3. for each player, emit the events that fall in the next window
    # ⭐ **每条 track 一个线程**：自己对齐、自己排程
    #
    # 对齐为什么成立（用户的问题）：**位置是算出来的，不是协商出来的** ✓
    #   gb   = 全局拍（Sonic Pi 的 Link 时钟 ✓）
    #   phase = gb % loop_beats ✓、loop_idx = floor(gb / loop_beats) ✓
    #   abs  = loop_idx * loop_beats + onset * cycle_beats ✓
    #   wait = abs - gb ✓ → `sleep wait`（**Sonic Pi 的拍** ✓）
    # ⚠️ 每轮 loop 都**重新读一次 gb** ✓（不靠累加的 sleep ✗）→ 自我校正 ✓ → 不会漂 ✓。
    #
    # 语义保持：一圈内只播一遍 ✓、超出 loop 截断 ✓、不足静音 ✓、每轮从 loop 第 0 拍起 ✓。
    def __pstart_track(spec)
      # ⚠️ 线程名必须**唯一** ✗ —— 同名 `pplay` 重新声明时旧线程可能还活着 ✓，
      #   同名 `in_thread` 会让新线程起不来 ✓（实测：新线程连第一轮都没跑 ✗）。
      spec[:thread] = in_thread(name: :"__ptrack_#{spec[:name]}_#{spec.object_id}") do
        __ptrack_loop(spec)
      end
    rescue StandardError => e
      # ⚠️ 起线程失败**必须喊** ✗ —— 否则就是「注册了但永远不出声」（这一轮踩过两次）
      warn "[pplay] 起 track 线程失败：#{e.class}: #{e.message}"
      nil
    end

    # Link 的 tempo（**UI 上那个 bpm** ✓）—— 读不到就**喊出来**，不静默假设 60 ✗
    def __plink_tempo
      t = @link_api.link_tempo
      return t.to_f if t.is_a?(Numeric) && t.to_f.positive?
      warn '[pplay] 读不到 Link tempo —— 时序将不可靠'
      60.0
    rescue StandardError => e
      warn "[pplay] 读 Link tempo 失败：#{e.class}: #{e.message}"
      60.0
    end

    def __ptrack_loop(spec)
      lb = spec[:loop_beats].to_f
      opts = spec[:opts]
      # 兜底顺序与 `PampaPattern.cycle_beats_for` 一致：**先 loop 长度，最后才 4.0**
      # （`pplay` 一定会先把 `opts[:cycle_beats]` 填好，所以这里只是防御）。
      cb = (opts[:cycle_beats] || lb || PampaPattern::DEFAULT_CYCLE_BEATS).to_f
      raise ArgumentError, 'loop 长度必须为正' unless lb.positive? && cb.positive?
      # ⚠️⚠️ **时间基只有两个来源，都来自 Link**（2026-10-16 定的）：
      #   ① **拍数**：`link_get_beat_at_clock_time` ✓ —— 全局唯一 ✓、跨线程一致 ✓、
      #      **不随 reload/buffer 重置** ✓（实测：4 线程同刻读数差 ≤ 0.7ms ✓）
      #   ② **每拍多少秒**：`link_tempo` ✓ —— **UI 上那个 bpm 就是它** ✓
      #      （`bpmscrubwidget → SetLinkBPM → link_set_bpm!` ✓）。
      #   ⚠️ **绝不写死 60** ✗（那只是默认值 ✓，用户会在 UI 上改 ✓）；
      #   ⚠️ **也不用 `use_bpm`** ✗（它只改本 buffer 的线程 ✓，与 Link 无关 ✗）。

      while true
        break if spec[:stop]
        # ⭐ **自己判断该不该活**（不靠外部杀 ✗）—— 任一成立就退休 ✓：
        #   ① 注册表里已经不是我这个 spec ✓（同名 `pplay` 取代了我 ✓）
        #   ② 这个文件最新一版 run 已不是我这一版 ✓（那一行被注释/删掉 ✓）
        _reg = __pplayers[spec[:name]]
        break unless _reg.equal?(spec)
        _jid = spec[:job_id]
        break if _jid && (($pampa_pattern_job_by_path || {})[spec[:src_path]] || _jid) != _jid
        gb = __pglobal_beat.to_f                       # Link 的拍（现读 ✓）
        _tempo = __plink_tempo.to_f
        _beat_secs = 60.0 / _tempo                     # tempo 变了这里跟着变 ✓
        loop_idx = (gb / lb).floor
        cycle_start = loop_idx * lb
        phase = gb - cycle_start          # 本轮 loop 内已走几拍
        if $pampa_pattern_debug
          warn format('[pass] loop=%d phase=%.2f t=%.3f sent=%d', loop_idx, phase, Time.now.to_f % 100, spec[:sent].to_i)
        end

        # ⚠️ **一轮只排一次** —— 之前每个 pass 都重排同一轮 ✗ →
        #   实测拍号里出现 `15.5 15.5` 与间隔 0 ✗（判据抓到的正是这个 ✓）。
        if phase < cb
          # ⚠️ **不能**用"一轮只排一次"做去重 ✗ —— 如果这一轮的 pass 来晚了（phase 已经 1.5 拍 ✓），
          #   那一整轮的前半圈就**永远不再排** ✗（实测：每轮只发 4 条而非 8 条 ✗）。
          #   去重交给**拍号集合** ✓（见下），pass 频率保持在几十毫秒 ✓。
          # 本轨在这一轮里"该响的区间"是 [cycle_start, cycle_start + min(cb, lb)) ✓
          hi = [cb, lb].min
          events = PampaPattern.query_with_seed(
            spec[:pattern], phase / cb, (hi - cycle_start + cycle_start) / cb + 1,
            (opts[:seed] || Thread.current[:pampa_seed])   # `seed:` 真的生效了 ✓
          ).select(&:whole)

          keys = (spec[:keys] ||= {})
          if spec[:keys_loop] != loop_idx
            spec[:keys_loop] = loop_idx
            keys.clear
          end

          events.sort_by { |h| h.whole.begin.to_f }.each do |h|
            break if spec[:stop]
            onset = h.whole.begin.to_f
            abs = cycle_start + onset * cb
            next if abs < cycle_start + phase - 0.001   # 已经过去了（不补发）
            next if abs >= cycle_start + hi             # 截断 ✓
            next if keys[(abs * 8).round]                # 这一轮已排过这一下 ✓
            keys[(abs * 8).round] = true
            warn "[ptrack]   发 onset=#{onset.round(3)} abs=#{abs.round(2)}" if $pampa_pattern_debug

            # ⚠️⚠️ **不用 `sleep` 等待** ✗（2026-10-16 实测：睡 0.05 秒实际 1.008 秒 ✗，
            #   且它追不上就缩短 ✗）→ **把逻辑拍设到 abs** ✓，交给 Sonic Pi 排程 ✓。
            _now_beat = (__pglobal_beat || 0.0).to_f
            _ahead_s = ((__current_sched_ahead_time rescue nil) || 0.5).to_f
            _lt = Time.now.to_f + (abs - _now_beat) * _beat_secs - _ahead_s
            __change_spider_time_and_beat!(_lt, abs)
            break if spec[:stop]

            mid = h.whole.begin.floor + 1r / 2
            PampaPattern.deliver(spec[:receiver], h.value, opts, mid)
            spec[:sent] = spec[:sent].to_i + 1
            spec[:first_sent_at] ||= Time.now.to_f
            # ⭐ 排出去的**拍号**（判据用它 ✓ —— 墙钟间隔测不出排程对不对 ✗）
            (spec[:beats] ||= []) << abs
            (spec[:beats].shift; spec[:beats].shift) while spec[:beats].size > 256
            (spec[:times] ||= []) << Time.now.to_f
            spec[:times].shift while spec[:times].size > 64
          end
        end

        break if spec[:stop]
        # 静音段 / 本轮剩余：等到**下一条 loop 线**（重新锚 ✓）
        now = (__pglobal_beat || __pcurrent_beat).to_f
        rest = (loop_idx + 1) * lb - now
        # ⚠️ 用**秒**等 ✓（Sonic Pi 的 `sleep` 是拍、且追不上会缩短 ✗）；
        #   已经在边界上时**也别空转** ✗（空转会让同一轮被 pass 两次 ✗）。
        wait_s = rest * _beat_secs
        # 最多等 50ms ✓: 留在本轮里多 pass 几次 ✓ → 晚到的 pass 也能把漏掉的补上 ✓
        _w = [[wait_s, 0.05].min, 0.002].max
        warn format('[wait] %.3fs', _w) if $pampa_pattern_debug
        # ⚠️ **不能 `Kernel.sleep`** ✗ —— 实测睡 0.05 秒实际过去 1.008 秒 ✗（被上游接管 ✓）。
        #   自旋等待 ✓（只用于别空转 ✓，不影响任何事件时刻 ✓ —— 时刻由 `abs` 算 ✓）。
        _deadline = Time.now.to_f + _w
        Thread.pass while Time.now.to_f < _deadline
      end
    rescue StandardError => e
      warn "[ptrack] #{spec[:name].inspect} 结束：#{e.class}: #{e.message}"
      warn "  #{e.backtrace&.first(3)&.join(' | ')}"
    end

    # 小节边界的**热更新**（只管启停 track ✓，不参与排程 ✓）
    #
    # ⚠️ 这里用 `Kernel.sleep`（秒）✓ —— 它不交付任何东西 ✓，所以不需要 Sonic Pi 的逻辑时钟 ✓；
    #   而 Sonic Pi 的 `sleep`（拍）在这个"每小节醒一次"的场景下会挂住（实测过一次任务后不再动 ✗）。
    def __pensure_bar_watcher
      return nil if $pampa_pattern_watcher && $pampa_pattern_watcher.alive?
      $pampa_pattern_watcher = in_thread(name: :__pbar_watcher) do
        while true
          bpb = (get(PampaPattern::BEATS_PER_BAR_KEY) || PampaPattern::DEFAULT_BEATS_PER_BAR).to_f
          # ⚠️ **时间基与 track 完全一致**：Link 拍 + Link tempo ✓（不写死 60 ✗）
          beat_seconds = 60.0 / __plink_tempo.to_f
          gb = __pglobal_beat.to_f
          to_bar = bpb - (gb % bpb)
          to_bar = bpb if to_bar <= 0.002
          # ⚠️⚠️ **不能用 `Kernel.sleep`** ✗（实测：睡 0.05 秒实际过去 1.008 秒 ✗）→
          #   自旋到点 ✓（精度毫秒 ✓；“下一小节生效”才成立 ✓）。
          _deadline = Time.now.to_f + to_bar * beat_seconds
          Thread.pass while Time.now.to_f < _deadline
          begin
            __preconcile_at_bar
          rescue StandardError => e
            warn "[pbar] 热更新出错：#{e.class}: #{e.message}"
          end
          break if __pplayers.empty?
        end
      end
    end

# ⚠️ 原来这里有一个 `__psync_thread_state`（把 `@__pampa_seed` 塞进线程变量）——
#   **两边都没人用** ✗：`@__pampa_seed` 从没被赋值 ✓、这个方法从没被调用 ✓。
#   `seed:` 现在由 `opts[:seed]` 直接生效 ✓（见 `__ptrack_loop` 的查询处 ✓），所以删掉 ✓。
  end
end

$pampa_pattern_specs = {}
$pampa_pattern_dirty = true
$pampa_pattern_ticker = nil
$pampa_pattern_stop_before = 0.0
  # ⚠️⚠️ **必须初始化** ✗（2026-10-16 真机「根本没声音」的根因）：`pstats_clear` 会建它、`pstats` 会读它，
  #   而**清出停止的播放器**时也要写它 —— 只要它还是 nil，第一次清出就 NoMethodError，
  #   于是**整个心跳线程死掉** → **所有播放器同时静音**（而每个播放器的 sent 还停在原处，看不出错）。
  $pampa_pattern_stats = {}
  # ⭐ 热更新：最新一版代码的 job / 上次核对的小节
  $pampa_pattern_last_job = nil
  $pampa_pattern_last_bar = nil
  $pampa_pattern_watcher = nil
  $pampa_pattern_beats = {}
  # 调试开关（nil = 关）；判据要求「用到就要在文件末尾初始化」
  $pampa_pattern_debug = nil
  $pampa_pattern_hook_installed = false
  $pampa_pattern_job_by_path = {}

# 装载即注册动词文档 ✓（@@docs 共享 ✓ → qt-doc.rb 自动收 ✓；离线时静默跳过 ✓）
PampaPattern.register_verb_docs! if PampaPattern.respond_to?(:register_verb_docs!)
