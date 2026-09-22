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

#include <QOpenGLFunctions>
// Included rather than forward-declared: these are members held by unique_ptr,
// and every translation unit that destroys a GraphicsRenderer needs the complete
// types to instantiate the deleter. Forward-declaring them only buys a compile
// error later.
#include <QOpenGLBuffer>
#include <QOpenGLFramebufferObject>
#include <QOpenGLShaderProgram>
#include <QOpenGLVertexArrayObject>
#include <QRect>
#include <QSize>
#include <QString>

#include <memory>

#include "GraphicsFrame.h"

namespace SonicPi
{

// Draws into an offscreen framebuffer.
//
// Owned by, and only ever touched from, whichever thread holds the GL context it
// was created against.
//
// Phase 0 is narrow on purpose: prove a frame can be rendered and that its
// pixels come back exactly as expected. The readback checks exist because
// offscreen rendering has nothing to look at - "it ran without crashing" is not
// evidence that anything correct was drawn. The design document specified no
// such check.
//
// Shaders are loaded from files on disk rather than compiled in, so they can be
// edited and reloaded without a rebuild. Where they come from is reported in
// graphics.log at startup.
class GraphicsRenderer
{
public:
    GraphicsRenderer() = default;
    // Defined in the .cpp: members here are only forward-declared, and
    // unique_ptr's deleter needs the complete types.
    ~GraphicsRenderer();

    GraphicsRenderer(const GraphicsRenderer&) = delete;
    GraphicsRenderer& operator=(const GraphicsRenderer&) = delete;

    // Creates the framebuffer and loads the shaders. Requires a current context.
    // Returns false and logs why on failure.
    bool initialize(const QSize& size);

    // Loads the shaders with no framebuffer. Requires a current context.
    //
    // For a caller that draws the shader straight to a surface it owns - the
    // output window - rather than through an intermediate framebuffer. Use
    // initialize() when the frame has to land in a framebuffer first, such as when
    // it will be read back or shared with another context.
    bool initializeWithoutFramebuffer();

    // Draws one frame into the framebuffer with the current shader.
    //
    // `frame` carries the uniform values; see GraphicsFrame for why they are
    // passed in rather than read from a clock here.
    bool render(const GraphicsFrame& frame);

    // Draws one frame with the current shader into whichever framebuffer is
    // already bound, leaving the binding alone.
    //
    // `passSize` is the coordinate space the shader draws in: the viewport is set
    // to `destinationRect` inside it. They differ when only part of the output is
    // being shown - the output window shows a crop of the render target, so the
    // shader's geometry is sized for the whole target while the viewport covers
    // just the visible part.
    //
    // Setting `destinationRect` smaller than `passSize` therefore crops rather
    // than scales, which is the intent: the output is a fixed resolution and the
    // window is a 1:1 viewer of it, so a window smaller than the output reveals
    // less of the image rather than shrinking it.
    //
    // Clears to the documented background colour first.
    bool renderToBoundFramebuffer(const QSize& passSize, const QRect& destinationRect,
                                  const GraphicsFrame& frame);

    // Release the GL objects now, while the caller can still make the owning
    // context current. Calling this is optional - the destructor does the same -
    // but a window being torn down cannot rely on its context surviving into
    // member destruction, so it calls this first.
    void destroy();

    // Reads the framebuffer back and compares anchor points against the quadrant
    // test pattern in anchors.frag. Returns false if the pixels differ.
    //
    // The check uses its own shader rather than whatever default.frag currently
    // draws. Coupling the two would mean a legitimate edit to the default shader
    // broke the pipeline's self-test, and the anchors would have to be kept in a
    // synthetic image that ships as the default.
    bool verifyShaderOutput();

    // Re-read the shader files and recompile. On failure the previously working
    // program is kept and the compiler log is reported, so a bad edit does not
    // take the picture away - design document principle 6.
    //
    // Must be called on the thread that owns the context, with that context current.
    // That is not a formality: the shader program belongs to the context it is used
    // with, so compiling it anywhere else either fails or produces a program this
    // renderer cannot use. The render thread calls this from its own loop; the GUI
    // asks the render thread instead of doing it itself.
    bool reloadShaders();

    // There is deliberately no static "reload every renderer" entry point.
    //
    // One used to exist so a GUI action could recompile every live renderer. It
    // could not work: a shader program belongs to a context, a context belongs to a
    // thread, and the GUI thread can only make its own context current - so it
    // compiled against the wrong one and raced the render loop. The GUI now only
    // requests a reload and the render thread applies it, on its own context.
    //
    // Reads the whole framebuffer back as RGBA8. Returns false on failure.
    //
    // Note: OpenGL's origin is bottom-left, so row 0 of the returned data is the
    // *bottom* row of the image. verifyShaderOutput depends on that, which is
    // why it reads deliberately rather than by habit.
    bool readPixels(QSize* sizeOut, std::unique_ptr<unsigned char[]>* pixelsOut);

    QSize size() const { return m_size; }

    // The colour attachment of the framebuffer, as a GL texture name.
    //
    // Deliberately decoupled from size(): resizing a framebuffer in Qt keeps the
    // texture name and only reallocates its storage, so a consumer that displays
    // this texture has to watch the SIZE for correctness but only needs to rebuild
    // its own state when the NAME changes. Conflating the two would make every
    // crop change look like a new texture and force needless rebuilding.
    //
    // Shared across contexts: another context in the same share group can sample
    // this texture directly, which is what lets the output window display the
    // render thread's framebuffer instead of drawing its own copy. Zero when there
    // is no framebuffer.
    GLuint framebufferTexture() const { return m_fbo ? m_fbo->texture() : 0; }

    // Where the fragment shader was loaded from, so it can be reported to the
    // user (and so they know which copy to edit).
    QString fragmentShaderPath() const { return m_fragmentPath; }
    QString vertexShaderPath() const { return m_vertexPath; }

    // The colour the framebuffer is cleared to before drawing, and the colour
    // used when there is no usable shader. Kept as named constants so the clear
    // and any check against it cannot drift apart.
    static constexpr float kClearR = 0.25f;
    static constexpr float kClearG = 0.50f;
    static constexpr float kClearB = 0.75f;
    static constexpr float kClearA = 1.0f;

private:
    // The VAO and the quad's vertex buffer, both required before any draw.
    bool createQuadGeometry();

    // Compile a vertex/fragment pair from disk into a linked program. Returns
    // nullptr and logs the compiler output on any failure.
    std::unique_ptr<QOpenGLShaderProgram> buildProgram(const QString& vertexFile,
                                                       const QString& fragmentFile);

    // Load the default shader pair into m_program. Leaves m_program untouched on
    // failure.
    bool loadShaders();

    // The writable per-user shader directory, and the fallback in the source
    // tree. Returns an empty string if neither contains the file.
    QString resolveShaderPath(const QString& fileName) const;

    // Look up the uniform locations this renderer feeds, and remember which ones
    // the current program actually declares.
    //
    // Called once per successful link rather than per frame: glGetUniformLocation
    // is a string lookup into the program and is not something to do 60+ times a
    // second. Safe to call again after a reload - the locations belong to the
    // program that was current when they were queried, so they must be re-read
    // whenever the program is replaced.
    void cacheUniformLocations();

    // Push the frame's values into the current program. Must be called with the
    // program bound.
    void applyUniforms(const GraphicsFrame& frame);

    // Draw the quad with `program`, which the caller has already bound and whose
    // uniforms it has set.
    //
    // Split out because two callers need it with DIFFERENT programs - the normal
    // frame path with m_program, and the verification with its own test program -
    // and sharing the body is what makes it impossible for the two to drift. It
    // reads no member that identifies a program, which is deliberately the property
    // that keeps a verification pass from corrupting the render path.
    bool drawQuadWithProgram(QOpenGLShaderProgram* program);

    bool channelClose(unsigned char actual, float expected) const;

    // Uniform locations for the current program, or -1 when it does not declare
    // that uniform. A shader is free to use only some of them - a static shader
    // has no use for iTime - so -1 is normal, not an error, and setting a uniform
    // at location -1 is a defined no-op in OpenGL.
    struct Uniforms
    {
        int time = -1;
        int timeDelta = -1;
        int frame = -1;
        int resolution = -1;
    };

    // Uniform locations for an arbitrary program, or -1 for each it does not
    // declare. Static and taking the program explicitly so the verification can ask
    // about its own program WITHOUT disturbing the cached locations belonging to
    // m_program.
    static Uniforms queryUniforms(QOpenGLShaderProgram* program);
    Uniforms m_uniforms;

    // Whether "this program declares no uniforms at all" has already been
    // reported, so the note appears once per program rather than once per frame.
    bool m_reportedNoUniforms = false;

    std::unique_ptr<QOpenGLFramebufferObject> m_fbo;
    std::unique_ptr<QOpenGLShaderProgram>     m_program;
    // Holds the quad's attribute bindings. A core-profile draw call needs one
    // bound even when the shader derives its own coordinates: without it
    // glDrawArrays raises GL_INVALID_OPERATION (0x502).
    //
    // Qt's wrapper rather than a raw GLuint: QOpenGLFunctions only exposes the
    // OpenGL ES 2.0 function set, which has no VAO entry points.
    std::unique_ptr<QOpenGLVertexArrayObject> m_vao;
    // The full-screen quad: position and uv, interleaved.
    std::unique_ptr<QOpenGLBuffer> m_vbo;
    QSize   m_size;
    QString m_vertexPath;
    QString m_fragmentPath;
};

} // namespace SonicPi
