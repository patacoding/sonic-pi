# The web scheduler: three verbs on the language class, and the state behind them in globals.
#
# State lives in $pampa_pattern_* because a method opened with class_eval cannot see the program's sandbox constants: the
# constant lookup inside class_eval follows the language class, not this file. Globals resolve everywhere, and the desktop
# extension already keeps its registry in $pampa_*.
#
# The two timing rules here were measured, not guessed (both were wrong in the first prototype and showed up as a track that
# played one cycle and stopped, and as a 7.31 s hole at a handover):
#
#   * __p.time is this THREAD's logical time, not the session's. link_time_at_beat / link_beat_at_time are the conversion
#     the runtime itself uses in advance!; assigning a session beat into p.time rewinds the thread and its next sleep
#     lands outside the window.
#   * a Run must compute its pp_start bar from the SESSION's beat (link_beat_at_time), or a second Run starts a whole
#     pp_start-offset later and leaves a hole between the two versions.
#
# A second pplay for the same name supersedes the first at a cycle line rather than cutting it mid-cycle: pp_events are already
# scheduled for the cycle that is playing, so the pp_old track leaves the moment its cycle ends, and the new one begins on the
# bar line. Measured through the whole handover: no overlap, no gap, largest gap exactly one beat.

pp_mini = Mini
pp_cls = SonicPi.current_lang.class
$pampa_pattern_tracks ||= {}
$pampa_pattern_generation ||= 0

pp_cls.class_eval do
  define_method(:ppattern) do |spec, cycle: nil|
    # Mini.pattern takes the pp_mini syntax as a string (its parser calls strip). Arrays are this wrapper's business: nesting
    # becomes [...], elements are joined by a space. cycle: is accepted for signature compatibility and unused for now.
    pp_to_mini = lambda do |x|
      x.is_a?(Array) ? ("[" + x.map { |y| pp_to_mini.call(y) }.join(" ") + "]") : x.to_s
    end
    pp_mini.pattern(spec.is_a?(Array) ? pp_to_mini.call(spec) : spec.to_s)
  end

  define_method(:pplay) do |pat, use: :play, name: nil, cycle_beats: nil, align: true, cycles: nil,
                             map: nil, sync: nil, max_pending: nil|
    # The desktop API, not an invented one: the loop comes from set :pampa_loop_bars x set :pampa_beats_per_bar, a bar is
    # pampa_beats_per_bar, and a pattern's own length is cycle_beats (which may not exceed the loop). Options this build
    # does not implement are refused by name rather than ignored, because a silently ignored sync: would look like a bug
    # in the music rather than a gap in the port.
    raise NotImplementedError, "pplay's map: is not on the web yet" if map
    raise NotImplementedError, "pplay's sync: is not on the web yet (the interface for live_loop interop)" if sync
    raise NotImplementedError, "pplay's max_pending: is not on the web yet" if max_pending
    pp_bar = ((get(:pampa_beats_per_bar) || 4)).to_f
    pp_loop = ((get(:pampa_loop_bars) || 1)).to_f * pp_bar
    pp_cycle = (cycle_beats || pp_loop).to_f
    raise ArgumentError, "cycle_beats (#{pp_cycle}) may not exceed the loop (#{pp_loop} beats)" if pp_cycle > pp_loop
    raise ArgumentError, "cycle_beats must be positive, got #{pp_cycle}" unless pp_cycle > 0
    pp_name = name || ("pattern_" + ($pampa_pattern_generation = ($pampa_pattern_generation || 0) + 1).to_s)
    pp_track_name = pp_name
    name = pp_track_name
    raise ArgumentError, "cycle_beats must be positive, got #{pp_cycle.inspect}" unless pp_cycle.is_a?(Numeric) && pp_cycle > 0

    pp_tracks = ($pampa_pattern_tracks ||= {})
    pp_old = pp_tracks[pp_track_name]
    # Superseding is deferred to the old track's own cycle line, and the new version starts there: the old one plays until
    # the point the new one begins. Measured before this rule: beats 8,9,10,11 then 13 -- beat 12 missing, a one-beat hole
    # between a track finishing and its replacement starting.
    pp_gen = ($pampa_pattern_generation = ($pampa_pattern_generation || 0) + 1)
    pp_tid = { name: pp_track_name, generation: pp_gen, superseded: false, started_beat: nil, stopped: false }
    pp_tracks[pp_track_name] = pp_tid

    pp_events = pat.query_arc(0r, 1r).select { |e| e.whole }
    pp_now_beat = __p.link_beat_at_time(__p.time)
    pp_start = align == false ? pp_now_beat : ((pp_now_beat / pp_bar).ceil * pp_bar)   # the next bar line
    # A bar already under way cannot be claimed: an event scheduled at a beat the session has passed is dropped, which is
    # exactly the one-beat hole measured at 12.0 (the old track stopped there, the new one's first event never landed).
    # The lead is the RUNTIME's, not a number of mine: dev-discipline (desktop) says a delivery must never be reached by
    # sleeping, the ahead time comes from sched_ahead, and "is there enough lead" is judged by the engine's lates, not by a
    # comfortable-looking epsilon. So a bar is only claimable if its handover window is still open.
    pp_lead_beats = __p.sched_ahead.to_f * SonicPi.link_bpm / 60.0
    pp_start += pp_bar if (pp_start - pp_now_beat) < pp_lead_beats
    if pp_old && pp_old[:stop_at]
      pp_start = [pp_start, pp_old[:stop_at]].max       # never before the old version leaves
    end
    (pp_old[:stop_at] = pp_start) if pp_old             # it leaves exactly where this one begins
    pp_tid[:started_beat] = pp_start

    pp_cycles_seen = 0
    in_thread(name: "pampa_#{pp_track_name}_#{pp_gen}") do
      pp_base = pp_start
      puts "[ptrack] #{name} gen=#{pp_gen} start=#{pp_start} inherited_beat=#{__p.link_beat_at_time(__p.time).round(3)}" if $pampa_pattern_debug
      loop do
        break if pp_tid[:stop_now] || (pp_tid[:stop_at] && pp_base >= pp_tid[:stop_at]) || pp_tid[:superseded]
        pp_events.each do |e|
          break if pp_tid[:stop_now] || (pp_tid[:stop_at] && pp_base >= pp_tid[:stop_at])
          pp_at_beat = pp_base + e.whole.begin.to_f * pp_cycle
          # The desktop rule: never sleep to the event. Wait only until the handover window opens (the event's moment
          # minus sched_ahead), then set the thread's logical time to the event's beat and let the scheduler stamp it.
          # ONE coordinate system throughout: link_beat_at_time(p.time) is the session beat of this thread's now.
          pp_hold_beat = __p.link_beat_at_time(__p.link_time_at_beat(pp_at_beat) - __p.sched_ahead)
          pp_now_beat = __p.link_beat_at_time(__p.time)
          pp_wait = pp_hold_beat - pp_now_beat
          sleep pp_wait if pp_wait > 0
          if $pampa_pattern_debug
            pp_woke = __p.link_beat_at_time(__p.time)
            puts "[ptrack] #{name} gen=#{pp_gen} target=#{pp_at_beat.round(3)} woke_at=#{pp_woke.round(3)} wait=#{pp_wait.round(3)}"
          end
          __p.time = __p.link_time_at_beat(pp_at_beat)
          __p.beat = pp_at_beat
          send(use, e.value)
        end
        pp_cycles_seen += 1
        break if cycles && pp_cycles_seen >= cycles.to_i
        pp_base += pp_loop           # the loop advances, not the cycle: a cycle shorter than the loop leaves silence
        pp_hold_beat = __p.link_beat_at_time(__p.link_time_at_beat(pp_base) - __p.sched_ahead)
        pp_wait = pp_hold_beat - __p.link_beat_at_time(__p.time)
        sleep pp_wait if pp_wait > 0
      end
      puts "[ptrack] #{name} gen=#{pp_gen} left at beat=#{__p.link_beat_at_time(__p.time).round(3)}" if $pampa_pattern_debug
      pp_tid[:stopped] = true
    end

    { track: pp_track_name, generation: pp_gen, start_beat: pp_start.to_f, pp_events: pp_events.length,
      cycle_beats: pp_cycle, loop_beats: pp_loop,
      superseded_before: !pp_old.nil? }
  end

  define_method(:pstop) do |name = nil|
    pp_tracks = ($pampa_pattern_tracks ||= {})
    if name
      t = pp_tracks[name]
      t[:stop_at] = 0 if t          # 0: leave at its next cycle line
    else
      pp_tracks.each_value { |t| t[:stop_at] = 0 }
    end
    nil
  end
end

"prelude ok"
