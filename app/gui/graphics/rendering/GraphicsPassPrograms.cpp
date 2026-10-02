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

#include "GraphicsPassPrograms.h"

#include <QDir>
#include <QFile>

#include "GraphicsLog.h"
#include "GraphicsSettings.h"

namespace SonicPi
{

GraphicsPassPrograms::~GraphicsPassPrograms() = default;

bool GraphicsPassPrograms::create(const GraphicsDocument& document, const QString& vertexFile)
{
    (void)vertexFile;   // the renderer owns its vertex half (passthrough.vert); named here for the caller's sake

    destroy();

    if (!document.isValid()) {
        GraphicsLog::error(QStringLiteral("pass programs: no document to compile"));
        return false;
    }

    // Common is text, not a pass: read once, hand the same text to every pass. Absent is empty and is not
    // an error - a document need not have one. The path is the WRITER's rule, so a single-pass .frag's
    // Common is its own sidecar file rather than a shared "common.glsl" beside it.
    m_commonText.clear();
    m_commonFile.clear();
    {
        const QString commonFile = graphicsDocumentPassFilePath(document, GraphicsPass::Common);
        if (!commonFile.isEmpty() && QFileInfo::exists(commonFile)) {
            m_commonFile = commonFile;
            QFile common(commonFile);
            if (common.open(QIODevice::ReadOnly))
                m_commonText = QString::fromUtf8(common.readAll());
            else
                GraphicsLog::error(QStringLiteral("pass programs: document '%1' has a Common that cannot be "
                                                  "read (%2); compiling the passes without it")
                                       .arg(document.name, common.errorString()));
        }
    }

    // One renderer per pass that HAS TEXT. A pass with no file is an empty pass: no renderer, nothing drawn,
    // and sampling it is black - the rule the web renderer settled on - so a document with only an Image is
    // perfectly valid. This is why the existence test is here and not in the path rule above: a plain .frag
    // is a document whose Image is its own file and whose four buffers do not exist until somebody writes
    // them, and "does it exist" is exactly the question a compile has to ask.
    for (int i = 0; i < kDrawOrderCount; ++i) {
        const GraphicsPass pass = kDrawOrder[i];
        const QString file = graphicsDocumentPassFilePath(document, pass);
        if (file.isEmpty() || !QFileInfo::exists(file))
            continue;

        auto renderer = std::make_unique<GraphicsRenderer>();
        // Named before compiling, because the name is what the log lines and the compile result carry: a
        // picture showing the wrong pass has to be attributable to a pass.
        renderer->setShaderName(document.name + QLatin1Char('/') + graphicsPassName(pass));

        if (!renderer->prepare()) {
            GraphicsLog::error(QStringLiteral("pass programs: %1 could not prepare its geometry; "
                                              "it stays an empty pass")
                                   .arg(graphicsPassLabel(pass)));
            continue;
        }

        // The entry point multi-pass needed, which turned out to exist already (GraphicsRenderer.cpp:251):
        // explicit file, document's Common, and a failure that keeps the previous program - which is what
        // gives each pass its own protection rather than one bad pass taking the frame down.
        // A NAME, not the absolute path: buildProgram() reaches the file through
        // GraphicsSettings::shaderPath(name), which looks in the user shader directory and then in the
        // shipped copy. Measured - handing it an absolute path produced "Shader file not found" for a
        // file that was plainly on disk (1236 bytes).
        const QString name = QDir(GraphicsSettings::shaderDirectoryPath()).relativeFilePath(file);
        const GraphicsCompileResult result = renderer->buildAndInstallFrom(name, m_commonText, m_commonFile);
        if (!result.ok() && !result.installed) {
            GraphicsLog::error(QStringLiteral("pass programs: %1 did not build from %2; it stays an empty "
                                              "pass. %3")
                                   .arg(graphicsPassLabel(pass), file, result.log.trimmed()));
            continue;
        }

        m_passes[i] = std::move(renderer);
    }

    GraphicsLog::info(describe());
    return passCount() > 0;
}

void GraphicsPassPrograms::destroy()
{
    for (auto& renderer : m_passes)
        renderer.reset();
    m_commonText.clear();
}

bool GraphicsPassPrograms::isValid() const
{
    return passCount() > 0;
}

GraphicsRenderer* GraphicsPassPrograms::pass(GraphicsPass pass) const
{
    const int index = graphicsPassDrawIndex(pass);
    if (index < 0)
        return nullptr;   // Common: text, not a pass
    return m_passes[index].get();
}

int GraphicsPassPrograms::passCount() const
{
    int count = 0;
    for (const auto& renderer : m_passes) {
        if (renderer && renderer->hasProgram())
            ++count;
    }
    return count;
}

QString GraphicsPassPrograms::describe() const
{
    QStringList parts;
    for (int i = 0; i < kDrawOrderCount; ++i) {
        const GraphicsPass pass = kDrawOrder[i];
        const GraphicsRenderer* renderer = m_passes[i].get();
        if (!renderer)
            parts << QStringLiteral("%1=empty").arg(graphicsPassLabel(pass));
        else
            parts << QStringLiteral("%1=%2").arg(graphicsPassLabel(pass),
                                                 renderer->fragmentShaderPath());
    }
    return QStringLiteral("pass programs: %1 of %2 compiled, common %3 bytes: %4")
        .arg(passCount())
        .arg(kDrawOrderCount)
        .arg(m_commonText.size())
        .arg(parts.join(QStringLiteral(", ")));
}

} // namespace SonicPi
