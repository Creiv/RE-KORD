//! "Lettura metadati incorporati": a background job that reads the tags of
//! tracks indexed before the embedded reader existed (upgrade from 5.0), or
//! again after "re-read embedded tags" or a change of the settings, and
//! looks for embedded pictures of albums without a cover.
//!
//! - throttled: small batches, a pause between them, and none at all while a
//!   scan runs (the scan reads changed files itself);
//! - resumable: progress is the per-track `tags_version` and per-album
//!   `embedded_cover_from`, so a restart (or a cancel) continues later;
//! - cheap per file: tags only, no pictures, no duration (already known).

use super::tags::{read_file, read_picture, ReadRequest};
use super::{cover, EmbeddedOptions, MergePolicy, TAGS_VERSION};
use crate::db::Db;
use crate::state::AppState;
use anyhow::Result;
use serde::Serialize;
use std::collections::BTreeSet;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tracing::{info, warn};

/// Tracks per batch (one transaction each).
const BATCH: usize = 32;
/// Albums per cover batch.
const COVER_BATCH: usize = 8;
/// Pause between batches.
const PAUSE: Duration = Duration::from_millis(40);
/// Tracks of an album opened at most to find a picture.
const COVER_FILES: usize = 3;
/// `library_meta` key: the pending re-read may replace typed values.
pub const OVERRIDE_META_KEY: &str = "embedded_reread_override";

/// What the admin panel shows about embedded metadata.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedStatus {
    pub enabled: bool,
    pub priority: super::EmbeddedPriority,
    /// Tracks whose tags are still to be read.
    pub pending_tracks: u64,
    /// Albums without a cover still to be looked at for a picture.
    pub pending_albums: u64,
    pub running: bool,
    /// The pending re-read also replaces values typed in Studio.
    pub override_studio: bool,
    /// "Incorpora tag e copertina nei file scaricati".
    pub embed_downloads: bool,
}

pub fn status(state: &AppState) -> Result<EmbeddedStatus> {
    let settings = state.config.lock().unwrap().embedded;
    let (pending_tracks, pending_albums) = state.db.embedded_pending(TAGS_VERSION)?;
    Ok(EmbeddedStatus {
        enabled: settings.enabled,
        priority: settings.priority,
        pending_tracks,
        pending_albums,
        running: state.embedded_backfill.load(Ordering::SeqCst),
        override_studio: state.db.get_meta(OVERRIDE_META_KEY)?.as_deref() == Some("1"),
        embed_downloads: settings.embed_downloads,
    })
}

/// At startup: once the initial scan settled, read what 5.0 never read.
pub fn spawn_if_needed(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        while state.is_scanning() {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        if !state.config.lock().unwrap().embedded.enabled {
            return;
        }
        match state.db.embedded_pending(TAGS_VERSION) {
            Ok((0, 0)) => {}
            Ok(_) => {
                start(&state);
            }
            Err(e) => warn!(error = %e, "embedded backfill: cannot count pending tracks"),
        }
    });
}

/// Read everything again (admin "Rileggi metadati incorporati", or a
/// settings change). `override_studio` lets the tags replace values typed
/// in Studio too; it only applies with the embedded priority.
pub fn request_reread(state: &AppState, override_studio: bool) -> Result<()> {
    state.db.reset_embedded_markers()?;
    state
        .db
        .set_meta(OVERRIDE_META_KEY, if override_studio { "1" } else { "" })?;
    state.embedded_reread_gen.fetch_add(1, Ordering::SeqCst);
    start(state);
    Ok(())
}

/// Start the job unless it is running (a running job picks up new work
/// before it ends). Returns whether a new job was started.
pub fn start(state: &AppState) -> bool {
    if state
        .embedded_backfill
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            let outcome = run(&state).await;
            state.embedded_backfill.store(false, Ordering::SeqCst);
            match outcome {
                Err(e) => {
                    warn!(error = %e, "embedded metadata backfill failed");
                    return;
                }
                // Canceled: the rest waits for the next start of the hub.
                Ok(true) => return,
                Ok(false) => {}
            }
            // Work queued between the last check and the flag going down.
            let more = state
                .db
                .embedded_pending(TAGS_VERSION)
                .map(|(t, a)| t + a > 0)
                .unwrap_or(false);
            if !more
                || state
                    .embedded_backfill
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
            {
                return;
            }
        }
    });
    true
}

#[derive(Debug, Default, Clone, Copy)]
struct Counts {
    tracks: u64,
    covers: u64,
    done: u64,
}

/// One pass over everything pending. Returns whether it was canceled.
async fn run(state: &AppState) -> Result<bool> {
    let (pending_tracks, pending_albums) = state.db.embedded_pending(TAGS_VERSION)?;
    if pending_tracks + pending_albums == 0 {
        return Ok(false);
    }
    // Settings and the override choice are read again before every batch:
    // a change while the job runs (priority back to Studio, reader off)
    // must apply to the rest, not be overridden by the old choice.
    let (mut opts, mut policy, mut gen) = current_policy(state)?;
    let job = state.jobs.start_coded(
        "embeddedTags",
        "Lettura metadati incorporati",
        "embeddedTags.title",
        serde_json::Value::Null,
        true,
    );
    let total = (pending_tracks + pending_albums).max(1);
    let mut counts = Counts::default();
    info!(
        tracks = pending_tracks,
        albums = pending_albums,
        enabled = opts.enabled,
        priority = opts.priority.as_str(),
        override_user = policy.override_user,
        "embedded metadata backfill started"
    );

    let mut canceled = false;
    // Tracks first: album titles / dates / genres come from them.
    loop {
        if job.is_canceled() {
            canceled = true;
            break;
        }
        wait_while_scanning(state).await;
        if !music_root_available(state) {
            // Unplugged drive / unmounted share: nothing is marked as read,
            // the rest waits for the next start.
            warn!("embedded metadata backfill paused: music folder unavailable");
            canceled = true;
            break;
        }
        (opts, policy, gen) = current_policy(state)?;
        let db = state.db.clone();
        let opts_b = opts.clone();
        let read = tokio::task::spawn_blocking(move || tag_batch(&db, &opts_b, policy)).await??;
        if read == 0 {
            break;
        }
        counts.tracks += read as u64;
        counts.done += read as u64;
        progress(&job, counts, total);
        tokio::time::sleep(PAUSE).await;
    }
    while !canceled {
        if job.is_canceled() {
            canceled = true;
            break;
        }
        wait_while_scanning(state).await;
        if !music_root_available(state) {
            warn!("embedded metadata backfill paused: music folder unavailable");
            canceled = true;
            break;
        }
        opts = state.embedded_options();
        let db = state.db.clone();
        let opts_b = opts.clone();
        let (seen, found) =
            tokio::task::spawn_blocking(move || cover_batch(&db, &opts_b)).await??;
        if seen == 0 {
            break;
        }
        counts.covers += found as u64;
        counts.done += seen as u64;
        progress(&job, counts, total);
        tokio::time::sleep(PAUSE).await;
    }

    // Derived data, once, for everything this run touched. Not during a
    // scan: its covers saved but not yet recorded would look unused.
    wait_while_scanning(state).await;
    let db = state.db.clone();
    let store = opts.cover_store.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        db.rebuild_fts()?;
        db.rebuild_genres()?;
        db.bump_index_epoch()?;
        if let Some(store) = store {
            crate::scan::prune_embedded_covers(&db, &store);
        }
        Ok(())
    })
    .await??;
    let params = serde_json::json!({ "tracks": counts.tracks, "covers": counts.covers });
    if canceled {
        job.finish_coded(
            "embeddedTags.canceled",
            params,
            format!("annullato dopo {} brani", counts.tracks),
        );
    } else {
        // A newer request (maybe with the override) keeps its flag.
        if state.embedded_reread_gen.load(Ordering::SeqCst) == gen {
            state.db.set_meta(OVERRIDE_META_KEY, "")?;
        }
        job.finish_coded(
            "embeddedTags.done",
            params,
            format!(
                "{} brani letti, {} copertine incorporate",
                counts.tracks, counts.covers
            ),
        );
    }
    info!(
        tracks = counts.tracks,
        covers = counts.covers,
        canceled,
        "embedded metadata backfill finished"
    );
    Ok(canceled)
}

/// Reader options and merge policy as set now, with the re-read generation
/// they belong to.
fn current_policy(state: &AppState) -> Result<(EmbeddedOptions, MergePolicy, u64)> {
    let gen = state.embedded_reread_gen.load(Ordering::SeqCst);
    let opts = state.embedded_options();
    let override_user = state.db.get_meta(OVERRIDE_META_KEY)?.as_deref() == Some("1");
    let mut policy = opts.merge_policy();
    policy.override_user = override_user && policy.prefer_embedded;
    Ok((opts, policy, gen))
}

fn music_root_available(state: &AppState) -> bool {
    let root = state.config.lock().unwrap().music_root.clone();
    root.is_some_and(|r| r.is_dir())
}

fn progress(job: &crate::jobs::JobHandle, c: Counts, total: u64) {
    job.progress_coded(
        (c.done as f32 / total as f32).min(1.0),
        "embeddedTags.progress",
        serde_json::json!({ "done": c.done, "total": total, "covers": c.covers }),
        format!("{}/{total}", c.done),
    );
}

async fn wait_while_scanning(state: &AppState) {
    while state.is_scanning() {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Read and merge the next batch of tracks. Returns how many were handled.
pub fn tag_batch(db: &Db, opts: &EmbeddedOptions, policy: MergePolicy) -> Result<usize> {
    let batch = db.embedded_pending_tracks(TAGS_VERSION, BATCH)?;
    if batch.is_empty() {
        return Ok(0);
    }
    // File I/O first, without the database lock.
    let reads: Vec<Option<crate::scan::AudioMeta>> = batch
        .iter()
        .map(|t| {
            // Missing (the next scan removes it) or not readable (no
            // permission): nothing to merge, and nothing to wipe either.
            if std::fs::File::open(&t.file_path).is_err() {
                return None;
            }
            // Reader off: the values go back to what the file name gives,
            // nothing to parse (that would open every file for nothing).
            let tags = if opts.enabled {
                read_file(
                    &t.file_path,
                    ReadRequest {
                        tags: true,
                        picture: false,
                        properties: false,
                    },
                )
                .tags
            } else {
                Default::default()
            };
            let stem = t
                .file_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown");
            Some(crate::scan::resolve_meta(
                tags,
                stem,
                &t.artist_name,
                t.duration_ms,
            ))
        })
        .collect();
    let albums: BTreeSet<i64> = batch.iter().filter_map(|t| t.album_id).collect();
    let folders: Vec<(i64, String, bool)> = albums
        .iter()
        .filter_map(|id| {
            db.album_folder(*id)
                .ok()
                .flatten()
                .map(|(k, loose)| (*id, k, loose))
        })
        .collect();
    db.write_batch(|w| {
        for (t, meta) in batch.iter().zip(&reads) {
            // A scan may have rewritten (or removed) the track since it was
            // read: its values are newer, and a removed row must not come back.
            if !w.pending_track_unchanged(t, TAGS_VERSION)? {
                continue;
            }
            match meta {
                Some(meta) => {
                    w.upsert_track(&meta.track_row(crate::scan::RowPlace {
                        rel_path: &t.rel_path,
                        file_path: &t.file_path,
                        artist_name: &t.artist_name,
                        album_name: &t.album_name,
                        album_id: t.album_id,
                        artist_id: t.artist_id,
                        size: t.size,
                        mtime: t.mtime,
                        duration_ms: t.duration_ms,
                        policy,
                        write_file_state: false,
                    }))?;
                }
                None => w.mark_tags_version(t.id, TAGS_VERSION)?,
            }
        }
        for (id, folder_key, loose) in &folders {
            let folder = folder_key.rsplit('/').next().unwrap_or(folder_key);
            let title = if *loose {
                folder.to_string()
            } else {
                crate::db::text::album_display_title(folder)
            };
            w.sync_album_display(*id, &title, !loose)?;
            w.backfill_album_meta_from_tracks(*id, policy.prefer_embedded)?;
            w.refresh_album_genres(*id)?;
        }
        Ok(())
    })?;
    Ok(batch.len())
}

/// Look for pictures in the next albums without a cover. Returns
/// `(albums looked at, covers found)`.
pub fn cover_batch(db: &Db, opts: &EmbeddedOptions) -> Result<(usize, usize)> {
    let albums = db.embedded_pending_cover_albums(COVER_BATCH, COVER_FILES)?;
    let mut found = 0;
    for album in &albums {
        let mut saved = None;
        if let Some(store) = opts.covers() {
            let mut best: Option<(String, super::tags::EmbeddedPicture)> = None;
            for (rel, path) in &album.files {
                let Some(p) = read_picture(path) else {
                    continue;
                };
                let front = p.front;
                if best.as_ref().is_none_or(|(_, b)| front && !b.front) {
                    best = Some((rel.clone(), p));
                }
                if front {
                    break;
                }
            }
            if let Some((rel, picture)) = best {
                match cover::save(store, &album.folder_key, &picture.data) {
                    Ok(path) => saved = Some((path, rel)),
                    Err(err) => {
                        warn!(album = %album.folder_key, track = %rel, error = %err, "embedded cover skipped")
                    }
                }
            }
        }
        match &saved {
            Some((path, rel)) => {
                db.set_album_embedded_cover(album.id, Some((path, rel)))?;
                found += 1;
            }
            None => db.set_album_embedded_cover(album.id, None)?,
        }
    }
    Ok((albums.len(), found))
}
