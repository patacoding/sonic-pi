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

#include <QOpenGLFramebufferObject>
#include <QSize>

#include <memory>

namespace SonicPi
{

// An offscreen render target: a framebuffer and its size. Nothing else.
//
// Separate from GraphicsRenderer on purpose, and the reason is a correctness one
// rather than tidiness. Double buffering needs TWO targets, and if a target were
// still bundled with the shader program then two targets would mean two programs -
// which is two copies of a program, two sets of uniform locations, and a shader
// reload that has to compile twice and can half-succeed. That is precisely the
// family of bug that has already cost real time three times in this feature: state
// that should exist once, existing in two places that drift.
//
// So: one program, one set of locations, N targets.
//
// Owned by, and only ever touched from, the thread that holds the GL context it was
// created against.
class GraphicsTarget
{
public:
    GraphicsTarget() = default;
    // Defined in the .cpp: the framebuffer needs a current context to destroy, and
    // unique_ptr's deleter needs the complete type here.
    ~GraphicsTarget();

    GraphicsTarget(const GraphicsTarget&) = delete;
    GraphicsTarget& operator=(const GraphicsTarget&) = delete;

    // Creates the framebuffer. Requires a current context. Returns false and logs
    // why on failure, leaving the object empty.
    bool create(const QSize& size);

    // Releases the framebuffer now, while the caller can still make the owning
    // context current. Optional - the destructor does the same - but a caller
    // tearing down a context should not rely on member destruction order.
    void destroy();

    bool isValid() const { return m_fbo && m_fbo->isValid(); }
    bool isBound() const { return m_fbo && m_fbo->isBound(); }

    QSize size() const { return m_size; }

    // The colour attachment as a GL texture name, for a consumer in the same share
    // group to sample. Zero when there is no framebuffer.
    //
    // Deliberately decoupled from size(): Qt reallocates a framebuffer's storage on
    // resize but keeps the texture name, so a consumer has to watch the SIZE for
    // correctness while only needing to rebuild its own state when the NAME changes.
    GLuint texture() const { return m_fbo ? m_fbo->texture() : 0; }

    // Make this the current draw target. Pair with release().
    void bind() { if (m_fbo) m_fbo->bind(); }
    void release() { if (m_fbo) m_fbo->release(); }

private:
    std::unique_ptr<QOpenGLFramebufferObject> m_fbo;
    QSize m_size;
};

} // namespace SonicPi
