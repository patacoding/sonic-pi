#--
# This file is part of Sonic Pi: http://sonic-pi.net
# Full project source: https://github.com/samaaron/sonic-pi
# License: https://github.com/samaaron/sonic-pi/blob/main/LICENSE.md
#
# Copyright 2013, 2014, 2015, 2016 by Sam Aaron (http://sam.aaron.name).
# All rights reserved.
#
# Permission is granted for use, copying, modification, and
# distribution of modified versions of this work as long as this
# notice is included.
#++

require "open3"
require "fileutils"
require "securerandom"
require "tmpdir"
require_relative "synthdef_parser"

module SonicPi
  # Compiles a user's SynthDef source into a .scsyndef by driving sclang.
  #
  # TWO MODES, because the channel that drives a resident sclang does not work everywhere - measured,
  # not assumed (2026-10-01, Windows 11 + SuperCollider 3.14.1):
  #
  #   :resident     one sclang, kept alive, fed one `"<wrapper>.scd".load;` line per compile.
  #                 ~900 ms once, then ~100 ms per compile. This is what the web line does on Linux
  #                 (its service feeds sclang's stdin), and it works here when the process is started
  #                 from .NET/PowerShell. It does NOT work when RUBY starts sclang on Windows: three
  #                 line endings were tried (LF, CRLF, CR) and sclang never evaluated a single line,
  #                 even though the same binary started the same way from PowerShell answered on the
  #                 first line. So this mode is not the default on Windows.
  #   :per_compile  a fresh sclang per compile, given the wrapper as a FILE ARGUMENT. Measured
  #                 1.76-1.98 s per compile (the class library is already cached; the first run on a
  #                 machine pays ~9.7 s to build that cache). Reliable, exits by itself, no orphan.
  #
  # Whichever mode is in use, the rules that cost time to learn are the same:
  #
  #   * `-D` must NOT be passed: it is DAEMON MODE (sclang -h: "-D [ --daemon ] Enter daemon mode"),
  #     and a daemon does not evaluate what is written to its stdin;
  #   * a Ruby one-string spawn is parsed as a COMMAND LINE, and sclang's usual Windows home has a
  #     space in it, so it fails with Errno::ENOENT on "C:/Program"; pass arguments separately;
  #   * completion is signalled by a RESULT FILE the SuperCollider side appends to, never by parsing
  #     stdout: the REPL both prints what code posts and echoes the value of the loaded block, so a
  #     text sentinel matches twice and a later compile matches a stale line (measured: a "1 ms"
  #     compile whose def was 0 bytes). Each compile gets its own directory, so stale results are
  #     impossible by construction.
  #
  # What the user's file should be: a script whose RESULT is the SynthDef (or an Array of them).
  # This class writes the defs into a directory of its own and reads them back with SynthdefParser,
  # so the caller gets names, controls and real file paths - and never has to know a path itself.
  class SynthdefCompiler
    class Error < StandardError; end
    class SclangNotFound < Error; end
    class CompileError < Error; end
    class Timeout < Error; end

    # What one compile produced. `definition` is a SynthdefParser::Definition (name + controls).
    CompiledDef = Struct.new(:name, :path, :definition)
    Result = Struct.new(:defs, :output, :ms, :outdir)

    DEFAULT_READY_TIMEOUT = 60
    DEFAULT_COMPILE_TIMEOUT = 30
    OUTPUT_LINES_KEPT = 200

    attr_reader :sclang_path

    # Where sclang usually lives. `explicit` (or ENV["SCLANG"]) wins, so an unusual install is never
    # a dead end; the error names every path that was tried, because "sclang not found" with no
    # path in it is not something a user can act on.
    def self.find_sclang(explicit = nil)
      candidates = []
      candidates << explicit if explicit && !explicit.to_s.empty?
      candidates << ENV["SCLANG"] if ENV["SCLANG"] && !ENV["SCLANG"].empty?

      if Gem.win_platform?
        Dir.glob("C:/Program Files/SuperCollider-*/sclang.exe").sort.reverse.each { |p| candidates << p }
        Dir.glob("C:/Program Files (x86)/SuperCollider-*/sclang.exe").sort.reverse.each { |p| candidates << p }
      elsif RUBY_PLATFORM =~ /darwin/
        candidates << "/Applications/SuperCollider.app/Contents/MacOS/sclang"
      else
        candidates << "/usr/bin/sclang"
        candidates << "/usr/local/bin/sclang"
      end

      found = candidates.compact.find { |c| File.exist?(c) }
      found ||= on_path("sclang")
      unless found
        raise SclangNotFound, "SuperCollider's sclang was not found. Install SuperCollider, or set " \
                              "SCLANG to its path (looked at: #{(candidates.compact + ['PATH']).join(', ')})"
      end
      found
    end

    def self.on_path(name)
      exe = Gem.win_platform? ? "#{name}.exe" : name
      ENV["PATH"].to_s.split(File::PATH_SEPARATOR).each do |dir|
        candidate = File.join(dir, exe)
        return candidate if File.exist?(candidate)
      end
      nil
    end
    private_class_method :on_path

    def initialize(sclang_path = nil, logger: nil, ready_timeout: DEFAULT_READY_TIMEOUT, mode: :auto)
      @sclang_path = self.class.find_sclang(sclang_path)
      @logger = logger
      @ready_timeout = ready_timeout
      @mutex = Mutex.new
      @all_output = []
      @job_output = nil
      @stdin = @stdout = @wait_thr = @reader = nil
      # :auto -> a fresh sclang per compile on Windows (where a Ruby-started sclang does not read
      # stdin), resident elsewhere (where the web line proves stdin works).
      @mode = mode == :auto ? (Gem.win_platform? ? :per_compile : :resident) : mode
    end

    attr_reader :mode

    def start
      # Only the resident mode has anything to start; in per-compile mode each compile owns its
      # process, so there is nothing to keep alive between them.
      return self if @mode == :per_compile

      @mutex.synchronize { start_unlocked }
      self
    end

    def running?
      !@stdin.nil? && !@stdin.closed? && @wait_thr&.alive?
    end

    # Compile `source_path` and return a Result. Serialised either way: in resident mode sclang has
    # ONE stdin, so two compiles at once is not a queue to optimise but a race to refuse; in
    # per-compile mode two concurrent sclangs would just fight over the machine.
    def compile(source_path, timeout: DEFAULT_COMPILE_TIMEOUT)
      raise CompileError, "no such file: #{source_path}" unless File.exist?(source_path)

      @mutex.synchronize do
        if @mode == :per_compile
          run_job_fresh(source_path, timeout)
        else
          start_unlocked unless running?
          run_job_unlocked(source_path, timeout)
        end
      end
    end

    def stop
      @mutex.synchronize { stop_unlocked }
    end

    # Kept for callers that want to show what the interpreter said (a compile report, a log line).
    def output
      (@job_output || @all_output).join
    end

    private

    def log(msg)
      @logger&.call(msg)
    end

    def start_unlocked
      return self if running?

      @all_output = []
      # The two-element array form is deliberate: a bare string is parsed as a COMMAND LINE by Ruby,
      # and sclang's usual Windows home has a space in it ("C:/Program Files/SuperCollider-3.14.1"),
      # which turns into Errno::ENOENT on the truncated "C:/Program". This form also means no shell
      # is involved, so nothing in the path can be interpreted.
      @stdin, @stdout, @wait_thr = Open3.popen2e([@sclang_path, @sclang_path])
      @reader = Thread.new do
        begin
          @stdout.each_line do |line|
            @all_output << line
            @all_output.shift while @all_output.size > OUTPUT_LINES_KEPT
            @job_output << line if @job_output
          end
        rescue IOError
          nil
        end
      end

      t0 = Time.now
      until ready?
        raise Error, "sclang exited while starting up:\n#{@all_output.join}" unless @wait_thr.alive?
        raise Timeout, "sclang did not become ready in #{@ready_timeout}s:\n#{@all_output.join}" if Time.now - t0 > @ready_timeout
        sleep 0.01
      end
      log "sclang ready in #{((Time.now - t0) * 1000).round} ms (#{@sclang_path})"
      self
    end

    # "compile done" is what sclang prints once its class library is in place and it is listening.
    def ready?
      @all_output.any? { |l| l =~ /compile done|Welcome to SuperCollider/ }
    end

    # One compile: a wrapper file that loads the user's file, writes the defs into a directory of
    # ours, and appends a result line to a file in that same directory.
    def run_job_unlocked(source_path, timeout)
      dir = File.join(Dir.tmpdir, "sp-synthdef-#{SecureRandom.hex(6)}")
      FileUtils.mkdir_p(dir)
      result_file = File.join(dir, "result.txt")
      wrapper = File.join(dir, "job.scd")
      File.write(wrapper, wrapper_source(source_path, dir, result_file))

      @job_output = []
      t0 = Time.now
      @stdin.puts(%("#{wrapper.tr('\\', '/')}".load;))
      @stdin.flush

      ok = false
      until Time.now - t0 > timeout
        if File.exist?(result_file)
          text = File.read(result_file)
          if text.include?("OK")
            ok = true
            break
          elsif text.include?("ERROR")
            break
          end
        end
        raise CompileError, "sclang exited during the compile:\n#{job_output_text}" unless @wait_thr.alive?

        sleep 0.005
      end
      ms = ((Time.now - t0) * 1000).round
      captured = job_output_text

      unless ok
        if File.exist?(result_file)
          raise CompileError, failure_message(File.read(result_file).strip, captured)
        else
          raise Timeout, "the compile did not finish within #{timeout}s\n--- sclang said ---\n#{captured}"
        end
      end

      defs = Dir.glob(File.join(dir, "*.scsyndef")).sort.map do |path|
        definition = SynthdefParser.parse_file(path).first
        CompiledDef.new(definition.name, path, definition)
      end
      raise CompileError, "the compile reported success but wrote no synthdef into #{dir}" if defs.empty?

      Result.new(defs, captured, ms, dir)
    end

    def job_output_text(limit = 40)
      (@job_output || @all_output).last(limit).join
    end

    # What the user should read first. When a file has a SYNTAX error, sclang's loader returns nil
    # rather than raising, so the wrapper's own report is the unhelpful "did not return a SynthDef
    # (got Nil)" - while the interpreter's real message sits in the captured output. Putting the
    # interpreter's line first is the difference between a report that can be acted on and one that
    # sends the reader looking in the wrong place.
    def failure_message(report, captured)
      said = captured.to_s.lines.select { |l| l =~ /ERROR|error:|syntax error|unexpected/i }
      return "#{report}\n--- sclang said ---\n#{captured}" if said.empty?

      "#{said.first.strip}\n(#{report})\n--- sclang said ---\n#{captured}"
    end

    # One compile in per-compile mode: a fresh sclang, the wrapper as a FILE ARGUMENT (the channel
    # that works regardless of how the process is started), and the script ends the interpreter.
    def run_job_fresh(source_path, timeout)
      dir = File.join(Dir.tmpdir, "sp-synthdef-#{SecureRandom.hex(6)}")
      FileUtils.mkdir_p(dir)
      result_file = File.join(dir, "result.txt")
      wrapper = File.join(dir, "job.scd")
      File.write(wrapper, wrapper_source(source_path, dir, result_file, exit_after: true))

      @job_output = []
      t0 = Time.now
      stdin, stdout, wait = Open3.popen2e(@sclang_path, wrapper)
      reader = Thread.new do
        begin
          stdout.each_line do |line|
            @job_output << line
            @job_output.shift while @job_output.size > OUTPUT_LINES_KEPT
          end
        rescue IOError
          nil
        end
      end

      ok = false
      until Time.now - t0 > timeout
        if File.exist?(result_file)
          text = File.read(result_file)
          if text.include?("OK")
            ok = true
            break
          elsif text.include?("ERROR")
            break
          end
        end
        break unless wait.alive?

        sleep 0.005
      end

      # Let it finish on its own (the wrapper ends with 0.exit); only kill if it overstays.
      unless wait.join(10)
        begin
          Process.kill("KILL", wait.pid)
        rescue StandardError
          nil
        end
        wait.join(5)
      end
      reader.kill
      begin
        stdin.close
      rescue StandardError
        nil
      end
      ms = ((Time.now - t0) * 1000).round
      captured = job_output_text

      unless ok
        if File.exist?(result_file)
          raise CompileError, failure_message(File.read(result_file).strip, captured)
        else
          raise Timeout, "the compile did not finish within #{timeout}s\n--- sclang said ---\n#{captured}"
        end
      end

      defs = Dir.glob(File.join(dir, "*.scsyndef")).sort.map do |path|
        definition = SynthdefParser.parse_file(path).first
        CompiledDef.new(definition.name, path, definition)
      end
      raise CompileError, "the compile reported success but wrote no synthdef into #{dir}" if defs.empty?

      Result.new(defs, captured, ms, dir)
    end

    # The SuperCollider side of the protocol. Notes on why it looks like this:
    #   * `var` declarations come first in a block (SuperCollider requires it);
    #   * the VALUE of the loaded file is what gets written, so a user's file is a plain expression
    #     returning a SynthDef - they never have to know a path;
    #   * every failure becomes an ERROR line carrying the interpreter's own message, because sclang
    #     does NOT raise for a file's syntax error - it only prints.
    def wrapper_source(source_path, out_dir, result_file, exit_after: false)
      user = source_path.tr("\\", "/")
      out  = out_dir.tr("\\", "/")
      res  = result_file.tr("\\", "/")
      text = <<~SC
        (
        var userFile = "#{user}";
        var outDir = "#{out}";
        var resultFile = "#{res}";
        var written = 0;
        var problem = nil;
        try {
            var value = userFile.load;
            var defs = if (value.isKindOf(Array)) { value } { [value] };
            defs.do { |d|
                if (d.isKindOf(SynthDef)) {
                    d.writeDefFile(outDir);
                    written = written + 1;
                } {
                    problem = "the file did not return a SynthDef (got " ++ d.class.asString ++ ")";
                };
            };
            if ((written == 0) && problem.isNil) { problem = "the file returned no SynthDef" };
        } { |err|
            problem = err.errorString;
        };
        File.use(resultFile, "a", { |f|
            if (problem.isNil) { f.write("OK " ++ written ++ "\\n") } { f.write("ERROR " ++ problem ++ "\\n") };
        });
        #{exit_after ? '0.exit;' : ''}
        )
      SC
      text
    end

    def stop_unlocked
      return unless @stdin
      begin
        @stdin.puts("0.exit;")
        @stdin.flush
      rescue IOError, Errno::EPIPE
        nil
      end
      if @wait_thr
        unless @wait_thr.join(15)
          begin
            Process.kill("KILL", @wait_thr.pid)
          rescue StandardError
            nil
          end
          @wait_thr.join(5)
        end
      end
      @reader&.kill
      begin
        @stdin.close
      rescue StandardError
        nil
      end
      begin
        @stdout.close
      rescue StandardError
        nil
      end
      @stdin = @stdout = @wait_thr = @reader = nil
    end
  end
end
