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

// GraphicsDocuments.h — 磁盘上"一个 Shadertoy 文档"是什么（方案 A：目录级管理）。
//
// 约定（用户 2026-10-02 定，见 docs/graphics-desktop-multipass-plan.md §17.2）：
//
//   <shaders>/                       ← GraphicsSettings::shaderDirectoryPath()
//   ├── default.frag                 ← 顶层 .frag = **单 pass 文档**（既有行为，零迁移）
//   └── <doc>/                       ← 目录 = 一个文档，目录名 = tab 名
//       ├── common.glsl              ← Common：前置到本档每个 pass，**本身不是 pass**
//       ├── image.frag               ← Image：**存在它才算一个文档**
//       └── bufferA.frag … bufferD.frag
//
// 规则：缺某个 buffer 文件 → 该 pass 为空（不编译、不画，采样它 = 黑，与 web
// "空 pass 不花钱、指向它是黑而不是异常" 一致）；缺 common.glsl → 空（不是错误）；
// 缺 image.frag → 目录**不算文档**（免得随便一个目录被当成文档）；文件名**精确匹配**大小写。
//
// 这个头只回答"有哪些文档、每个文档的哪个 pass 在哪个文件"——不读文件内容、不碰 GL、不碰 QSettings，
// 所以它能被编译进任何地方，也能被 UI 与管线共同使用而不互相牵制。

#pragma once

#include <QDir>
#include <QFileInfo>
#include <QString>
#include <QSize>
#include <QStringList>

#include "GraphicsPasses.h"

namespace SonicPi
{

// Image is the pass whose presence makes a directory a document: a directory without it is not one.
inline QString graphicsDocumentImageFileName() { return QStringLiteral("image.frag"); }
inline QString graphicsDocumentCommonFileName() { return QStringLiteral("common.glsl"); }

// "image" -> "image.frag", "bufferA" -> "bufferA.frag": one rule, taken from the pass vocabulary, so the
// file names and graphicsPassName() cannot drift apart.
inline QString graphicsDocumentPassFileName(GraphicsPass pass)
{
    if (pass == GraphicsPass::Common)
        return graphicsDocumentCommonFileName();
    return graphicsPassName(pass) + QStringLiteral(".frag");
}

struct GraphicsDocument
{
    QString name;        // tab name: the directory's name, or the file's base name for a single pass
    QString directory;   // empty for a single-pass document (a top-level .frag file)
    bool singlePass = false;

    bool isValid() const { return !name.isEmpty(); }

    // Absolute path of one pass's text, or an empty string when that pass has no file (which is not an
    // error: an absent buffer is an empty pass).
    QString passPath(GraphicsPass pass) const
    {
        if (singlePass) {
            // A single-pass document is one file: everything but Image is absent, and Image IS the file.
            if (pass != GraphicsPass::Image)
                return QString();
            return directory.isEmpty() ? QString() : m_singlePassFile;
        }
        const QString file = QDir(directory).filePath(graphicsDocumentPassFileName(pass));
        return QFileInfo::exists(file) ? file : QString();
    }

    // Set only for single-pass documents, by the scanner below.
    QString m_singlePassFile;
};

// The four Shadertoy channels of ONE PASS of a document, as the DRAW INDEX of the buffer each one reads, or
// -1 for None (a shader sampling it gets black).
//
// PER PASS, which is what Shadertoy does: its API hangs the bindings under each render pass, and its editor
// shows the channel row of whichever pass is selected. A single shared set - what this did first, a
// deliberate deviation recorded in the plan - cannot express a shader whose Buffer A reads Buffer B while
// its Image reads Buffer A, so porting such a shader would mean renumbering its channels.
//
// Stored beside the document's passes, one section per pass:
//
//     [Image]
//     iChannel0 = bufferA
//     iChannel1 = none
//     [Buffer A]
//     iChannel0 = none
//
// Human-readable and hand-editable on purpose. A file with NO section header is a document-level
// assignment applying to every pass - the format this had before channels were per-pass - so old files keep
// meaning what they meant. A missing file means the default assignment (channel i reads Buffer i).
inline QString graphicsDocumentChannelsFileName() { return QStringLiteral("channels.txt"); }

// Where a document's channel assignments live.
//
// A DIRECTORY document keeps them inside itself: <shaders>/<doc>/channels.txt - one file per document, next
// to the passes it describes.
//
// A SINGLE-PASS .frag has no directory of its own, so its assignments go BESIDE it as a sidecar named after
// the file: <shaders>/<name>.channels.txt. Without this a top-level .frag had no place to write a channel at
// all, so choosing one did nothing and the row came back to None on the next pass switch - "the channel
// settings are lost when I switch", which is the symptom this file's path rule is answerable for. The
// sidecar is deliberately NOT shared between two .frag files that happen to have the same base name in
// different directories: the name carries the whole path's base, as the tab name does.
inline QString graphicsDocumentChannelsPath(const GraphicsDocument& document)
{
    if (document.directory.isEmpty())
        return QString();
    if (document.singlePass)
        return QDir(document.directory).filePath(document.name + QStringLiteral(".channels.txt"));
    return QDir(document.directory).filePath(graphicsDocumentChannelsFileName());
}

// WHERE A CHANNEL'S IMAGE PATH POINTS. A path may be absolute ("C:/Users/me/x.png") or relative to the
// document's own directory ("img/x.png").
//
// Both are needed, and for different reasons. Absolute is what the file dialog hands over when a person
// picks a picture from anywhere on the machine, which is the ordinary case and must keep working. Relative
// is what a SAVED document needs: the record and the pictures travel together, so a directory can be moved,
// copied to another machine, or put in version control - and an absolute path inside it would break all
// three the moment it left this machine.
//
// Relative is resolved against the document directory, and left alone when there is no directory to resolve
// against (a document that is not on disk yet): the honest answer then is "as written", not a guess.
inline QString graphicsDocumentPath(const GraphicsDocument& document, const QString& path)
{
    if (path.isEmpty() || QDir::isAbsolutePath(path))
        return path;
    if (document.directory.isEmpty())
        return path;
    return QDir(document.directory).absoluteFilePath(path);
}

// The channel whose line names `name`, or -1 when the line says none or anything unrecognised.
inline int graphicsChannelSourceFromName(const QString& name)
{
    const QString wanted = name.trimmed().toLower();
    if (wanted.isEmpty() || wanted == QLatin1String("none"))
        return -1;
    for (int i = 0; i < kDrawOrderCount; ++i) {
        if (graphicsPassName(kDrawOrder[i]).toLower() == wanted)
            return i;
    }
    return -1;
}

// A section header as a key: lower case, spaces removed, so "[Buffer A]" and "[bufferA]" are the same pass.
inline QString graphicsChannelSectionKey(const QString& raw)
{
    QString key = raw.trimmed().toLower();
    key.remove(QLatin1Char(' '));
    return key;
}

// Every section of the file, keyed by pass name (graphicsPassName), plus the key "*" when the file has no
// sections at all - the legacy document-level form.
inline QHash<QString, QList<int>> graphicsDocumentChannelTable(const GraphicsDocument& document)
{
    QHash<QString, QList<int>> table;
    const QString path = graphicsDocumentChannelsPath(document);
    if (path.isEmpty())
        return table;

    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text))
        return table;

    QTextStream in(&file);
    QString section;
    QList<int> legacy;
    while (!in.atEnd())
    {
        const QString line = in.readLine().trimmed();
        if (line.isEmpty() || line.startsWith(QLatin1Char('#')))
            continue;

        if (line.startsWith(QLatin1Char('[')) && line.endsWith(QLatin1Char(']')))
        {
            section = graphicsChannelSectionKey(line.mid(1, line.size() - 2));
            if (!table.contains(section))
                table.insert(section, QList<int>() << -1 << -1 << -1 << -1);
            continue;
        }

        const int equals = line.indexOf(QLatin1Char('='));
        if (equals <= 0)
            continue;
        const QString key = line.left(equals).trimmed().toLower();
        if (!key.startsWith(QLatin1String("ichannel")))
            continue;
        bool ok = false;
        const int index = key.mid(8).toInt(&ok);   // "ichannel" is 8 characters
        if (!ok || index < 0 || index > 3)
            continue;

        const int source = graphicsChannelSourceFromName(line.mid(equals + 1));
        if (section.isEmpty())
        {
            while (legacy.size() < 4)
                legacy << -1;
            legacy[index] = source;
        }
        else
        {
            QList<int> entry = table.value(section);
            while (entry.size() < 4)
                entry << -1;
            entry[index] = source;
            table.insert(section, entry);
        }
    }

    if (!legacy.isEmpty())
        table.insert(QStringLiteral("*"), legacy);
    return table;
}

// The sources for one pass, or an empty list when the document says nothing about it - in which case the
// caller applies the default (channel i reads Buffer i).
inline QList<int> graphicsDocumentChannels(const GraphicsDocument& document, GraphicsPass pass)
{
    const QHash<QString, QList<int>> table = graphicsDocumentChannelTable(document);
    const QString key = graphicsChannelSectionKey(graphicsPassName(pass));
    if (table.contains(key))
        return table.value(key);
    if (table.contains(QStringLiteral("*")))
        return table.value(QStringLiteral("*"));
    return QList<int>();
}

// Write one pass's four lines, keeping every other section. Existing sections are re-emitted in name order,
// so a diff of this file shows only what the user changed.
inline bool writeGraphicsDocumentChannels(const GraphicsDocument& document, GraphicsPass pass,
                                          const QList<int>& channels)
{
    if (channels.size() != 4)
        return false;

    QHash<QString, QList<int>> table = graphicsDocumentChannelTable(document);
    const QString key = graphicsChannelSectionKey(graphicsPassName(pass));
    table.insert(key, channels);
    table.remove(QStringLiteral("*"));   // a legacy file becomes sections on its first write

    const QString path = graphicsDocumentChannelsPath(document);
    if (path.isEmpty())
        return false;

    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text))
        return false;

    QTextStream out(&file);
    QStringList order = table.keys();
    order.sort();
    for (const QString& sectionName : order)
    {
        out << QStringLiteral("[%1]\n").arg(sectionName);
        const QList<int> entry = table.value(sectionName);
        for (int i = 0; i < 4; ++i)
        {
            const int source = entry.value(i, -1);
            const QString name = (source >= 0 && source < kDrawOrderCount)
                                     ? graphicsPassName(kDrawOrder[source])
                                     : QStringLiteral("none");
            out << QStringLiteral("iChannel%1 = %2\n").arg(i).arg(name);
        }
    }
    return true;
}
// WHERE A CHANNEL GETS ITS TEXTURE. The simplified set this feature supports (plan 23): one of the
// document's own buffers, an image file, or a cubemap file - and nothing else. Shadertoy's full list (video,
// keyboard, microphone, audio) is deliberately out of scope.
//
// It travels as {kind, ref} rather than an index because a channel is no longer only "which buffer": the web
// version left the same seam for the same reason, so adding video later would be one more kind and not a
// second model.
struct GraphicsChannelSource
{
    enum Kind { None, Buffer, Texture, Cubemap };

    Kind kind = None;
    int bufferIndex = -1;   // Buffer: the draw index of the pass it reads (graphicsPassDrawIndex)
    QString path;           // Texture and Cubemap: the file, as the user chose it

    bool isBuffer() const { return kind == Buffer && bufferIndex >= 0; }
    bool isTexture() const { return kind == Texture && !path.isEmpty(); }
    bool isCubemap() const { return kind == Cubemap && !path.isEmpty(); }

    bool operator==(const GraphicsChannelSource& other) const
    {
        return kind == other.kind && bufferIndex == other.bufferIndex && path == other.path;
    }
    bool operator!=(const GraphicsChannelSource& other) const { return !(*this == other); }
};

// The text after "iChannelN =", read into a source. Prefixes rather than a second table, so "which kind" and
// "which file" are on one line and the file stays readable and hand-editable:
//
//     none            -> None
//     bufferA .. D    -> Buffer (bare names, so files written before this keep working unchanged)
//     texture:<path>  -> Texture
//     cubemap:<path>  -> Cubemap
//
// Anything unrecognised is None, which is what an absent buffer already means: black, not a fault.
inline GraphicsChannelSource graphicsChannelSourceFromText(const QString& text)
{
    GraphicsChannelSource source;
    const QString wanted = text.trimmed();
    const QString lowered = wanted.toLower();

    if (lowered.isEmpty() || lowered == QLatin1String("none"))
        return source;

    if (lowered.startsWith(QLatin1String("texture:")))
    {
        source.kind = GraphicsChannelSource::Texture;
        source.path = wanted.mid(8).trimmed();
        return source;
    }
    if (lowered.startsWith(QLatin1String("cubemap:")))
    {
        source.kind = GraphicsChannelSource::Cubemap;
        source.path = wanted.mid(8).trimmed();
        return source;
    }

    const int index = graphicsChannelSourceFromName(wanted);
    if (index >= 0)
    {
        source.kind = GraphicsChannelSource::Buffer;
        source.bufferIndex = index;
    }
    return source;
}

inline QString graphicsChannelSourceToText(const GraphicsChannelSource& source)
{
    switch (source.kind)
    {
    case GraphicsChannelSource::Buffer:
        if (source.bufferIndex >= 0 && source.bufferIndex < kDrawOrderCount)
            return graphicsPassName(kDrawOrder[source.bufferIndex]);
        return QStringLiteral("none");
    case GraphicsChannelSource::Texture:
        return source.path.isEmpty() ? QStringLiteral("none") : QStringLiteral("texture:") + source.path;
    case GraphicsChannelSource::Cubemap:
        return source.path.isEmpty() ? QStringLiteral("none") : QStringLiteral("cubemap:") + source.path;
    case GraphicsChannelSource::None:
        break;
    }
    return QStringLiteral("none");
}

// Write one pass's four channels from SOURCES, which is what the editor has in hand once a channel can name an
// image or a cubemap. Emitted with the same prefixes the reader understands, so the file stays the one place
// that says what a channel means.
inline bool writeGraphicsDocumentChannelSources(const GraphicsDocument& document, GraphicsPass pass,
                                               const QList<GraphicsChannelSource>& sources)
{
    if (sources.size() != 4)
        return false;
    const QString path = graphicsDocumentChannelsPath(document);
    if (path.isEmpty())
        return false;

    // An image that lives INSIDE the document's own directory is written as a path relative to it, and
    // anything else is written as it is. Both forms are read back identically (graphicsDocumentPath), and
    // the reason for preferring the relative one is that it is the form a document can be moved with: a
    // saved directory is meant to be copyable, and an absolute path to an image sitting right beside the
    // code would break the moment the directory left this machine.
    QList<GraphicsChannelSource> stored = sources;
    if (!document.directory.isEmpty())
    {
        const QDir directory(document.directory);
        for (GraphicsChannelSource& source : stored)
        {
            if (!source.isTexture() && !source.isCubemap())
                continue;
            const QString relative = directory.relativeFilePath(source.path);
            if (!relative.startsWith(QLatin1String("..")))
                source.path = relative;
        }
    }

    // Read the other passes' sections first, so writing one pass cannot drop another's settings.
    QHash<QString, QList<GraphicsChannelSource>> otherSections;
    {
        QFile in(path);
        if (in.open(QIODevice::ReadOnly | QIODevice::Text))
        {
            QTextStream stream(&in);
            QString section;
            QList<GraphicsChannelSource> four;
            four << GraphicsChannelSource{} << GraphicsChannelSource{}
                 << GraphicsChannelSource{} << GraphicsChannelSource{};
            auto flush = [&otherSections, &four](const QString& name) {
                if (!name.isEmpty())
                    otherSections.insert(name, four);
            };
            while (!stream.atEnd())
            {
                const QString line = stream.readLine().trimmed();
                if (line.startsWith(QLatin1Char('[')) && line.endsWith(QLatin1Char(']')))
                {
                    flush(section);
                    section = graphicsChannelSectionKey(line.mid(1, line.size() - 2));
                    four = QList<GraphicsChannelSource>{ GraphicsChannelSource{}, GraphicsChannelSource{},
                                                         GraphicsChannelSource{}, GraphicsChannelSource{} };
                    continue;
                }
                const int equals = line.indexOf(QLatin1Char('='));
                if (equals <= 0)
                    continue;
                const QString key = line.left(equals).trimmed().toLower();
                if (!key.startsWith(QLatin1String("ichannel")))
                    continue;
                bool ok = false;
                const int index = key.mid(8).toInt(&ok);
                if (!ok || index < 0 || index > 3)
                    continue;
                four[index] = graphicsChannelSourceFromText(line.mid(equals + 1));
            }
            flush(section);
        }
    }
    otherSections.insert(graphicsChannelSectionKey(graphicsPassName(pass)), stored);
    // The legacy wildcard section is NOT carried over as a literal "[*]": it meant "applies to every pass"
    // only while there were no sections at all, and once this file has per-pass sections it would read as a
    // pass named "*" - a section the reader would then apply to nothing. The callers that migrate it (the
    // int-based writer above) do the same thing for the same reason.
    otherSections.remove(QStringLiteral("*"));

    QFile out(path);
    if (!out.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text))
        return false;
    QTextStream text(&out);
    QStringList names = otherSections.keys();
    names.sort();
    for (const QString& name : names)
    {
        text << QStringLiteral("[%1]\n").arg(name);
        const QList<GraphicsChannelSource> four = otherSections.value(name);
        for (int i = 0; i < 4; ++i)
            text << QStringLiteral("iChannel%1 = %2\n").arg(i).arg(graphicsChannelSourceToText(four.value(i)));
    }
    return true;
}

// The four channels of one pass as SOURCES rather than buffer indices: what the renderer needs now that a
// channel can name an image or a cubemap as well as a buffer. The int-based reader stays for the paths that
// only ever dealt in buffers.
inline QList<GraphicsChannelSource> graphicsDocumentChannelSources(const GraphicsDocument& document,
                                                                  GraphicsPass pass)
{
    QList<GraphicsChannelSource> sources;
    const QHash<QString, QList<int>> table = graphicsDocumentChannelTable(document);
    const QString key = graphicsChannelSectionKey(graphicsPassName(pass));
    QList<int> indices;
    if (table.contains(key))
        indices = table.value(key);
    else if (table.contains(QStringLiteral("*")))
        indices = table.value(QStringLiteral("*"));

    // The table stores indices because that is what the file's bare buffer names parse to; the richer kinds
    // are read from the text by the caller below, which is the only place that knows the paths.
    for (int i = 0; i < 4; ++i)
    {
        GraphicsChannelSource source;
        if (i < indices.size() && indices[i] >= 0)
        {
            source.kind = GraphicsChannelSource::Buffer;
            source.bufferIndex = indices[i];
        }
        sources << source;
    }
    return sources;
}

// The same four channels, read from the file's TEXT so texture:/cubemap: prefixes survive. This is the one the
// renderer and the editor should use; the index-based readers above remain for compatibility.
//
// A relative image path is resolved against the document's own directory (see graphicsDocumentPath), so a
// saved document can be copied to another machine and still find its pictures.
inline QList<GraphicsChannelSource> graphicsDocumentChannelSourcesFromFile(const GraphicsDocument& document,
                                                                          GraphicsPass pass)
{
    QList<GraphicsChannelSource> sources;
    sources << GraphicsChannelSource{} << GraphicsChannelSource{}
            << GraphicsChannelSource{} << GraphicsChannelSource{};

    const QString path = graphicsDocumentChannelsPath(document);
    if (path.isEmpty())
        return sources;

    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text))
        return sources;

    const QString wanted = graphicsChannelSectionKey(graphicsPassName(pass));
    QTextStream in(&file);
    QString section;
    QList<GraphicsChannelSource> legacy = sources;
    while (!in.atEnd())
    {
        const QString line = in.readLine().trimmed();
        if (line.isEmpty() || line.startsWith(QLatin1Char('#')))
            continue;
        if (line.startsWith(QLatin1Char('[')) && line.endsWith(QLatin1Char(']')))
        {
            section = graphicsChannelSectionKey(line.mid(1, line.size() - 2));
            continue;
        }
        const int equals = line.indexOf(QLatin1Char('='));
        if (equals <= 0)
            continue;
        const QString key = line.left(equals).trimmed().toLower();
        if (!key.startsWith(QLatin1String("ichannel")))
            continue;
        bool ok = false;
        const int index = key.mid(8).toInt(&ok);
        if (!ok || index < 0 || index > 3)
            continue;

        const GraphicsChannelSource source = graphicsChannelSourceFromText(line.mid(equals + 1));
        if (section.isEmpty())
            legacy[index] = source;
        else if (section == wanted)
            sources[index] = source;
    }

    // No sections at all: the legacy document-level form, which applies to every pass.
    const auto resolved = [&document](const QList<GraphicsChannelSource>& four) {
        QList<GraphicsChannelSource> out = four;
        for (GraphicsChannelSource& source : out)
        {
            if (source.isTexture() || source.isCubemap())
                source.path = graphicsDocumentPath(document, source.path);
        }
        return out;
    };
    if (sources == QList<GraphicsChannelSource>() << GraphicsChannelSource{} << GraphicsChannelSource{}
            << GraphicsChannelSource{} << GraphicsChannelSource{}
        && legacy != sources)
    {
        return resolved(legacy);
    }
    return resolved(sources);
}

// The six faces of a cubemap, in the order QOpenGLTexture wants them (+X, -X, +Y, -Y, +Z, -Z), taken from ONE
// image laid out as a cross. That layout is the user's choice (2026-10-02) and is the usual 4x3 cross:
//
//         +Y
//     -X  +Z  +X  -Z
//         -Y
//
// so face size is width/4 by height/3, and the four cells of the middle row are read in that order. The
// function only reports WHERE each face is; reading pixels is the renderer's business, which keeps this file
// free of Qt GUI types (it is included by the render thread as well as the editor).
struct GraphicsCubemapFace { int x = 0; int y = 0; };
inline bool graphicsCubemapCrossFaces(const QSize& imageSize, GraphicsCubemapFace faces[6])
{
    if (imageSize.width() <= 0 || imageSize.height() <= 0)
        return false;
    const int faceW = imageSize.width() / 4;
    const int faceH = imageSize.height() / 3;
    if (faceW <= 0 || faceH <= 0)
        return false;

    // +X, -X, +Y, -Y, +Z, -Z  (QOpenGLTexture::CubeMapPositiveX ... CubeMapNegativeZ)
    faces[0] = GraphicsCubemapFace{ 2 * faceW, 1 * faceH };   // +X
    faces[1] = GraphicsCubemapFace{ 0 * faceW, 1 * faceH };   // -X
    faces[2] = GraphicsCubemapFace{ 1 * faceW, 0 * faceH };   // +Y
    faces[3] = GraphicsCubemapFace{ 1 * faceW, 2 * faceH };   // -Y
    faces[4] = GraphicsCubemapFace{ 1 * faceW, 1 * faceH };   // +Z
    faces[5] = GraphicsCubemapFace{ 3 * faceW, 1 * faceH };   // -Z
    return true;
}

// The passes this document actually HAS, in the frame order GraphicsPasses.h names: Image always (it is
// what makes a directory a document), and each Buffer only when its file exists. This is what a pass
// selector should offer, and what keeps an editor tab from offering a pass the renderer has no program
// for - the same rule as "an absent buffer is an empty pass" (plan 17.2), expressed once.
inline QList<GraphicsPass> graphicsDocumentPasses(const GraphicsDocument& document)
{
    QList<GraphicsPass> passes;
    if (!document.isValid())
        return passes;
    for (int i = 0; i < kDrawOrderCount; ++i) {
        if (!document.passPath(kDrawOrder[i]).isEmpty())
            passes.append(kDrawOrder[i]);
    }
    return passes;
}

// The FILE a pass's text lives in, whether or not it exists yet.
//
// `GraphicsDocument::passPath()` answers a different question - "which pass has text I can read" - and
// returns empty for a pass whose file is not there, which is right for a reader and wrong for a writer.
// This is the writer's answer, and it is the same rule the editor uses to decide where Compile writes:
//
//   a directory document -> <dir>/<pass>.frag          (image.frag, bufferA.frag, common.glsl)
//   a single-pass .frag  -> that file for Image, and <base>.<pass>.frag for a buffer or Common
//
// The single-pass case is what lets a plain .frag take part in the pass chain: Image IS the file, and
// typing into Buffer A and compiling creates <base>.bufferA.frag, which is then its own pass. The names are
// derived from the document, so a buffer cannot end up beside the wrong shader.
inline QString graphicsDocumentPassFilePath(const GraphicsDocument& document, GraphicsPass pass)
{
    if (!document.isValid() || document.directory.isEmpty())
        return QString();

    if (!document.singlePass)
        return QDir(document.directory).filePath(graphicsDocumentPassFileName(pass));

    // One file, so Image is it and everything else is a sibling with the pass in the name - including
    // Common, which is <base>.common.glsl because "common.glsl" alone would be shared by every .frag in
    // the directory, and Common belongs to ONE document (plan 15: documents do not share).
    if (pass == GraphicsPass::Image)
        return document.m_singlePassFile;
    return QDir(document.directory)
        .filePath(document.name + QLatin1Char('.') + graphicsDocumentPassFileName(pass));
}

// Every document under `shadersDir`: its subdirectories that hold image.frag, plus its top-level .frag
// files (each of which stays a single-pass document, exactly as before this feature).
inline QList<GraphicsDocument> scanGraphicsDocuments(const QString& shadersDir)
{
    QList<GraphicsDocument> documents;
    const QDir root(shadersDir);
    if (!root.exists())
        return documents;

    // Directories first, in name order: a document is a directory containing image.frag.
    const QStringList dirs = root.entryList(QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name);
    for (const QString& dirName : dirs) {
        const QDir dir(root.filePath(dirName));
        if (!QFileInfo::exists(dir.filePath(graphicsDocumentImageFileName())))
            continue;   // not a document - just a directory somebody made
        GraphicsDocument document;
        document.name = dirName;
        document.directory = dir.absolutePath();
        document.singlePass = false;
        documents.append(document);
    }

    // Then the top-level .frag files: unchanged behaviour, one file is one single-pass document.
    const QStringList files = root.entryList(QStringList() << QStringLiteral("*.frag"), QDir::Files, QDir::Name);
    for (const QString& fileName : files) {
        GraphicsDocument document;
        document.name = QFileInfo(fileName).completeBaseName();
        document.directory = root.absolutePath();
        document.singlePass = true;
        document.m_singlePassFile = root.filePath(fileName);
        documents.append(document);
    }

    return documents;
}

} // namespace SonicPi
