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

#include "GraphicsTarget.h"
#include "GraphicsLog.h"

#include <QOpenGLContext>

namespace SonicPi
{

GraphicsTarget::~GraphicsTarget()
{
    // Contract, not an assertion: a GraphicsTarget must be destroyed while its
    // context is current, because QOpenGLFramebufferObject needs one to free the
    // texture and renderbuffers it owns.
    destroy();
}

void GraphicsTarget::destroy()
{
    m_fbo.reset();
    m_size = QSize();
}

bool GraphicsTarget::create(const QSize& size)
{
    if (!QOpenGLContext::currentContext())
    {
        GraphicsLog::error(QStringLiteral("target: no current context at create"));
        return false;
    }
    if (!size.isValid() || size.isEmpty())
    {
        GraphicsLog::error(QStringLiteral("target: refusing a %1x%2 framebuffer")
                               .arg(size.width())
                               .arg(size.height()));
        return false;
    }

    // Recreating from scratch rather than resizing: the texture name is what
    // consumers hold, so a target that keeps its identity across a size change is
    // only worth having if something relies on that, and nothing does yet.
    m_fbo.reset();

    QOpenGLFramebufferObjectFormat fmt;
    fmt.setAttachment(QOpenGLFramebufferObject::CombinedDepthStencil);
    // A plain 2D colour texture, not multisampled: this attachment is the texture
    // another context samples, and a multisampled attachment would need a resolve
    // blit before anything could read it.
    fmt.setSamples(0);

    m_fbo = std::make_unique<QOpenGLFramebufferObject>(size, fmt);
    if (!m_fbo->isValid())
    {
        GraphicsLog::error(QStringLiteral("target: %1x%2 framebuffer is not valid")
                               .arg(size.width())
                               .arg(size.height()));
        m_fbo.reset();
        return false;
    }

    m_size = size;
    GraphicsLog::info(QStringLiteral("target: created %1x%2, texture id %3")
                          .arg(size.width())
                          .arg(size.height())
                          .arg(m_fbo->texture()));
    return true;
}

} // namespace SonicPi
