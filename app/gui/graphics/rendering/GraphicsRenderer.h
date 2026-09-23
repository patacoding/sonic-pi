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
#include <QOpenGLShaderProgram>
#include <QOpenGLVertexArrayObject>
#include <QSize>
#include <QString>

#include <memory>
#include <atomic>

#include "GraphicsFrame.h"

class QOpenGLFramebufferObject;

namespace SonicPi
{

class GraphicsTarget;

// The shader program and the geometry that draws with it. No render target.
//
// What it owns is exactly what should exist once per shader: the linked program, the
// quad's vertex array and buffer, and the uniform locations that belong to that
// program. What it deliberately does NOT own is the framebuffer - see GraphicsTarget
// for why that separation is a correctness requirement rather than tidiness.
//
// The payoff is that double buffering costs two targets and still only one program,
// one set of uniform locations, and one compile per reload. Bundling the two would
// have meant two of each, which is the family of bug this feature has already been
// bitten by three times: state that should exist once, existing twice and drifting.
//
// Owned by, and only ever touched from, the thread holding the GL context it was
// created against. That is not a formality: a program belongs to the context it is
// used with, so compiling it anywhere else either fails or produces something this
// renderer cannot use.
//
// Shaders are loaded from files on disk rather than compiled in, so they can be
// edited and reloaded without a rebuild. Where they come from is reported in
// graphics.log.
class GraphicsRenderer
{
public:
    GraphicsRenderer() = default;
    // Defined in the .cpp: members here are only forward-declared, and
    // unique_ptr's deleter needs the complete types.
    ~GraphicsRenderer();

    GraphicsRenderer(const GraphicsRenderer&) = delete;
    GraphicsRenderer& operator=(const GraphicsRenderer&) = delete;

    // Builds the quad geometry and loads the shader files. Requires a current
    // context. Returns false and logs why on failure.
    bool initialize();

    // Release the GL objects now, while the caller can still make the owning
    // context current. Calling this is optional - the destructor does the same -
    // but a caller tearing down a context should not rely on member destruction
    // order.
    void destroy();

    // Draws one frame into `target`. Requires a current context.
    //
    // `frame` carries the uniform values; see GraphicsFrame for why they are passed
    // in rather than read from a clock here.
    bool renderInto(GraphicsTarget& target, const GraphicsFrame& frame);

    // Reads the framebuffer back and compares anchor points against the quadrant
    // test pattern in anchors.frag. Returns false if the pixels differ.
    //
    // The check uses its own shader rather than whatever default.frag currently
    // draws. Coupling the two would mean a legitimate edit to the default shader
    // broke the pipeline's self-test, and the anchors would have to be kept in a
    // synthetic image that ships as the default.
    //
    // That reasoning was then applied one step further: the self-test's own shaders are
    // compiled into the binary rather than read from the shader directory, because they
    // are a FIXTURE whose only reader is this function. See kSelfTestFragmentShader in
    // the .cpp - loading them from the user's editable copy made a healthy build report
    // a shader failure on every start, which is worse than not checking at all.
    bool verifyShaderOutput(GraphicsTarget& target);

    // Reads the whole target back as RGBA8. Returns false on failure.
    //
    // Note: OpenGL's origin is bottom-left, so row 0 of the returned data is the
    // *bottom* row of the image. verifyShaderOutput depends on that, which is why it
    // reads deliberately rather than by habit.
    bool readPixels(GraphicsTarget& target, QSize* sizeOut,
                    std::unique_ptr<unsigned char[]>* pixelsOut);

    // GPU time of one frame's draw, in milliseconds, or -1 when it has not been measured.
    //
    // What this measures that nothing else does: the CPU-side frame time says how long the
    // thread took to ISSUE the work, which is a fraction of a millisecond for a shader that
    // could still be too slow to run at the target rate. The GPU time is what actually answers
    // "how expensive is this shader at this resolution", which is the question a user asking
    // about frame rate is really asking.
    //
    // Written by the render thread and read by anything; a plain atomic so a reader cannot stall
    // a frame. -1 rather than 0 for "not measured", because 0 would read as a free shader.
    double gpuFrameMs() const { return m_gpuFrameMs.load(std::memory_order_relaxed); }
    // The same value sampled for the whole previous reporting window's worst frame. Better than
    // the average for spotting a shader that is usually fast and occasionally not.
    double gpuFrameWorstMs() const { return m_gpuFrameWorstMs.load(std::memory_order_relaxed); }
    // Average over the last reporting window, which the render thread computes and passes in
    // because it owns the reporting cadence. Called once a second, not per frame.
    void setGpuFrameAverages(double avgMs, double worstMs)
    {
        m_gpuFrameAvgMs.store(avgMs, std::memory_order_relaxed);
        m_gpuFrameWorstMs.store(worstMs, std::memory_order_relaxed);
    }
    double gpuFrameAvgMs() const { return m_gpuFrameAvgMs.load(std::memory_order_relaxed); }

    // Re-read the shader files and recompile. On failure the previously working
    // program is kept and the compiler log is reported, so a bad edit does not take
    // the picture away - design document principle 6.
    //
    // Must be called on the thread that owns the context, with that context current.
    // A shader program belongs to the context it is used with, so compiling it
    // anywhere else either fails or produces a program this renderer cannot use. The
    // render thread calls this from its own loop; the GUI asks the render thread
    // instead of doing it itself.
    //
    // Blocks for as long as compilation takes - hundreds of milliseconds. A caller
    // that cannot afford to stall a frame should use the two-step form below.
    bool reloadShaders();

    // Compile the shader files and hand back the result WITHOUT installing it.
    //
    // The point is that compilation - the slow part - happens while no lock is held,
    // so the render loop is not stalled by it. The caller installs the result with
    // adoptProgram() at a moment of its choosing, which is a pointer swap and
    // effectively instantaneous.
    //
    // Returns nullptr and logs the compiler output on failure, leaving the current
    // program alone, so a broken edit changes nothing - the same guarantee
    // reloadShaders() gives.
    std::unique_ptr<QOpenGLShaderProgram> compileReplacement();

    // Install a program produced by compileReplacement(). Requires a current context.
    //
    // The caller must hold whatever lock protects the render loop: this is the one
    // operation the loop must not race, and keeping it to a pointer swap is what
    // makes holding that lock acceptable.
    void adoptProgram(std::unique_ptr<QOpenGLShaderProgram> program);

    // There is deliberately no static "reload every renderer" entry point.
    //
    // One used to exist so a GUI action could recompile every live renderer. It could
    // not work: a shader program belongs to a context, a context belongs to a thread,
    // and the GUI thread can only make its own context current - so it compiled
    // against the wrong one and raced the render loop. The GUI now only requests a
    // reload and the render thread applies it, on its own context.

    // Where the fragment shader was loaded from, so it can be reported to the user
    // (and so they know which copy to edit).
    QString fragmentShaderPath() const { return m_fragmentPath; }
    QString vertexShaderPath() const { return m_vertexPath; }

    // The colour a target is cleared to before drawing, and the colour used when
    // there is no usable shader. Kept as named constants so the clear and any check
    // against it cannot drift apart.
    static constexpr float kClearR = 0.25f;
    static constexpr float kClearG = 0.50f;
    static constexpr float kClearB = 0.75f;
    static constexpr float kClearA = 1.0f;

private:
    // The VAO and the quad's vertex buffer, both required before any draw.
    bool createQuadGeometry();

    // Compile a vertex/fragment pair from disk into a linked program. Returns nullptr
    // and logs the compiler output on any failure.
    std::unique_ptr<QOpenGLShaderProgram> buildProgram(const QString& vertexFile,
                                                       const QString& fragmentFile);

    // Compile the self-test's own shader pair. Both halves are string literals in the
    // .cpp, so this cannot be broken by an edit to the shader directory, and cannot
    // disagree with the anchor table it is checked against.
    std::unique_ptr<QOpenGLShaderProgram> buildSelfTestProgram();

    // Load the default shader pair into m_program. Leaves m_program untouched on
    // failure.
    bool loadShaders();

    // The writable per-user shader directory, and the fallback in the source tree.
    // Returns an empty string if neither contains the file.
    QString resolveShaderPath(const QString& fileName) const;

    // Look up the uniform locations this renderer feeds.
    //
    // Called once per successful link rather than per frame: glGetUniformLocation is
    // a string lookup into the program and is not something to do 60+ times a second.
    // Locations belong to the program that was current when they were queried, so
    // they must be re-read whenever the program is replaced.
    void cacheUniformLocations();

    // Push the frame's values into the current program. Must be called with the
    // program bound.
    void applyUniforms(const GraphicsFrame& frame);

    // Draw the quad with `program`, which the caller has already bound and whose
    // uniforms it has set.
    //
    // Split out because two callers need it with DIFFERENT programs - the normal
    // frame path with m_program, and the verification with its own test program - and
    // sharing the body is what makes it impossible for the two to drift. It reads no
    // member that identifies a program, which is deliberately the property that keeps
    // a verification pass from corrupting the render path.
    bool drawQuadWithProgram(QOpenGLShaderProgram* program);

    bool channelClose(unsigned char actual, float expected) const;

    // Uniform locations for the current program, or -1 when it does not declare that
    // uniform. A shader is free to use only some of them - a static shader has no use
    // for iTime - so -1 is normal, not an error, and setting a uniform at location -1
    // is a defined no-op in OpenGL.
    struct Uniforms
    {
        int time = -1;
        int timeDelta = -1;
        int frame = -1;
        int resolution = -1;
    };

    // Uniform locations for an arbitrary program, or -1 for each it does not declare.
    // Static and taking the program explicitly so the verification can ask about its
    // own program WITHOUT disturbing the cached locations belonging to m_program.
    static Uniforms queryUniforms(QOpenGLShaderProgram* program);
    Uniforms m_uniforms;

    // Whether "this program declares no uniforms at all" has already been reported,
    // so the note appears once per program rather than once per frame.
    bool m_reportedNoUniforms = false;

    std::unique_ptr<QOpenGLShaderProgram>     m_program;
    // Holds the quad's attribute bindings. A core-profile draw call needs one bound
    // even when the shader derives its own coordinates: without it glDrawArrays
    // raises GL_INVALID_OPERATION (0x502).
    //
    // Qt's wrapper rather than a raw GLuint: QOpenGLFunctions only exposes the
    // OpenGL ES 2.0 function set, which has no VAO entry points.
    std::unique_ptr<QOpenGLVertexArrayObject> m_vao;
    // The full-screen quad: position and uv, interleaved.
    std::unique_ptr<QOpenGLBuffer> m_vbo;
    QString m_vertexPath;
    QString m_fragmentPath;

    // ---- GPU timing (GL_ARB_timer_query) ------------------------------------------------
    //
    // A POOL of query objects read round-robin, which is the whole trick. Reading a query's
    // result forces the CPU to wait for the GPU, so a query written and read in the same frame
    // would serialise the two and destroy the parallelism the design depends on - it would
    // measure a pipeline made synchronous by the act of measuring it.
    //
    // Instead each frame starts a query into the next slot and reads the result of the slot used
    // kQueryPoolSize frames ago. That result has been ready for several frames, so reading it is
    // free, and the cost reported is a few frames old - exactly right for a number that changes
    // a few times a second.
    //
    // If a slot's previous result is not ready, that frame is not timed rather than waited for.
    // Under a stall the pool is exhausted and timing stops on its own, then resumes.
    static constexpr int kQueryPoolSize = 4;
    GLuint m_queries[kQueryPoolSize] = { 0, 0, 0, 0 };
    int    m_querySlot = 0;
    int    m_queryPoolUsed = 0;      // how many entries hold a result worth reading
    bool   m_queryActive = false;    // a glBeginQuery is open
    bool   m_gpuTimerReady = false;  // extension present and entry point resolved
    bool   m_gpuTimerUnavailableReported = false;

    // Resolved by hand: QOpenGLExtraFunctions exposes glGetQueryObjectuiv, whose result is 32
    // bits, but a GL_TIME_ELAPSED result is nanoseconds in a 64-bit value, and this Qt version
    // has no wrapper for that one.
    using GetQueryObjectui64vFn = void (*)(GLuint, GLenum, GLuint64*);
    GetQueryObjectui64vFn m_glGetQueryObjectui64v = nullptr;

    std::atomic<double> m_gpuFrameMs{-1.0};
    std::atomic<double> m_gpuFrameAvgMs{-1.0};
    std::atomic<double> m_gpuFrameWorstMs{-1.0};

    // Open a query if possible, returning whether one was opened.
    bool beginGpuTiming();
    // Close the query and harvest an older slot's result. Safe when beginGpuTiming returned
    // false.
    void endGpuTiming();

public:
    // Resolve the entry point and create the query pool. Requires a current context, and is safe
    // to call more than once; the render thread calls it once after this renderer exists.
    //
    // Public because the render thread owns the context and therefore owns when this can happen,
    // and because this is what produces gpuTimerDescription() - the render thread logs that line,
    // and a measurement nobody can ask about is one nobody knows to distrust.
    void setUpGpuTimer();

    // Drop the query objects, while the context is still current.
    void releaseGpuTimer();

    // What the timer reports about itself, for the one log line at startup: whether GPU timing is
    // available, and why not when it is not.
    QString gpuTimerDescription() const;
};

} // namespace SonicPi
