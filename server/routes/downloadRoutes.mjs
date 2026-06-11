/**
 * Download Studio via yt-dlp: releases list, ricerca, avvio/cancel download.
 * Estratto da index.mjs (Fase 6).
 */
import { parseYtdlpJsonStdout } from "../catalogWebPreview.mjs";
import { accountIdFromReq, actLog, sendError, sendOk } from "../httpUtils.mjs";
import { getLibraryIndex, invalidateLibraryIndex } from "../libraryIndexService.mjs";
import {
  readLibrarySelection,
  sanitizeLibrarySelection,
  writeLibrarySelection,
} from "../librarySelection.mjs";
import { getDefaultAccountId, getMusicRoot } from "../musicRootConfig.mjs";
import { safeRelSeg } from "../pathSafety.mjs";
import { fetchYoutubeMusicBrowseReleasesList } from "../youtubeMusicBrowse.mjs";
import { searchYoutubeMusicCatalog } from "../youtubeMusicSearch.mjs";
import { fetchYoutubeWebReleasesList, isYoutubeWebReleasesPageUrl } from "../youtubeWebReleasesInnertube.mjs";
import { resolveYtdlpPath } from "../ytdlpPath.mjs";
import {
  STUDIO_DOWNLOAD_KINDS,
  YTDLP_ROLL_LOG_CAP_CHARS,
  activeYtdlpDownloads,
  appendRollingCapped,
  buildStudioDownloadYtdlpArgs,
  buildYoutubeReleasesListEntries,
  coerceYtdlpUrl,
  enrichReleaseEntriesInOrder,
  enrichReleaseEntriesWithTrackCounts,
  extractLastItemProgress,
  forceKillStudioYtdlp,
  isAllowedYtdlpDownloadUrl,
  isUuidDownloadId,
  releaseEnrichConfig,
  trimLogForNdjson,
  winHideExec,
  writeYoutubeReleasesNdjsonLine,
  ytdlpArgsBase,
  ytdlpChildExecOptions,
  ytdlpCmdDisplay,
  ytdlpCookieArgs,
  ytdlpCookieArgsForDisplay,
  ytdlpCookiesConfigured,
  ytdlpItemSummaryFromLog,
  ytdlpJavascriptArgs,
  ytdlpPlaylistTrackCount,
} from "../ytdlpStudio.mjs";
import { execFile, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
async function attachStudioDownloadToLibrarySelection(req, root, outputDirRel) {
  const prefix =
    outputDirRel != null && String(outputDirRel).trim().length > 0
      ? String(outputDirRel).replace(/\\/g, "/").replace(/\/+$/, "")
      : "";
  if (!prefix) return;
  try {
    const accountId = accountIdFromReq(req);
    let cur = await readLibrarySelection(root, accountId);
    if (!cur) {
      cur = sanitizeLibrarySelection(
        accountId === getDefaultAccountId()
          ? { includeAll: true }
          : { includeAll: false }
      );
    }
    if (cur.includeAll) return;

    const full = await getLibraryIndex(root);
    const toAddAlbums = new Set();
    const toAddArtists = new Set();
    for (const al of full.albums) {
      const rel = al.relPath;
      if (!rel) continue;
      if (rel === prefix || rel.startsWith(`${prefix}/`)) {
        toAddAlbums.add(rel);
        const id = al.artistId || al.artist;
        if (id) toAddArtists.add(id);
      }
    }
    if (!toAddAlbums.size) return;

    const albums = new Set([...cur.albums, ...toAddAlbums]);
    const artists = new Set([...cur.artists, ...toAddArtists]);
    const next = sanitizeLibrarySelection({
      includeAll: false,
      artists: [...artists],
      albums: [...albums],
      tracks: cur.tracks,
    });
    await writeLibrarySelection(root, accountId, next);
  } catch (e) {
    console.error("attachStudioDownloadToLibrarySelection", e);
  }
}

function isYoutubeReleasesTabUrl(value) {
  try {
    const u = new URL(String(value).trim());
    const h = u.hostname.replace(/^www\./, "").toLowerCase();
    if (!h.endsWith("youtube.com") && !h.endsWith("music.youtube.com")) {
      return false;
    }
    return u.pathname.includes("/releases");
  } catch {
    return false;
  }
}

/** Pagina «Album» / browse su YouTube Music (elenco album per artista). */
function isYoutubeMusicBrowseUrl(value) {
  try {
    const u = new URL(String(value).trim());
    const h = u.hostname.replace(/^www\./, "").toLowerCase();
    if (!h.endsWith("music.youtube.com")) return false;
    return u.pathname.includes("/browse") || u.pathname.includes("/channel/");
  } catch {
    return false;
  }
}

function isYoutubeMultiAlbumListUrl(value) {
  return isYoutubeReleasesTabUrl(value) || isYoutubeMusicBrowseUrl(value);
}

export function registerDownloadRoutes(app) {
  app.post("/api/youtube-releases-list", async (req, res) => {
    if (process.env.ENABLE_YTDLP === "0") {
      return sendError(res, 403, "Download disabled (ENABLE_YTDLP=0)");
    }
    const url = coerceYtdlpUrl(String(req.body?.url ?? ""));
    if (!/^https?:\/\//i.test(url)) {
      return sendError(res, 400, "Invalid URL");
    }
    if (!isYoutubeMultiAlbumListUrl(url)) {
      return sendError(
        res,
        400,
        "URL must be a YouTube /releases tab or a YouTube Music /browse/… album list page."
      );
    }
    const program = resolveYtdlpPath();
    try {
      let data = null;
      if (isYoutubeMusicBrowseUrl(url)) {
        const ytm = await fetchYoutubeMusicBrowseReleasesList(url);
        if (ytm.error) {
          return sendError(res, 400, String(ytm.error));
        }
        if (!ytm.entries.length) {
          return sendError(
            res,
            400,
            "No releases found on this YouTube Music browse page (Innertube)."
          );
        }
        data = {
          entries: ytm.entries,
          title: ytm.title,
          uploader: ytm.uploader,
          channel_url: ytm.channel_url,
        };
      } else {
        const preferInnertube =
          String(process.env.REKORD_YT_WEB_RELEASES_INNERTUBE ?? "1").trim() !==
          "0";
        if (preferInnertube && isYoutubeWebReleasesPageUrl(url)) {
          try {
            const web = await fetchYoutubeWebReleasesList(url);
            if (!web.error && web.entries.length) {
              data = {
                entries: web.entries,
                title: web.title,
                uploader: web.uploader,
                channel_url: web.channel_url,
              };
            }
          } catch {
            /* yt-dlp sotto */
          }
        }
        if (!data) {
          const args = [
            "-J",
            "--flat-playlist",
            "--no-download",
            "--no-warnings",
            ...ytdlpJavascriptArgs(),
            ...ytdlpCookieArgs(),
            url,
          ];
          let jsonText = "";
          try {
            ({ stdout: jsonText } = await execFileAsync(program, args, {
              maxBuffer: 32 * 1024 * 1024,
              encoding: "utf8",
              ...ytdlpChildExecOptions(),
            }));
          } catch {
            return sendError(res, 500, "yt-dlp failed");
          }
          data = parseYtdlpJsonStdout(jsonText);
          if (!data) {
            return sendError(res, 500, "yt-dlp returned no parseable JSON");
          }
        }
      }
      const { entries, listTitle, uploader, channelUrl } =
        buildYoutubeReleasesListEntries(data);
      if (!entries.length) {
        return sendError(
          res,
          400,
          "No releases in list (or yt-dlp could not expand this page)."
        );
      }
      const wantStream = Boolean(req.body?.stream);
      if (wantStream) {
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no");
        if (typeof res.flushHeaders === "function") res.flushHeaders();
        const wantEnrichCounts = Boolean(req.body?.enrichCounts);
        const { max, timeoutMs, concurrency } = releaseEnrichConfig();
        try {
          writeYoutubeReleasesNdjsonLine(res, {
            type: "meta",
            listTitle,
            uploader,
            channelUrl,
            total: entries.length,
          });
          for (const entry of entries) {
            writeYoutubeReleasesNdjsonLine(res, {
              type: "entry",
              entry: { ...entry, trackCount: null },
            });
          }
          writeYoutubeReleasesNdjsonLine(res, { type: "list_ready" });
          if (wantEnrichCounts) {
            await enrichReleaseEntriesInOrder(
              program,
              entries,
              max,
              timeoutMs,
              concurrency,
              (entry) => {
                writeYoutubeReleasesNdjsonLine(res, { type: "entry_patch", entry });
              }
            );
          }
          writeYoutubeReleasesNdjsonLine(res, { type: "done" });
          res.end();
        } catch (err) {
          writeYoutubeReleasesNdjsonLine(res, {
            type: "error",
            message: String(err?.message ?? err).slice(0, 2_000),
          });
          res.end();
        }
        return;
      }
      const entriesWithCounts = await enrichReleaseEntriesWithTrackCounts(
        program,
        entries
      );
      return sendOk(res, {
        listTitle,
        uploader,
        channelUrl,
        entries: entriesWithCounts,
      });
    } catch (error) {
      let err = String(error?.message ?? error);
      if (error && typeof error === "object") {
        if ("stderr" in error && error.stderr) {
          const s = error.stderr;
          err = Buffer.isBuffer(s) ? s.toString("utf8") : String(s);
        } else if ("stdout" in error && error.stdout) {
          const s = error.stdout;
          err = Buffer.isBuffer(s) ? s.toString("utf8") : String(s);
        }
      }
      err = err.trim() || "yt-dlp failed";
      return sendError(
        res,
        500,
        err.length > 800 ? `${err.slice(0, 797)}…` : err
      );
    }
  });

  app.post("/api/youtube-explore-search", async (req, res) => {
    if (process.env.ENABLE_YTDLP === "0") {
      return sendError(res, 403, "Download disabled (ENABLE_YTDLP=0)");
    }
    const query = String(req.body?.query ?? "").trim();
    if (!query) {
      return sendError(res, 400, "Query required");
    }
    try {
      const { results, error } = await searchYoutubeMusicCatalog(query);
      if (error) {
        return sendError(res, 400, error);
      }
      return sendOk(res, { results });
    } catch (err) {
      return sendError(
        res,
        500,
        String(err?.message ?? err).slice(0, 800) || "Search failed",
      );
    }
  });

  app.get("/api/download-preset", async (_req, res) => {
    try {
      return sendOk(res, {
        found: true,
        file: null,
        text: ytdlpCmdDisplay(),
        program: resolveYtdlpPath(),
        cookiesConfigured: ytdlpCookiesConfigured(),
        args: [
          ...ytdlpArgsBase(),
          ...ytdlpJavascriptArgs(),
          ...ytdlpCookieArgsForDisplay(),
          "-o",
          "%(playlist_title)s/%(playlist_index)02d - %(title)s.%(ext)s",
        ],
        exampleUrl: null,
      });
    } catch (error) {
      return sendError(res, 500, String(error?.message || error));
    }
  });

  app.post("/api/download-cancel", (req, res) => {
    const downloadId = String(req.body?.downloadId ?? "").trim();
    if (!isUuidDownloadId(downloadId)) {
      return sendError(res, 400, "Invalid downloadId");
    }
    const entry = activeYtdlpDownloads.get(downloadId);
    if (!entry?.child) {
      return sendError(res, 404, "No active download");
    }
    entry.userCancelled = true;
    if (process.platform === "win32") {
      forceKillStudioYtdlp(entry.child);
    } else {
      try {
        entry.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      if (entry.killTimer) clearTimeout(entry.killTimer);
      entry.killTimer = setTimeout(() => {
        try {
          if (entry.child && !entry.child.killed) entry.child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 4500);
    }
    return sendOk(res, { ok: true });
  });

  app.post("/api/download-flat-count", async (req, res) => {
    if (process.env.ENABLE_YTDLP === "0") {
      return sendError(res, 403, "Download disabled (ENABLE_YTDLP=0)");
    }
    const url = coerceYtdlpUrl(String(req.body?.url ?? ""));
    if (!/^https?:\/\//i.test(url))
      return sendError(res, 400, "Provide a valid http(s) URL");
    if (!isAllowedYtdlpDownloadUrl(url))
      return sendError(res, 400, "URL host not allowed for downloads");
    try {
      const program = resolveYtdlpPath();
      const { timeoutMs } = releaseEnrichConfig();
      const count = await ytdlpPlaylistTrackCount(
        program,
        url,
        Math.max(timeoutMs, 60_000)
      );
      if (count == null)
        return sendError(res, 502, "Could not resolve item count (yt-dlp)");
      return sendOk(res, { count });
    } catch (e) {
      return sendError(res, 500, String(e?.message ?? e));
    }
  });

  app.post("/api/download", async (req, res) => {
    if (process.env.ENABLE_YTDLP === "0")
      return sendError(res, 403, "Download disabled (ENABLE_YTDLP=0)");
    let url = coerceYtdlpUrl(String(req.body?.url ?? ""));
    if (!/^https?:\/\//i.test(url))
      return sendError(res, 400, "Provide a valid http(s) URL");
    if (!isAllowedYtdlpDownloadUrl(url))
      return sendError(res, 400, "URL host not allowed for downloads");
    const downloadId = String(req.body?.downloadId ?? "").trim();
    if (!isUuidDownloadId(downloadId)) {
      return sendError(res, 400, "Invalid or missing downloadId (UUID)");
    }
    if (activeYtdlpDownloads.has(downloadId)) {
      return sendError(res, 409, "downloadId already in use");
    }
    let downloadKind = String(req.body?.downloadKind ?? "").trim();
    if (!STUDIO_DOWNLOAD_KINDS.has(downloadKind))
      downloadKind = "download_unknown";
    try {
      const root = getMusicRoot();
      const outputDirForLog = safeRelSeg(String(req.body?.outputDir || ""));
      const program = resolveYtdlpPath();
      const args = [...buildStudioDownloadYtdlpArgs(url, downloadKind, outputDirForLog), url];
      const stderrAcc = { buffer: "", totalChars: 0 };
      const stdoutAcc = { buffer: "", totalChars: 0 };
      let resultCode = -1;
      const command = `${program} ${args
      .map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
      .join(" ")}`;
      const entry = {
        userCancelled: false,
        child: /** @type {import("child_process").ChildProcess | null} */ (null),
        killTimer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
      };
      activeYtdlpDownloads.set(downloadId, entry);
      res.status(200);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("Connection", "close");
      try {
        req.socket?.setNoDelay?.(true);
      } catch {
        /* ignore */
      }
      let keepAliveTimer = /** @type {ReturnType<typeof setInterval> | null} */ (
        null
      );
      const clearKeepAlive = () => {
        if (keepAliveTimer != null) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
      };
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      res.write(`${JSON.stringify({ type: "started" })}\n`);
      let responded = false;
      let lastProgressEmitted = null;
      const finish = (fn) => {
        if (responded) return;
        responded = true;
        clearKeepAlive();
        fn();
      };
      const emitProgressIfNew = () => {
        if (responded) return;
        const p = extractLastItemProgress(
          `${stderrAcc.buffer}\n${stdoutAcc.buffer}`
        );
        if (
          p &&
          (lastProgressEmitted?.current !== p.current ||
            lastProgressEmitted?.total !== p.total)
        ) {
          lastProgressEmitted = p;
          res.write(`${JSON.stringify({ type: "progress", progress: p })}\n`);
        }
      };
      const child = spawn(program, args, {
        cwd: root,
        env: { ...process.env, FORCE_COLOR: "0" },
        ...winHideExec(),
      });
      entry.child = child;
      const killYtdlpOnDisconnect = () => {
        forceKillStudioYtdlp(child);
      };
      const onClientGone = () => {
        if (responded) return;
        killYtdlpOnDisconnect();
      };
      req.on("aborted", onClientGone);
      res.on("close", onClientGone);
      const removeDisconnectListeners = () => {
        req.removeListener("aborted", onClientGone);
        res.removeListener("close", onClientGone);
      };
      keepAliveTimer = setInterval(() => {
        if (responded || res.writableEnded) {
          clearKeepAlive();
          return;
        }
        try {
          res.write(`${JSON.stringify({ type: "keepalive" })}\n`);
        } catch {
          clearKeepAlive();
        }
      }, 5000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        appendRollingCapped(stdoutAcc, chunk, YTDLP_ROLL_LOG_CAP_CHARS);
        emitProgressIfNew();
      });
      child.stderr.on("data", (chunk) => {
        appendRollingCapped(stderrAcc, chunk, YTDLP_ROLL_LOG_CAP_CHARS);
        emitProgressIfNew();
      });
      child.on("close", async (code) => {
        removeDisconnectListeners();
        const reg = activeYtdlpDownloads.get(downloadId);
        const cancelled = Boolean(reg?.userCancelled);
        if (reg?.killTimer) clearTimeout(reg.killTimer);
        activeYtdlpDownloads.delete(downloadId);
        resultCode = code ?? -1;
        let postDownloadError = null;
        const shouldPostProcess = resultCode === 0;
        if (shouldPostProcess) {
          const folder =
            outputDirForLog && outputDirForLog.length > 0
              ? outputDirForLog.replace(/\\/g, "/")
              : ".";
          const u = url.length > 500 ? `${url.slice(0, 497)}…` : url;
          void actLog(req, {
            kind: "studio",
            action: downloadKind,
            folder,
            detail: u,
          });
        }
        const combined = `${stderrAcc.buffer}\n${stdoutAcc.buffer}`;
        const ot = trimLogForNdjson(stdoutAcc);
        const oe = trimLogForNdjson(stderrAcc);
        const progress = extractLastItemProgress(combined) ?? lastProgressEmitted;
        const itemSummary = ytdlpItemSummaryFromLog(stdoutAcc.buffer, stderrAcc.buffer);
        finish(() => {
          try {
            if (
              itemSummary.downloadedItems.length ||
              itemSummary.skippedItems.length ||
              itemSummary.failedItems.length
            ) {
              res.write(`${JSON.stringify({ type: "items", ...itemSummary })}\n`);
            }
            const line = `${JSON.stringify({
            type: "done",
            ok: resultCode === 0,
            cancelled,
            stdout: ot.text,
            stderr: oe.text,
            logTruncated: Boolean(ot.truncated || oe.truncated),
            stdoutTotalChars: ot.totalChars,
            stderrTotalChars: oe.totalChars,
            code: resultCode,
            progress,
            postDownloadError: postDownloadError
              ? String(postDownloadError?.message || postDownloadError)
              : null,
            musicRoot: root,
            command,
            ...itemSummary,
          })}\n`;
            if (!res.writableEnded) res.write(line);
            if (!res.writableEnded) res.end();
          } catch {
            /* client già disconnesso */
          }
        });
        if (shouldPostProcess) {
          void (async () => {
            try {
              await invalidateLibraryIndex(root);
              await attachStudioDownloadToLibrarySelection(req, root, outputDirForLog);
            } catch (error) {
              console.error(
                "[rekord] post-download library refresh:",
                error?.message || error,
              );
            }
          })();
        }
      });
      child.on("error", (error) => {
        removeDisconnectListeners();
        const reg = activeYtdlpDownloads.get(downloadId);
        if (reg?.killTimer) clearTimeout(reg.killTimer);
        activeYtdlpDownloads.delete(downloadId);
        resultCode = -1;
        appendRollingCapped(
          stderrAcc,
          `\n${error.message}`,
          YTDLP_ROLL_LOG_CAP_CHARS
        );
        const ot = trimLogForNdjson(stdoutAcc);
        const oe = trimLogForNdjson(stderrAcc);
        const itemSummary = ytdlpItemSummaryFromLog(stdoutAcc.buffer, stderrAcc.buffer);
        finish(() => {
          try {
            if (
              itemSummary.downloadedItems.length ||
              itemSummary.skippedItems.length ||
              itemSummary.failedItems.length
            ) {
              res.write(`${JSON.stringify({ type: "items", ...itemSummary })}\n`);
            }
            const line = `${JSON.stringify({
            type: "done",
            ok: false,
            cancelled: false,
            stdout: ot.text,
            stderr: oe.text,
            logTruncated: Boolean(ot.truncated || oe.truncated),
            stdoutTotalChars: ot.totalChars,
            stderrTotalChars: oe.totalChars,
            code: resultCode,
            progress: lastProgressEmitted,
            error: error.message,
            musicRoot: root,
            command,
            ...itemSummary,
          })}\n`;
            if (!res.writableEnded) res.write(line);
            if (!res.writableEnded) res.end();
          } catch {
            /* client già disconnesso */
          }
        });
      });
    } catch (error) {
      activeYtdlpDownloads.delete(downloadId);
      return sendError(res, 500, String(error?.message || error));
    }
  });

}
