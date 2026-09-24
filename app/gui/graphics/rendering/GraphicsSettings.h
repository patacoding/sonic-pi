//--
// This file is part of Sonic Pi: http://sonic-pi.net
// Full project source: https://github.com/sonic-pi-net/sonic-pi
// License: https://github.com/sonic-pi-net/sonic-pi/blob/main/LICENSE.md
//
// Copyright 2026 by Sam Aaron (http://sam.aaron.name).
// All rights reserved.
//
// Permission is granted for use, copying, modification, and
// distribution of modified versions of this work as long as this
// notice is included.
//++

#pragma once

#include <QSize>
#include <QString>
#include <QStringList>

namespace SonicPi
{

// Graphics' own settings, in its own file.
//
// Deliberately NOT stored in the GUI's v5-gui-settings.ini. Graphics is an
// optional feature built on top of this application rather than part of it, and
// keeping its keys in the product's settings file has three problems: the product
// file accumulates entries for a feature a given user may never enable; removing
// or reworking the feature leaves orphaned keys behind in everyone's config; and
// the feature's settings then cannot be read or written without the GUI's
// settings object, which is exactly the coupling the render side is built to
// avoid.
//
// The file lives beside the log this module's sibling writes, under
// <home>/.sonic-pi/config/graphics.ini, resolved the same way GraphicsLog resolves
// its directory: $SONIC_PI_HOME, else %USERPROFILE%, then the platform home. That
// keeps the whole feature self-contained under one directory.
//
// Every getter takes a default, so a missing file, a missing key or an unparsable
// value all behave the same way and no caller has to check whether the file
// exists yet.
namespace GraphicsSettings
{

// Used when no output size is configured. Kept here rather than in the render
// thread so the default is stated once, next to the key that overrides it.
static constexpr int kDefaultOutputWidth = 1280;
static constexpr int kDefaultOutputHeight = 720;

// Absolute path of the settings file, whether or not it exists.
QString filePath();

// The resolution the shader is rendered at, in pixels, and the resolution any
// external consumer (Spout, recording) receives.
//
// This is a property of the *output*, set by the user, and deliberately
// independent of the output window: the window is a viewer that crops this image,
// so resizing or moving the window changes neither what is rendered nor what an
// external consumer is sent. An output whose resolution followed the window could
// be changed by dragging a window, which is a strange way to change a broadcast
// format.
//
// Defaults to 1280x720 when unset: large enough to show detail, small enough not
// to waste memory, and not an invented guess at the user's display size.
QSize outputSize();

// Frame rate ceiling in Hz. Zero means "no explicit preference", which callers
// interpret as their own default rather than as "unlimited" - an unlimited
// renderer competing with the audio engine is not a safe default.
int frameCapHz();

// Whether the graphics output window should be open. Restored at startup.
bool showOutput();

void setOutputSize(const QSize& size);
void setFrameCapHz(int hz);
void setShowOutput(bool show);

// Safety ceilings, and the parsing for values typed by hand.
//
// Not limits on what is reasonable - the user decides that, and a number that comes from a
// projector's spec sheet is not the program's business to second-guess. They exist so a slipped
// digit (38400x2160) is caught before it reaches the driver. 16384 is the widest texture modern
// GPUs offer; 500Hz is beyond any display and any plausible external consumer.
//
// If a real need exceeds either, the value is what should change rather than the check.
constexpr int kMaxOutputDimension = 16384;
constexpr int kMaxFrameRateHz = 500;

// Parse "3840x2160", "3840 x 2160", "3840X2160", "3840*2160" or a bare "3840" (taken as width
// and height, since a square output is occasionally wanted and refusing it would be an opinion).
// Returns false when the text is not a pair of positive integers, or when either exceeds
// kMaxOutputDimension.
//
// A free function taking a string, so the accept/reject rule is testable without opening a
// dialog - which is the only way this rule gets checked, since a modal dialog cannot be driven
// from an automated run.
bool parseOutputSize(const QString& text, QSize* sizeOut);

// Parse a frame rate as a single positive integer, at most kMaxFrameRateHz.
bool parseFrameRateHz(const QString& text, int* hzOut);

// Where the editable shaders live, and how a missing one is produced.
//
// These were private to GraphicsRenderer, which was fine while only the renderer cared. A shader
// editor makes the path a SHARED fact: the editor writes the file and the renderer reads it, and if
// the two ever resolved it differently the editor would be editing a file nobody renders - which
// would look exactly like "my changes do nothing". So the path has one owner, here, beside the
// settings that already belong to this feature.
QString shaderDirectoryPath();

// ---------------------------------------------------------------------------------------------
// The buffer's NAME, which is its identity.
//
// A buffer is its file, so the name is the file's stem: "default" is default.frag. That is what makes
// the name worth carrying around instead of the path - `graphics/buffer/default/uniform` says which
// buffer in a way a path never would - and it keeps one question from becoming two: "which buffer am
// I editing" and "which file is on disk" have the same answer by construction.
//
// The name travels: main() reads the configured one, the render thread holds what is actually being
// rendered, the renderer compiles it, and the editor opens it. This module owns the name-to-file rule
// because it already owns the paths; a rule resolved in two places is the failure described above.
// ---------------------------------------------------------------------------------------------

// The name of the buffer a fresh session renders. With one buffer this is the whole story; when there
// are several, the stored choice replaces it (graphics-multi-buffer-plan.md, M2/M3).
inline QString defaultShaderName()
{
    return QStringLiteral("default");
}

// "default" -> "default.frag". The one place the extension is applied, so a name and its file cannot
// disagree.
QString fragmentFileName(const QString& shaderName);

// The buffer to render: the one the user last switched to, or the default when there is no choice yet.
//
// Stored rather than derived, because "which picture do I come back to" is the user's decision and not
// something to guess from the directory. Nothing here validates the name - a name whose file does not
// exist is a real state (a buffer whose file was deleted, a config edited by hand), and the renderer
// reports it in the buffer's own words rather than this function silently substituting another.
QString activeShaderName();

// Remember the buffer the user switched to, so the next session starts on it.
void setActiveShaderName(const QString& shaderName);

// Every buffer in the shader directory: its top-level *.frag files, as names, sorted.
//
// THE DIRECTORY IS THE LIST. There is no index table, no registry and no fixed count - a buffer is a
// file, whether the user made it in the editor or put it there by hand, and subdirectories (lib/ and
// friends) are libraries rather than buffers. That is the whole rule, which is why this is a directory
// read rather than a stored list that could disagree with what is on disk.
QStringList shaderNames();

// The file to READ for a given role. The user's copy when it exists, otherwise the shipped copy, and
// an empty string when neither is present.
QString shaderPath(const QString& fileName);

// The path the EDITOR should write to, whether or not the file exists yet: always the user's copy,
// never the shipped one. Writing into the source tree is not something this feature does.
QString writableShaderPath(const QString& fileName);

// Make sure the editor has something to open: when the user's copy is missing, copy the shipped one
// into place. Returns the writable path, or an empty string when there is no shipped copy to seed
// from.
//
// Called at startup rather than on first use, so that "the file I am editing" exists before anything
// asks for it and cannot be raced into existence twice.
QString ensureShaderFile(const QString& fileName);

} // namespace GraphicsSettings
} // namespace SonicPi
