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

#include <QString>

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

// Absolute path of the settings file, whether or not it exists.
QString filePath();

// Frame rate ceiling in Hz. Zero means "no explicit preference", which callers
// interpret as their own default rather than as "unlimited" - an unlimited
// renderer competing with the audio engine is not a safe default.
int frameCapHz();

// Whether the graphics output window should be open. Restored at startup.
bool showOutput();

void setFrameCapHz(int hz);
void setShowOutput(bool show);

} // namespace GraphicsSettings
} // namespace SonicPi
