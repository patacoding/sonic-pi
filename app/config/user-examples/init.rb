# Sonic Pi init file
# Code in here will be evaluated on launch.


# --- pampa pattern extension ---
# The timing-semantics extension: one track per consumer line, riding Link's beat.
# The path is resolved through SonicPi::Paths, so it works wherever it is installed.
begin
  _pampa_ext = File.join(SonicPi::Paths.app_path, 'server', 'ruby', 'lib', 'sonicpi', 'extensions', 'pattern', 'async.rb')
  require _pampa_ext if File.exist?(_pampa_ext)
rescue StandardError => e
  STDERR.puts "[init] pampa pattern extension not loaded: #{e.class}: #{e.message}"
end
