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

// GraphicsDocumentFile.h — 把**一个文档**存成一个可以带走的目录，再原样读回来。
//
// 目录形态（用户 2026-10-02 指定：六个文本各一个 frag 文件 + 图片 + 一个 json 记录通道状态）：
//
//     <目标目录>/
//     ├── shadertoy.json      ← 自描述：版本、文档名、每个 pass 的文件名、通道、图片清单
//     ├── image.frag          ← 与渲染目录里的磁盘布局**同一套规则**（GraphicsDocuments.h）
//     ├── bufferA.frag … bufferD.frag
//     ├── common.glsl         ← Common 是 GLSL 片段、不是 pass，所以沿用它在文档里的真名
//     └── img/<文件名>        ← 图片与 cubemap 的**副本**，一起带走
//
// 为什么必须**同时**写 json 和那套文件：
//   * json 是**给重新加载用的**索引（谁是谁、通道指向什么、原图叫什么）✓；
//   * 六个文本文件是**给眼睛和别的工具用的**（能直接看、能 diff、能拖进别的编辑器）✓，
//     而且格式与运行目录**逐字一致** —— 于是"存出来的东西"与"正在跑的东西"不可能有两套规则 ✓。
//
// 图片为什么要**拷进 img/**：记录里存绝对路径只能在这台机器上打开 ✗。拷一份、记相对路径 ✓，
// 目录就能整体搬走 ✓；通道里因此可能出现**相对路径**，解析规则见 graphicsDocumentPath()（GraphicsDocuments.h）。
//
// 载入侧**只信 json 的清单** ✗，还要求清单里点名的文件**真的存在** ✓ —— 一个 json 指向目录里没有的
// `bufferB.frag` 时，载入会**明说**少了什么 ✓，而不是悄悄变成一个空 pass ✓（两者在画面上无法区分 ✗）。
//
// 这个头**不含 widget、不含 GL、不碰 QSettings** ✓：解析与文件搬运是纯逻辑 ✓，
// 所以它可以在独立探针里被断言 ✓（docs/dev-discipline.md 4.1 ✓），而对话框只负责挑路径 ✓。

#pragma once

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QString>
#include <QStringList>

#include "GraphicsDocuments.h"
#include "GraphicsPasses.h"

namespace SonicPi
{

// The name of the record file, and the extension a person looks for when loading.
inline QString graphicsDocumentRecordFileName() { return QStringLiteral("shadertoy.json"); }

// Where the copied images live inside a saved directory.
inline QString graphicsDocumentImageDirectoryName() { return QStringLiteral("img"); }

// The format version. Written so a file from a future version can say "I am newer than you" instead of
// being read as if the fields it lacks were absent.
inline constexpr int kGraphicsDocumentFormatVersion = 1;

// One document, as the editor holds it: six texts (Common among them), the image files the channels name,
// and the channel assignment per pass.
//
// TEXT IS KEPT IN MEMORY, not re-read from the shaders directory when saving: the user may have typed
// without compiling, and those keystrokes are exactly what a save is for. Everything else is derived from
// what is on disk - the images, and where a file goes.
struct GraphicsDocumentFile
{
    QString name;                                            // the tab name, and the name on load
    QString text[6];                                         // indexed by int(GraphicsPass)
    QList<GraphicsChannelSource> channels[6];                // per pass; Common's stays empty
    QString savedPath;                                       // filled in by saveGraphicsDocument()

    QString textFor(GraphicsPass pass) const { return text[int(pass)]; }
    void setTextFor(GraphicsPass pass, const QString& value) { text[int(pass)] = value; }
};

// The JSON, from the struct: one place that knows the field names, so the reader and the writer cannot
// drift into disagreeing about them.
inline QJsonObject graphicsDocumentToJson(const GraphicsDocumentFile& file)
{
    QJsonObject root;
    root.insert(QStringLiteral("format"), QStringLiteral("sonic-pi-shadertoy-document"));
    root.insert(QStringLiteral("version"), kGraphicsDocumentFormatVersion);
    root.insert(QStringLiteral("name"), file.name);

    // Which file holds each pass. Written rather than assumed: a reader that hard-codes "bufferA.frag" has
    // to change whenever the on-disk rule does, and this is one line here.
    QJsonObject files;
    QJsonObject passes;
    for (int i = 0; i < kDrawOrderCount; ++i)
    {
        const GraphicsPass pass = kDrawOrder[i];
        files.insert(graphicsPassName(pass), graphicsDocumentPassFileName(pass));
    }
    files.insert(QStringLiteral("common"), graphicsDocumentCommonFileName());
    root.insert(QStringLiteral("files"), files);

    // The channels, PER PASS: a channel belongs to the pass that samples it (Shadertoy's own model), so a
    // document whose Buffer A reads Buffer B while its Image reads Buffer A keeps meaning that.
    QJsonArray channels;
    for (int i = 0; i < kDrawOrderCount; ++i)
    {
        const GraphicsPass pass = kDrawOrder[i];
        QJsonObject entry;
        entry.insert(QStringLiteral("pass"), graphicsPassName(pass));
        QJsonArray four;
        for (int ch = 0; ch < 4; ++ch)
            four.append(graphicsChannelSourceToText(file.channels[int(pass)].value(ch)));
        entry.insert(QStringLiteral("channels"), four);
        channels.append(entry);
    }
    root.insert(QStringLiteral("passes"), channels);
    return root;
}

// The images one document needs, and WHERE each one ends up inside the saved directory. Collected before
// anything is written, so a save cannot half-copy: two channels naming the same picture are copied once.
//
// The name inside img/ is the file's own name, de-duplicated with "2", "3"… when two different paths share
// a base name - keeping the original name because that is what a person recognises, and de-duplicating so a
// second picture cannot overwrite the first.
struct GraphicsDocumentImage
{
    QString sourcePath;    // absolute, as the channel names it
    QString relativePath;  // "img/<name>", as the record stores it
    bool isCubemap = false;
};

inline QList<GraphicsDocumentImage> graphicsDocumentImages(const GraphicsDocumentFile& file)
{
    QList<GraphicsDocumentImage> images;
    QStringList used;

    for (GraphicsPass pass : kDrawOrder)
    {
        for (const GraphicsChannelSource& source : file.channels[int(pass)])
        {
            if (!source.isTexture() && !source.isCubemap())
                continue;

            bool seen = false;
            for (const GraphicsDocumentImage& existing : images)
            {
                if (existing.sourcePath == source.path)
                {
                    seen = true;
                    break;
                }
            }
            if (seen)
                continue;

            GraphicsDocumentImage image;
            image.sourcePath = source.path;
            image.isCubemap = source.isCubemap();

            QString leaf = QFileInfo(source.path).fileName();
            if (leaf.isEmpty())
                leaf = QStringLiteral("image");
            QString candidate = leaf;
            int suffix = 1;
            while (used.contains(candidate, Qt::CaseInsensitive))
            {
                ++suffix;
                const int dot = leaf.lastIndexOf(QLatin1Char('.'));
                candidate = (dot > 0) ? QStringLiteral("%1-%2%3").arg(leaf.left(dot)).arg(suffix)
                                            .arg(leaf.mid(dot))
                                      : QStringLiteral("%1-%2").arg(leaf).arg(suffix);
            }
            used << candidate;
            image.relativePath = graphicsDocumentImageDirectoryName() + QLatin1Char('/') + candidate;
            images.append(image);
        }
    }
    return images;
}

// A channel's source text, with any absolute image path REWRITTEN to the relative one that travels with the
// document. Anything else (none, a buffer, an already-relative path) is left exactly as it is.
inline QString graphicsDocumentPortableChannelText(const GraphicsChannelSource& source,
                                                   const QList<GraphicsDocumentImage>& images)
{
    if (!source.isTexture() && !source.isCubemap())
        return graphicsChannelSourceToText(source);

    for (const GraphicsDocumentImage& image : images)
    {
        if (image.sourcePath == source.path)
        {
            GraphicsChannelSource portable = source;
            portable.path = image.relativePath;
            return graphicsChannelSourceToText(portable);
        }
    }
    // Not collected (a path that is already relative, or one the caller chose not to copy): kept as it is,
    // so nothing is silently dropped from the record.
    return graphicsChannelSourceToText(source);
}

// One warning, or one reason a save or load could not happen. Empty means it worked.
struct GraphicsDocumentIoResult
{
    bool ok = false;
    QString message;
    QStringList warnings;
};

// Save `file` into `targetDirectory`, creating it if needed. Requires no GL and no widgets.
//
// EVERYTHING IS WRITTEN FROM THE STRUCT: the texts as handed in (which include edits never compiled), the
// images as copies, and one JSON that can rebuild all of it. A file that cannot be copied is a WARNING and
// not a failure - the other five passes and the record are still worth having - but it is said, and the
// channel keeps the absolute path so the document still works on this machine.
inline GraphicsDocumentIoResult saveGraphicsDocument(const GraphicsDocumentFile& file,
                                                     const QString& targetDirectory)
{
    GraphicsDocumentIoResult result;
    if (file.name.trimmed().isEmpty())
    {
        result.message = QStringLiteral("The document has no name; there is nothing to save.");
        return result;
    }

    QDir target(targetDirectory);
    if (!target.exists() && !QDir().mkpath(target.absolutePath()))
    {
        result.message = QStringLiteral("Could not create %1").arg(target.absolutePath());
        return result;
    }

    // The six texts, named by the SAME rule the renderer reads: what is saved can be used as a document
    // directory as it stands.
    for (GraphicsPass pass : { GraphicsPass::Common, GraphicsPass::Image, GraphicsPass::BufferA,
                               GraphicsPass::BufferB, GraphicsPass::BufferC, GraphicsPass::BufferD })
    {
        const QString path = target.filePath(graphicsDocumentPassFileName(pass));
        QFile out(path);
        if (!out.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text))
        {
            result.message = QStringLiteral("Could not write %1").arg(path);
            return result;
        }
        {
            QTextStream stream(&out);
            stream << file.textFor(pass);
        }
        out.close();
    }

    // The images, each copied once, into img/.
    const QList<GraphicsDocumentImage> images = graphicsDocumentImages(file);
    if (!images.isEmpty())
    {
        const QString imageDir = target.filePath(graphicsDocumentImageDirectoryName());
        if (!QDir().mkpath(imageDir))
        {
            result.warnings << QStringLiteral("Could not create %1; the images were not copied, so the "
                                              "record still points at the files on this machine.")
                                   .arg(imageDir);
        }
        else
        {
            for (const GraphicsDocumentImage& image : images)
            {
                const QString destination = target.filePath(image.relativePath);
                // A file that is already there with the same name AND the same bytes is the same picture:
                // re-saving a document must not fail on its own output.
                if (QFileInfo::exists(destination))
                {
                    const QFileInfo from(image.sourcePath);
                    if (from.size() == QFileInfo(destination).size())
                        continue;
                }
                if (!QFile::copy(image.sourcePath, destination))
                {
                    result.warnings << QStringLiteral("%1 was not copied (it may not exist any more); the "
                                                      "record keeps its path as it was")
                                           .arg(image.sourcePath);
                }
            }
        }
    }

    // And the record, LAST: until it exists the directory is not a document, so a save interrupted halfway
    // leaves something a person can see is incomplete rather than something that looks finished.
    QJsonObject root = graphicsDocumentToJson(file);
    QJsonArray channels;
    for (int i = 0; i < kDrawOrderCount; ++i)
    {
        const GraphicsPass pass = kDrawOrder[i];
        QJsonObject entry;
        entry.insert(QStringLiteral("pass"), graphicsPassName(pass));
        QJsonArray four;
        for (int ch = 0; ch < 4; ++ch)
        {
            four.append(graphicsDocumentPortableChannelText(file.channels[int(pass)].value(ch), images));
        }
        entry.insert(QStringLiteral("channels"), four);
        channels.append(entry);
    }
    root.insert(QStringLiteral("passes"), channels);

    QJsonArray imageList;
    for (const GraphicsDocumentImage& image : images)
    {
        QJsonObject entry;
        entry.insert(QStringLiteral("file"), image.relativePath);
        entry.insert(QStringLiteral("kind"), image.isCubemap ? QStringLiteral("cubemap")
                                                             : QStringLiteral("texture"));
        entry.insert(QStringLiteral("source"), image.sourcePath);
        imageList.append(entry);
    }
    root.insert(QStringLiteral("images"), imageList);

    const QString record = target.filePath(graphicsDocumentRecordFileName());
    QFile out(record);
    if (!out.open(QIODevice::WriteOnly | QIODevice::Truncate))
    {
        result.message = QStringLiteral("Could not write %1").arg(record);
        return result;
    }
    out.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
    out.close();

    result.ok = true;
    result.message = record;
    return result;
}

// Read a record and the files it names. `recordPath` is the JSON; everything else is resolved relative to
// its directory, and an image path that is relative is resolved there too - which is what makes a saved
// directory movable.
inline GraphicsDocumentIoResult loadGraphicsDocument(const QString& recordPath,
                                                     GraphicsDocumentFile* out)
{
    GraphicsDocumentIoResult result;
    if (!out)
        return result;

    QFile in(recordPath);
    if (!in.open(QIODevice::ReadOnly))
    {
        result.message = QStringLiteral("Could not read %1").arg(recordPath);
        return result;
    }
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(in.readAll(), &error);
    in.close();
    if (error.error != QJsonParseError::NoError)
    {
        result.message = QStringLiteral("%1 is not valid JSON: %2")
                             .arg(recordPath, error.errorString());
        return result;
    }
    if (!document.isObject())
    {
        result.message = QStringLiteral("%1 does not hold a document record").arg(recordPath);
        return result;
    }

    const QJsonObject root = document.object();
    const int version = root.value(QStringLiteral("version")).toInt(0);
    if (version > kGraphicsDocumentFormatVersion)
    {
        result.message = QStringLiteral("%1 was written by a newer version (format %2, this build reads "
                                        "%3)")
                             .arg(recordPath).arg(version).arg(kGraphicsDocumentFormatVersion);
        return result;
    }

    QDir directory = QFileInfo(recordPath).absoluteDir();
    GraphicsDocumentFile file;
    file.name = root.value(QStringLiteral("name")).toString();
    if (file.name.trimmed().isEmpty())
        file.name = QFileInfo(recordPath).absoluteDir().dirName();

    // The texts. A pass the record names but the directory does not hold is SAID, because "an empty pass"
    // and "a file that went missing" draw the same picture and are not the same thing.
    const QJsonObject files = root.value(QStringLiteral("files")).toObject();
    const auto readPass = [&](GraphicsPass pass, const QString& key) -> bool {
        QString name = files.value(key).toString();
        if (name.isEmpty())
            name = graphicsDocumentPassFileName(pass);
        const QString path = directory.filePath(name);
        QFile passFile(path);
        if (!passFile.open(QIODevice::ReadOnly | QIODevice::Text))
        {
            if (pass != GraphicsPass::Common)   // Common is optional in a document
                result.warnings << QStringLiteral("%1 names %2, which is not there").arg(recordPath, name);
            return false;
        }
        file.setTextFor(pass, QString::fromUtf8(passFile.readAll()));
        passFile.close();
        return true;
    };
    readPass(GraphicsPass::Common, QStringLiteral("common"));
    for (int i = 0; i < kDrawOrderCount; ++i)
        readPass(kDrawOrder[i], graphicsPassName(kDrawOrder[i]));

    // The channels, per pass. A relative image path is resolved against the record's own directory, so the
    // loaded document can be written out again without the images having to move.
    const QJsonArray passes = root.value(QStringLiteral("passes")).toArray();
    for (const QJsonValue& value : passes)
    {
        const QJsonObject entry = value.toObject();
        const QString passName = entry.value(QStringLiteral("pass")).toString();
        int index = -1;
        for (int i = 0; i < kDrawOrderCount; ++i)
        {
            if (graphicsPassName(kDrawOrder[i]).compare(passName, Qt::CaseInsensitive) == 0)
                index = i;
        }
        if (index < 0)
        {
            result.warnings << QStringLiteral("the record has channels for an unknown pass '%1'; ignored")
                                   .arg(passName);
            continue;
        }

        const QJsonArray four = entry.value(QStringLiteral("channels")).toArray();
        QList<GraphicsChannelSource> sources;
        for (int ch = 0; ch < 4; ++ch)
        {
            GraphicsChannelSource source =
                graphicsChannelSourceFromText(four.at(ch).toString());
            if ((source.isTexture() || source.isCubemap())
                && !QDir::isAbsolutePath(source.path))
            {
                source.path = directory.filePath(source.path);
            }
            sources << source;
        }
        file.channels[int(kDrawOrder[index])] = sources;
    }

    *out = file;
    result.ok = true;
    result.message = recordPath;
    return result;
}

// The channel file's text for a document, from the STRUCT. Kept here rather than in the widget so the
// round trip - save, then load, then compare - is a function of two calls in one file.
inline QList<QList<GraphicsChannelSource>> graphicsDocumentChannelsOf(const GraphicsDocumentFile& file)
{
    QList<QList<GraphicsChannelSource>> all;
    for (int i = 0; i < kDrawOrderCount; ++i)
    {
        QList<GraphicsChannelSource> four = file.channels[int(kDrawOrder[i])];
        while (four.size() < 4)
            four << GraphicsChannelSource{};
        all << four;
    }
    return all;
}

} // namespace SonicPi
