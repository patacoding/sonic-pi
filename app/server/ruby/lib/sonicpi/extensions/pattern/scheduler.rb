# 引擎时钟与队列深度的读取（从探针提炼）。**只读**，不发任何命令 ✓。
#
# 用途：
#   * `engine_bar_anchor` —— 对齐到引擎的**小节线**（`pplay anchor: :bar`）✓
#   * `engine_pending_events` —— 读待发事件数，用于**限流**（给既有 live_loop 留余量）✓
#
# 为什么用引擎自己的时钟：`beat`（`core.rb:4435`）是**线程本地的 sleep 计数器** ✓，
# 初值任意（实测形如 `109252.7`）✗ —— **它不是音乐网格** ✓，不能当锚 ✗。
# 引擎的 `ClockworkClockState` 才是 ✓（`bpm` + `beat_origin_ntp` ✓）。
require "json"

module PampaPattern
  module Scheduler
    module_function

    NTP_EPOCH_OFFSET = 2_208_988_800
    REGION_METRICS = 2

    # 引擎端口从 daemon 日志里读（与探针同一套做法 ✓）
    def engine_port(home = nil)
      home ||= ENV["SONIC_PI_HOME"] ||
               (defined?(SonicPi::Paths) ? File.dirname(SonicPi::Paths.log_path) : nil)
      log = if home && Dir.exist?(File.join(home, ".sonic-pi", "log"))
              File.join(home, ".sonic-pi", "log", "daemon.log")
            else
              File.join(Dir.home, ".sonic-pi", "log", "daemon.log")
            end
      return nil unless File.exist?(log)
      lines = File.read(log).lines
      start = lines.rindex { |l| l.include?("Selected ports:") }
      return nil unless start
      ports = lines[(start + 1)..].find { |l| l.include?("{") }
      ports && ports[/"scsynth"\s*=>\s*(\d+)/, 1]&.to_i
    end

    # ── 时钟：下一小节线的墙钟时刻（Unix 秒）──────────────────────────────────────────────
    #
    # 返回 { anchor_unix:, bpm:, beat_now:, bar_beat: }，或在读不到时返回 nil ✓。
    # **拍长取自引擎** ✓ —— 这条是本项目的一个教训：对齐了起点却仍用参数算拍长，
    # 会**同时坐在两个时钟上** ✗（看起来对，因为事件确实落在引擎的拍上 ✓）。
    def engine_bar_anchor(port: nil, beats_per_bar: 4)
      port ||= engine_port
      return nil unless port

      snap = read_clock_state(port)
      return nil unless snap

      now_ntp = Time.now.to_f + NTP_EPOCH_OFFSET
      beat_now = (now_ntp - snap[:origin]) * snap[:bpm] / 60.0
      bar_index = (beat_now / beats_per_bar).ceil
      bar_beat = bar_index * beats_per_bar
      anchor_ntp = snap[:origin] + bar_beat * 60.0 / snap[:bpm]

      { anchor_unix: anchor_ntp - NTP_EPOCH_OFFSET, bpm: snap[:bpm],
        beat_now: beat_now, bar_beat: bar_beat }
    rescue StandardError
      nil
    end

    # ── 队列：引擎当前待发事件数（限流用 ✓）────────────────────────────────────────────────
    def engine_pending_events(port: nil)
      port ||= engine_port
      return 0 unless port
      read_metrics(port)[:depth]
    rescue StandardError
      0
    end

    def engine_capacity(port: nil)
      port ||= engine_port
      return 0 unless port
      read_metrics(port)[:capacity]
    rescue StandardError
      0
    end

    # ── 底层：读共享内存（复用 Sonic Pi 自己的解析器 ✓ —— 不要手写 ✗）──────────────────────
    def __attach(port)
      require_relative "../../sonic-pi/app/server/ruby/lib/sonicpi/clockwork_shm_attach"
      require_relative "../../sonic-pi/app/server/ruby/lib/sonicpi/clockwork_arena"
      attach = SonicPi::ClockworkShmAttach
      io, size = attach.receive(attach.default_endpoint(port))
      begin
        mem = attach.map(io, size)
      ensure
        io.close if io.respond_to?(:close)
      end
      arena = SonicPi::ClockworkArena.parse(mem)
      [mem, arena, arena.send(:parse_table, mem.size)]
    end

    def read_metrics(port)
      mem, arena, entries = __attach(port)
      m = entries[REGION_METRICS]
      w = mem.bytes(arena.blob_offset + m[:offset], 42 * 4).unpack("L<42")
      { depth: w[3], peak: w[4], dropped: w[5], lates: w[8],
        max_late_ms: w[23], capacity: w[40], pool_bytes: w[41] }
    end

    # ClockState：bpm（f64）+ beat_origin_ntp（f64），见 clockwork_arena.rb 的 ClockState ✓
    def read_clock_state(port)
      mem, arena, _entries = __attach(port)
      raw = mem.bytes(arena.clock_state_offset, 40)
      bpm, origin = raw.unpack("E2")     # 前两个 f64 ✓
      return nil unless bpm && bpm.positive?
      { bpm: bpm, origin: origin }
    end
  end
end
