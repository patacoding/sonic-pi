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

module SonicPi
  # What a compiled SynthDef (.scsyndef) says about itself: its name, and its controls with their
  # default values. Read here so that a synth the user has just compiled can be described to the
  # language and the GUI WITHOUT SuperCollider being present, and without regenerating anything.
  #
  # The algorithm is a port of the web runtime's parseSynthdefControls (app/web/web/runtime.js),
  # which is the same reader upstream already ships for the browser; the file format itself is
  # documented at docs.supercollider.online/Reference/Synth-Definition-File-Format.html.
  #
  # The format details that matter, each verified against Sonic Pi's own compiled defs:
  #
  #  * everything is big endian;
  #  * "SCgf", then an int32 FORMAT VERSION, then an int16 NUMBER OF DEFINITIONS;
  #  * versions 1 and 2 differ in the WIDTH of the counts (int16 vs int32) - Sonic Pi's own
  #    defs contain both (sonic-pi-fm is version 1, sonic-pi-beep is version 2), and its engine
  #    accepts both, so this reader must handle both and REPORT the version it saw;
  #  * a control's default is the value at its index in the def's parameter list;
  #  * a file may hold more than one definition, so they are all read.
  #
  # It deliberately does NOT read the ugen graph: control names and defaults are what the language
  # side needs to accept and validate a synth, and the graph is the engine's business.
  module SynthdefParser
    class Error < StandardError; end

    Control = Struct.new(:name, :index, :default)
    Definition = Struct.new(:name, :controls, :format_version) do
      def control_names
        controls.map(&:name)
      end
    end

    MAGIC = "SCgf".freeze
    SUPPORTED_VERSIONS = [1, 2].freeze

    def self.parse_file(path)
      parse(File.binread(path), path)
    end

    # Returns an Array of Definition. Raises Error with the source named in the message, because a
    # caller that has just compiled something needs to know WHICH file was unreadable and WHY.
    def self.parse(bytes, source = "(bytes)")
      raise Error, "#{source}: too short to be a synthdef (#{bytes.bytesize} bytes)" if bytes.bytesize < 10
      unless bytes.byteslice(0, 4) == MAGIC
        raise Error, "#{source}: not a synthdef (magic #{bytes.byteslice(0, 4).inspect}, expected #{MAGIC.inspect})"
      end

      version = read_int32(bytes, 4, source)
      unless SUPPORTED_VERSIONS.include?(version)
        raise Error, "#{source}: synthdef format version #{version}; Sonic Pi's engine accepts #{SUPPORTED_VERSIONS.join(' and ')}"
      end

      count = read_int16(bytes, 8, source)
      pos = 10
      defs = []

      count.times do
        name, pos = read_pstring(bytes, pos, source)

        n_consts = read_count(bytes, pos, version, source)
        pos += count_width(version)
        pos = skip(bytes, pos, 4 * n_consts, source)

        n_params = read_count(bytes, pos, version, source)
        pos += count_width(version)
        values = []
        n_params.times do
          values << read_float32(bytes, pos, source)
          pos += 4
        end

        n_names = read_count(bytes, pos, version, source)
        pos += count_width(version)
        controls = []
        n_names.times do
          cname, pos = read_pstring(bytes, pos, source)
          index = read_count(bytes, pos, version, source)
          pos += count_width(version)
          controls << Control.new(cname, index, values[index])
        end

        defs << Definition.new(name, controls, version)
      end

      defs
    end

    # --- readers -------------------------------------------------------------------------------

    def self.count_width(version)
      version >= 2 ? 4 : 2
    end

    def self.read_count(bytes, pos, version, source)
      version >= 2 ? read_int32(bytes, pos, source) : read_int16(bytes, pos, source)
    end

    def self.need(bytes, pos, n, source)
      if pos + n > bytes.bytesize
        raise Error, "#{source}: truncated - wanted #{n} more byte(s) at offset #{pos} of #{bytes.bytesize}"
      end
    end

    def self.skip(bytes, pos, n, source)
      need(bytes, pos, n, source)
      pos + n
    end

    def self.read_int32(bytes, pos, source)
      need(bytes, pos, 4, source)
      bytes.byteslice(pos, 4).unpack1("l>")
    end

    def self.read_int16(bytes, pos, source)
      need(bytes, pos, 2, source)
      bytes.byteslice(pos, 2).unpack1("s>")
    end

    def self.read_uint8(bytes, pos, source)
      need(bytes, pos, 1, source)
      bytes.byteslice(pos, 1).unpack1("C")
    end

    def self.read_float32(bytes, pos, source)
      need(bytes, pos, 4, source)
      bytes.byteslice(pos, 4).unpack1("g")
    end

    def self.read_pstring(bytes, pos, source)
      len = read_uint8(bytes, pos, source)
      need(bytes, pos + 1, len, source)
      [bytes.byteslice(pos + 1, len).force_encoding(Encoding::UTF_8), pos + 1 + len]
    end
  end
end
