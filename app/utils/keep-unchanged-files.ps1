# ============================================================================
#  keep-unchanged-files.ps1
#
#  Snapshot a directory, let a generator overwrite it, then restore the
#  modification time of every file whose CONTENT did not actually change.
#
#  Why this exists
#  ---------------
#  qt-doc.rb (app/server/ruby/bin/qt-doc.rb) writes its outputs unconditionally
#  with File.open(..., 'w'): it never checks whether anything changed. This
#  build's step 25-27 also does `copy /Y ruby_help.tmpl ruby_help.h` the same
#  way.
#
#  The contents are stable, but the timestamps are not. So every build touches
#  app/gui/utils/ruby_help.h - all 1.1 MB of it - which makes MSBuild treat it as
#  changed and recompile every translation unit that includes it, mainwindow.cpp
#  included. Measured: a build with NO source changes took 220s, of which ~130s
#  was the compiler rebuilding 10 files for nothing and ~76s was the generation
#  steps themselves.
#
#  Restoring the timestamp when the bytes are identical keeps the dependency
#  graph honest: a generated file only looks newer when it really is different.
#
#  Deliberately compares content rather than skipping generation outright. The
#  inputs are many Ruby files plus the tutorial markdown, and working out cheaply
#  whether all of them are older than the outputs is more fragile than just
#  generating and looking at the result.
#
#  Usage:
#     keep-unchanged-files.ps1 -Snapshot <liveDir> -Store <snapshotDir>
#     ... run the generator ...
#     keep-unchanged-files.ps1 -Restore  <liveDir> -Store <snapshotDir>
#
#  Deleting the snapshot afterwards is the caller's business (the .bat does it
#  with rmdir). The script is intentionally dependency-free and safe to run when
#  the snapshot is missing: it then reports and does nothing.
# ============================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Snapshot', 'Restore')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$LiveDir,
    [Parameter(Mandatory = $true)][string]$Store
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $LiveDir)) {
    Write-Host "keep-unchanged-files: $LiveDir does not exist; nothing to do"
    exit 0
}

# Only files whose mtime can affect the C++ build are worth preserving. The
# generated tutorial/reference JSON under gui/utils/generated is consumed at
# runtime by the docs pane and is not a compilation input, so it is left alone -
# rewriting it costs nothing in build time.
$extensions = @('.h', '.hpp', '.inc')

function Get-TrackedFiles([string]$root) {
    Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $extensions -contains $_.Extension.ToLower() }
}

if ($Mode -eq 'Snapshot') {
    if (Test-Path -LiteralPath $Store) { Remove-Item -LiteralPath $Store -Recurse -Force }
    New-Item -ItemType Directory -Path $Store -Force | Out-Null

    $files = Get-TrackedFiles $LiveDir
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($LiveDir.Length).TrimStart('\', '/')
        $dst = Join-Path $Store $rel
        New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
        Copy-Item -LiteralPath $f.FullName -Destination $dst -Force
    }
    Write-Host "keep-unchanged-files: snapshotted $($files.Count) file(s) from $LiveDir"
    exit 0
}

# Restore
if (-not (Test-Path -LiteralPath $Store)) {
    Write-Host "keep-unchanged-files: no snapshot at $Store; leaving timestamps alone"
    exit 0
}

$unchanged = 0
$changed = 0
foreach ($old in (Get-ChildItem -LiteralPath $Store -Recurse -File)) {
    $rel = $old.FullName.Substring($Store.Length).TrimStart('\', '/')
    $live = Join-Path $LiveDir $rel

    if (-not (Test-Path -LiteralPath $live)) { continue }   # generator removed it

    # -Raw so a one-byte difference anywhere is caught; byte-for-byte would need
    # care with encodings that Get-Content -Raw already handles consistently for
    # both sides.
    $same = (Get-Content -LiteralPath $old.FullName -Raw) -ceq (Get-Content -LiteralPath $live -Raw)

    if ($same) {
        # Put the ORIGINAL timestamp back, so dependents see no change.
        (Get-Item -LiteralPath $live).LastWriteTimeUtc = $old.LastWriteTimeUtc
        ++$unchanged
    } else {
        ++$changed
    }
}

Write-Host "keep-unchanged-files: $unchanged unchanged (timestamps restored), $changed changed"
exit 0
