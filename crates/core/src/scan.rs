use crate::cover::find_cover_in_dir;
use crate::db::{Db, TrackRow};
use crate::embedded::tags::{EmbeddedPicture, EmbeddedTags, ReadRequest};
use crate::embedded::EmbeddedOptions;
use crate::layout::{self, is_audio_name, is_excluded_dir, LibraryLayout, LOOSE_ALBUM_FOLDER};
use anyhow::{bail, Context, Result};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tracing::{info, warn};

const LOOSE_ALBUM: &str = LOOSE_ALBUM_FOLDER;
/// Guard against pathological trees / symlink loops while collecting album files.
const MAX_ALBUM_DEPTH: usize = 6;
/// Below this many vanished tracks the mass-deletion guard never triggers.
const MASS_PRUNE_MIN_TRACKS: u64 = 20;
/// Parked favorites / playlist entries whose file never came back are dropped
/// after this many days.
const PARKED_LINKS_TTL_DAYS: i64 = 365;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ScanMode {
    #[default]
    /// Upsert what is on disk and drop rows whose files disappeared, unless
    /// that would remove a suspicious share of the library (see [`ScanOptions`]).
    Incremental,
    /// Re-read every file's tags and drop vanished files without the
    /// mass-deletion guard: the explicit "yes, those files are really gone".
    /// Track ids, favorites and playlists are kept (nothing is wiped up front).
    Full,
}

impl ScanMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Incremental => "incremental",
            Self::Full => "full",
        }
    }

    pub fn from_query(value: Option<&str>) -> Self {
        match value.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            Some("full") | Some("rebuild") => Self::Full,
            _ => Self::Incremental,
        }
    }
}

/// Who asked for the scan; automatic scans are held to a stricter
/// mass-deletion guard because nobody is looking at the result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ScanTrigger {
    /// A person pressed "scan" (or restored a backup).
    #[default]
    Manual,
    /// Watcher, post-download or startup re-index.
    Automatic,
}

impl ScanTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Automatic => "automatic",
        }
    }

    /// Largest share of the indexed tracks an incremental scan may delete in one go.
    fn max_prune_fraction(self) -> f64 {
        match self {
            Self::Manual => 0.5,
            Self::Automatic => 0.25,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ScanOptions {
    pub mode: ScanMode,
    pub trigger: ScanTrigger,
    /// Embedded tags and covers (default: tags on, no cover store).
    pub embedded: EmbeddedOptions,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub scanned_files: u64,
    pub indexed_tracks: u64,
    /// Files whose size+mtime matched the previous scan (tags not re-read).
    pub unchanged: u64,
    pub skipped: u64,
    pub errors: u64,
    pub removed_tracks: u64,
    pub removed_albums: u64,
    pub removed_artists: u64,
    pub mode: String,
    #[serde(rename = "music_root")]
    pub music_root: String,
    /// Indexed tracks whose file was not found this time.
    pub missing_tracks: u64,
    /// Set when the mass-deletion guard kept the missing tracks in the catalog.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prune_skipped: Option<String>,
    /// Folders that could not be listed; their tracks were left untouched.
    pub unreadable_dirs: Vec<String>,
    /// Library index epoch after this scan.
    pub index_epoch: u64,
}

/// Incremental scan (default): safe to run repeatedly, keeps favorites/playlists.
pub fn scan_library(db: &Db, music_root: &Path) -> Result<ScanReport> {
    scan_library_with(db, music_root, ScanMode::Incremental)
}

/// Manual scan in the given mode.
pub fn scan_library_with(db: &Db, music_root: &Path, mode: ScanMode) -> Result<ScanReport> {
    scan_library_opts(
        db,
        music_root,
        ScanOptions {
            mode,
            trigger: ScanTrigger::Manual,
            ..Default::default()
        },
    )
}

pub fn scan_library_opts(db: &Db, music_root: &Path, opts: ScanOptions) -> Result<ScanReport> {
    let mode = opts.mode;
    if !music_root.is_dir() {
        bail!("music root is not a directory: {}", music_root.display());
    }

    let root = music_root
        .canonicalize()
        .with_context(|| format!("canonicalize {}", music_root.display()))?;
    let layout = layout::load_layout(&root);

    // An unreadable root (permissions, a NAS that dropped) must never look
    // like an empty library: that would prune everything.
    let collected = collect_groups(&root, &layout)?;

    // Full scans re-read every file, but still need the previous states to
    // tell a real change ("recently updated") from a forced re-read.
    let known_files = db.file_states()?;
    let force_reread = mode == ScanMode::Full;

    let mut stats = Stats::default();
    let mut seen: HashSet<String> = HashSet::new();
    let legacy_art = legacy_artwork_map(&root);

    for group in &collected.groups {
        if let Err(err) = index_group(
            db,
            group,
            &known_files,
            force_reread,
            &legacy_art,
            &opts.embedded,
            &mut seen,
            &mut stats,
        ) {
            stats.errors += 1;
            warn!(album = %group.folder_key, error = %err, "album index failed");
        }
    }

    // Whatever lives under a folder we could not list is "seen": we simply
    // do not know, so it is kept. An unreadable entry may also be a file
    // itself (dangling link to an unmounted drive, I/O error on stat).
    for prefix in &collected.unreadable {
        seen.insert(prefix.clone());
        for rel in db.track_rel_paths_under(prefix)? {
            seen.insert(rel);
        }
    }

    let scanned_files = stats.scanned;
    let trigger = opts.trigger;
    let outcome = db.prune_tracks_outside_guarded(&seen, |indexed, missing| {
        prune_guard(mode, trigger, scanned_files, indexed, missing)
    })?;
    let removed_tracks = outcome.removed;
    let mut removed_albums = 0u64;
    let mut removed_artists = 0u64;
    if let Some(reason) = &outcome.skipped {
        warn!(
            missing = outcome.missing,
            indexed = outcome.indexed,
            trigger = trigger.as_str(),
            reason = %reason,
            "scan kept vanished tracks (mass-deletion guard)"
        );
        db.set_meta("last_prune_skipped", reason)?;
    } else {
        removed_albums = db.prune_empty_albums()?;
        removed_artists = db.prune_empty_artists()?;
        db.set_meta("last_prune_skipped", "")?;
    }
    if let Err(err) = db.purge_parked_user_links(PARKED_LINKS_TTL_DAYS) {
        warn!(error = %err, "could not purge old parked user links");
    }

    db.rebuild_fts()?;
    db.refresh_counts()?;
    db.rebuild_genres()?;
    if let Some(store) = opts.embedded.cover_store.as_deref() {
        prune_embedded_covers(db, store);
    }

    let now = chrono::Utc::now().to_rfc3339();
    db.set_meta("last_scan_at", &now)?;
    db.set_meta("music_root", &root.to_string_lossy())?;
    db.set_meta("schema_scan", "folder-first-v4")?;
    db.set_meta("last_scan_mode", mode.as_str())?;
    let index_epoch = db.bump_index_epoch()?;
    crate::events::publish("library", serde_json::json!({ "indexEpoch": index_epoch }));

    info!(
        scanned_files = stats.scanned,
        indexed_tracks = stats.indexed,
        unchanged = stats.unchanged,
        skipped = stats.skipped,
        errors = stats.errors,
        removed_tracks,
        removed_albums,
        removed_artists,
        missing = outcome.missing,
        unreadable_dirs = collected.unreadable.len(),
        mode = mode.as_str(),
        trigger = trigger.as_str(),
        layout = layout.preferred_layout.as_str(),
        "library scan complete"
    );

    Ok(ScanReport {
        scanned_files: stats.scanned,
        indexed_tracks: stats.indexed,
        unchanged: stats.unchanged,
        skipped: stats.skipped,
        errors: stats.errors,
        removed_tracks,
        removed_albums,
        removed_artists,
        mode: mode.as_str().to_string(),
        music_root: root.to_string_lossy().into_owned(),
        missing_tracks: outcome.missing,
        prune_skipped: outcome.skipped,
        unreadable_dirs: collected.unreadable,
        index_epoch,
    })
}

/// Re-index one folder of the library (`artist` or `artist/album[/…]`), e.g.
/// right after a download into it. Only tracks under that folder can be
/// pruned; the rest of the catalog is untouched.
pub fn scan_subtree(
    db: &Db,
    music_root: &Path,
    rel_dir: &str,
    embedded: &EmbeddedOptions,
) -> Result<ScanReport> {
    let rel_dir = rel_dir.replace('\\', "/");
    let rel_dir = rel_dir.trim_matches('/');
    let parts: Vec<&str> = rel_dir.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || parts.iter().any(|p| *p == ".." || *p == ".") {
        bail!("invalid folder: {rel_dir}");
    }
    let root = music_root
        .canonicalize()
        .with_context(|| format!("canonicalize {}", music_root.display()))?;
    let layout = layout::load_layout(&root);
    let mut collected = Collected::default();
    let artist = parts[0];
    // The prefix whose tracks this scan is responsible for.
    let prefix = if parts.len() == 1 {
        artist.to_string()
    } else {
        format!("{artist}/{}", parts[1])
    };
    let dir = root.join(&prefix);
    if dir.is_dir() {
        if parts.len() == 1 {
            collect_artist_dir(&dir, artist, &layout, &mut collected);
        } else {
            collect_album_dir(&dir, artist, parts[1], &layout, &mut collected);
        }
    }
    let known_files = db.file_states()?;
    let legacy_art = legacy_artwork_map(&root);
    let mut stats = Stats::default();
    let mut seen: HashSet<String> = HashSet::new();
    for group in &collected.groups {
        if let Err(err) = index_group(
            db,
            group,
            &known_files,
            false,
            &legacy_art,
            embedded,
            &mut seen,
            &mut stats,
        ) {
            stats.errors += 1;
            warn!(album = %group.folder_key, error = %err, "album index failed");
        }
    }
    for p in &collected.unreadable {
        seen.insert(p.clone());
        for rel in db.track_rel_paths_under(p)? {
            seen.insert(rel);
        }
    }
    // Everything indexed outside the folder counts as seen.
    let mut keep: HashSet<String> = db.all_track_rel_paths()?.into_iter().collect();
    let under: HashSet<String> = db.track_rel_paths_under(&prefix)?.into_iter().collect();
    keep.retain(|rel| !under.contains(rel));
    let missing = under.iter().filter(|r| !seen.contains(*r)).count() as u64;
    keep.extend(seen);
    let outcome = db.prune_tracks_outside_guarded(&keep, |indexed, _| {
        prune_guard(
            ScanMode::Incremental,
            ScanTrigger::Automatic,
            stats.scanned.max(1),
            indexed,
            missing,
        )
    })?;
    let (mut removed_albums, mut removed_artists) = (0, 0);
    if outcome.skipped.is_none() {
        removed_albums = db.prune_empty_albums()?;
        removed_artists = db.prune_empty_artists()?;
    }
    db.rebuild_fts()?;
    db.refresh_counts()?;
    db.rebuild_genres()?;
    let index_epoch = db.bump_index_epoch()?;
    crate::events::publish("library", serde_json::json!({ "indexEpoch": index_epoch }));
    info!(
        folder = %prefix,
        scanned_files = stats.scanned,
        indexed_tracks = stats.indexed,
        removed_tracks = outcome.removed,
        index_epoch,
        "folder rescan complete"
    );
    Ok(ScanReport {
        scanned_files: stats.scanned,
        indexed_tracks: stats.indexed,
        unchanged: stats.unchanged,
        skipped: stats.skipped,
        errors: stats.errors,
        removed_tracks: outcome.removed,
        removed_albums,
        removed_artists,
        mode: "folder".to_string(),
        music_root: root.to_string_lossy().into_owned(),
        missing_tracks: missing,
        prune_skipped: outcome.skipped,
        unreadable_dirs: collected.unreadable,
        index_epoch,
    })
}

/// Drop stored embedded covers no album uses any more (albums removed, or
/// now covered by a folder image).
pub fn prune_embedded_covers(db: &Db, store: &Path) {
    match db.all_album_cover_paths() {
        Ok(paths) => {
            let referenced: HashSet<PathBuf> = paths.into_iter().collect();
            let removed = crate::embedded::cover::prune(store, &referenced);
            if removed > 0 {
                info!(removed, "unused embedded covers removed");
            }
        }
        Err(err) => warn!(error = %err, "could not list album covers"),
    }
}

/// Covers registered by the legacy server (`.kord/artwork`), by album folder:
/// used when the folder itself has no `cover.*` / `folder.*` file. Covers
/// fetched by legacy Studio often only live there.
fn legacy_artwork_map(root: &Path) -> HashMap<String, PathBuf> {
    let db_path = root.join(".kord").join("rekord.db");
    let art_dir = root.join(".kord").join("artwork");
    let mut out = HashMap::new();
    if !db_path.is_file() || !art_dir.is_dir() {
        return out;
    }
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return out;
    };
    let Ok(mut stmt) = conn.prepare(
        r#"
        SELECT a.folder_rel_path, w.full_path
        FROM albums a JOIN artwork w ON w.id = a.cover_art_id
        WHERE a.folder_rel_path IS NOT NULL
        "#,
    ) else {
        return out;
    };
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
    let Ok(rows) = rows else {
        return out;
    };
    for (folder, full) in rows.flatten() {
        // Absolute paths point at wherever the legacy library lived: the file
        // name inside this library's `.kord/artwork` is what counts.
        let Some(name) = Path::new(&full.replace('\\', "/"))
            .file_name()
            .map(|n| n.to_owned())
        else {
            continue;
        };
        let candidate = art_dir.join(name);
        if candidate.is_file() {
            out.insert(folder.replace('\\', "/"), candidate);
        }
    }
    out
}

/// Decide whether `missing` of `indexed` tracks may be deleted.
fn prune_guard(
    mode: ScanMode,
    trigger: ScanTrigger,
    scanned_files: u64,
    indexed: u64,
    missing: u64,
) -> std::result::Result<(), String> {
    if mode == ScanMode::Full || missing == 0 {
        return Ok(());
    }
    if scanned_files == 0 {
        return Err(format!(
            "no audio files found under the music root while {missing} tracks are indexed \
             (drive not mounted?); run a full rescan to confirm the removal"
        ));
    }
    let fraction = missing as f64 / indexed.max(1) as f64;
    if missing >= MASS_PRUNE_MIN_TRACKS && fraction > trigger.max_prune_fraction() {
        return Err(format!(
            "{missing} of {indexed} indexed tracks vanished in one {} scan; \
             run a full rescan to confirm the removal",
            trigger.as_str()
        ));
    }
    Ok(())
}

#[derive(Default)]
struct Stats {
    scanned: u64,
    indexed: u64,
    unchanged: u64,
    skipped: u64,
    errors: u64,
}

/// One album worth of files, already resolved to display names.
struct AlbumGroup {
    artist: String,
    album: String,
    /// `<artist>/<album folder>` — stable album key, also the rel_path prefix.
    folder_key: String,
    /// Directory used for cover lookup (None for synthetic groups).
    cover_dir: Option<PathBuf>,
    loose: bool,
    /// (absolute path, rel_path)
    files: Vec<(PathBuf, String)>,
}

/// Everything found on disk, plus the folders that could not be listed.
#[derive(Default)]
struct Collected {
    groups: Vec<AlbumGroup>,
    /// rel_path prefixes (`artist`, `artist/album`, …) whose listing failed.
    unreadable: Vec<String>,
}

/// List a directory, sorted. `None` (and a recorded prefix) when it cannot be
/// read, so its tracks are protected from pruning instead of looking deleted.
fn list_dir(dir: &Path, rel_prefix: &str, out: &mut Collected) -> Option<Vec<PathBuf>> {
    match fs::read_dir(dir) {
        Ok(entries) => {
            let mut children: Vec<PathBuf> = Vec::new();
            for entry in entries {
                match entry {
                    Ok(e) => children.push(e.path()),
                    Err(err) => {
                        // A half-listed folder is as untrustworthy as an unlisted one.
                        warn!(path = %dir.display(), error = %err, "directory listing interrupted");
                        out.unreadable.push(rel_prefix.to_string());
                        return None;
                    }
                }
            }
            children.sort();
            Some(children)
        }
        Err(err) => {
            warn!(path = %dir.display(), error = %err, "cannot list folder; keeping its tracks");
            out.unreadable.push(rel_prefix.to_string());
            None
        }
    }
}

/// File, directory, or something we cannot stat (dropped mount, dangling link).
enum EntryKind {
    File,
    Dir,
    Other,
    Unreadable,
}

fn entry_kind(path: &Path) -> EntryKind {
    match fs::metadata(path) {
        Ok(m) if m.is_file() => EntryKind::File,
        Ok(m) if m.is_dir() => EntryKind::Dir,
        Ok(_) => EntryKind::Other,
        Err(_) => EntryKind::Unreadable,
    }
}

fn collect_groups(root: &Path, layout: &LibraryLayout) -> Result<Collected> {
    let mut out = Collected::default();
    let mut root_loose: Vec<PathBuf> = Vec::new();

    let entries =
        fs::read_dir(root).with_context(|| format!("cannot list music root {}", root.display()))?;
    let mut top: Vec<PathBuf> = Vec::new();
    for entry in entries {
        top.push(
            entry
                .with_context(|| format!("cannot list music root {}", root.display()))?
                .path(),
        );
    }
    top.sort();

    for path in top {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if is_excluded_dir(name) {
            continue;
        }
        match entry_kind(&path) {
            EntryKind::File => {
                if is_audio_name(name) {
                    root_loose.push(path);
                }
            }
            EntryKind::Dir => collect_artist_dir(&path, name, layout, &mut out),
            EntryKind::Unreadable => out.unreadable.push(name.to_string()),
            EntryKind::Other => {}
        }
    }

    if !root_loose.is_empty() {
        // Flat layout: audio directly in the root. Artist comes from tags when the
        // layout allows it, otherwise from the configured virtual artist.
        for file in root_loose {
            let Some(file_name) = file.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let artist = if layout.uses_tags() {
                crate::embedded::tags::group_artist(&file)
                    .unwrap_or_else(|| layout.virtual_artist.clone())
            } else {
                layout.virtual_artist.clone()
            };
            let folder_key = format!("{artist}/{LOOSE_ALBUM}");
            let rel = format!("{folder_key}/{file_name}");
            match out.groups.iter_mut().find(|g| g.folder_key == folder_key) {
                Some(existing) => existing.files.push((file, rel)),
                None => out.groups.push(AlbumGroup {
                    artist: artist.clone(),
                    album: LOOSE_ALBUM.to_string(),
                    folder_key,
                    cover_dir: Some(root.to_path_buf()),
                    loose: true,
                    files: vec![(file, rel)],
                }),
            }
        }
    }

    Ok(out)
}

fn collect_artist_dir(
    artist_path: &Path,
    artist_name: &str,
    layout: &LibraryLayout,
    out: &mut Collected,
) {
    let Some(children) = list_dir(artist_path, artist_name, out) else {
        return;
    };

    let mut loose: Vec<(PathBuf, String)> = Vec::new();

    for child in children {
        let Some(name) = child.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if is_excluded_dir(name) {
            continue;
        }
        match entry_kind(&child) {
            // Even in `artist/track` libraries subfolders are indexed as albums, so
            // nothing on disk is ever dropped; the artist's own files stay loose.
            EntryKind::Dir => collect_album_dir(&child, artist_name, name, layout, out),
            EntryKind::File if is_audio_name(name) => {
                let rel = format!("{artist_name}/{LOOSE_ALBUM}/{name}");
                loose.push((child, rel));
            }
            EntryKind::Unreadable => {
                out.unreadable.push(format!("{artist_name}/{name}"));
                if is_audio_name(name) {
                    // Could be one of the artist's loose tracks.
                    out.unreadable
                        .push(format!("{artist_name}/{LOOSE_ALBUM}/{name}"));
                }
            }
            _ => {}
        }
    }

    if !loose.is_empty() {
        out.groups.push(AlbumGroup {
            artist: artist_name.to_string(),
            album: LOOSE_ALBUM.to_string(),
            folder_key: format!("{artist_name}/{LOOSE_ALBUM}"),
            cover_dir: Some(artist_path.to_path_buf()),
            loose: true,
            files: loose,
        });
    }
}

fn collect_album_dir(
    album_path: &Path,
    artist_name: &str,
    album_folder: &str,
    layout: &LibraryLayout,
    out: &mut Collected,
) {
    let folder_key = format!("{artist_name}/{album_folder}");
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    // Nested folders (CD1/CD2, bonus discs) are part of the same album unless the
    // layout explicitly asks for one album per folder.
    collect_audio_recursive(
        album_path,
        &folder_key,
        0,
        layout.deep_scan,
        &mut files,
        out,
        artist_name,
    );

    if !files.is_empty() {
        out.groups.push(AlbumGroup {
            artist: artist_name.to_string(),
            album: album_folder.to_string(),
            folder_key,
            cover_dir: Some(album_path.to_path_buf()),
            loose: false,
            files,
        });
    }
}

fn collect_audio_recursive(
    dir: &Path,
    rel_prefix: &str,
    depth: usize,
    split_subfolders: bool,
    files: &mut Vec<(PathBuf, String)>,
    out: &mut Collected,
    artist_name: &str,
) {
    if depth > MAX_ALBUM_DEPTH {
        return;
    }
    let Some(children) = list_dir(dir, rel_prefix, out) else {
        return;
    };

    for child in children {
        let Some(name) = child.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if is_excluded_dir(name) {
            continue;
        }
        match entry_kind(&child) {
            EntryKind::File => {
                if is_audio_name(name) {
                    let rel = format!("{rel_prefix}/{name}");
                    files.push((child, rel));
                }
            }
            EntryKind::Unreadable => out.unreadable.push(format!("{rel_prefix}/{name}")),
            EntryKind::Other => {}
            EntryKind::Dir if split_subfolders => {
                let nested_key = format!("{rel_prefix}/{name}");
                let mut nested_files = Vec::new();
                collect_audio_recursive(
                    &child,
                    &nested_key,
                    depth + 1,
                    split_subfolders,
                    &mut nested_files,
                    out,
                    artist_name,
                );
                if !nested_files.is_empty() {
                    out.groups.push(AlbumGroup {
                        artist: artist_name.to_string(),
                        album: name.to_string(),
                        folder_key: nested_key,
                        cover_dir: Some(child.clone()),
                        loose: false,
                        files: nested_files,
                    });
                }
            }
            EntryKind::Dir => {
                collect_audio_recursive(
                    &child,
                    &format!("{rel_prefix}/{name}"),
                    depth + 1,
                    split_subfolders,
                    files,
                    out,
                    artist_name,
                );
            }
        }
    }
}

/// What to write for one file of an album, decided before taking the DB lock.
enum FileWork {
    /// size+mtime unchanged: only re-point at the current album/artist rows.
    Relink,
    Index {
        meta: Box<AudioMeta>,
        size: u64,
        mtime: i64,
    },
}

/// At most this many tracks of an album are opened to look for a picture.
const COVER_ATTEMPTS: usize = 3;

/// The best embedded picture seen so far in an album.
#[derive(Default)]
struct PictureHunt {
    best: Option<(String, EmbeddedPicture)>,
    attempts: usize,
    tried: HashSet<String>,
}

impl PictureHunt {
    fn wants_more(&self) -> bool {
        self.attempts < COVER_ATTEMPTS && !self.best.as_ref().is_some_and(|(_, p)| p.front)
    }

    fn offer(&mut self, rel: &str, picture: Option<EmbeddedPicture>) {
        self.attempts += 1;
        self.tried.insert(rel.to_string());
        if let Some(p) = picture {
            let better = match &self.best {
                None => true,
                Some((_, cur)) => p.front && !cur.front,
            };
            if better {
                self.best = Some((rel.to_string(), p));
            }
        }
    }
}

/// The cover an album row gets, and what to record about it.
struct CoverChoice {
    path: Option<PathBuf>,
    source: Option<&'static str>,
    /// `embedded_cover_from` to store (`None`: leave it).
    embedded_from: Option<Option<String>>,
}

/// Index one album: all filesystem I/O (stat, tags, cover lookup) happens
/// first, then every row is written in a single transaction.
#[allow(clippy::too_many_arguments)]
fn index_group(
    db: &Db,
    group: &AlbumGroup,
    known_files: &HashMap<String, (i64, i64)>,
    force_reread: bool,
    legacy_art: &HashMap<String, PathBuf>,
    embedded: &EmbeddedOptions,
    seen: &mut HashSet<String>,
    stats: &mut Stats,
) -> Result<()> {
    let folder_cover = group.cover_dir.as_deref().and_then(find_cover_in_dir);
    let legacy_cover = if folder_cover.is_none() {
        legacy_art.get(&group.folder_key).cloned()
    } else {
        None
    };
    // Embedded pictures stand in only when the folder has no image. Loose
    // tracks ("Tracks") come from different releases: no embedded cover.
    let cover_store = embedded
        .covers()
        .filter(|_| folder_cover.is_none() && legacy_cover.is_none() && !group.loose);
    let prev_from: Option<String> = match cover_store {
        Some(_) => db.album_embedded_cover_from(&group.folder_key)?,
        None => None,
    };
    let mut hunt = PictureHunt::default();
    let read_tags = embedded.enabled;

    let mut work: Vec<(&Path, &str, FileWork)> = Vec::with_capacity(group.files.len());
    let mut changed_files = 0usize;
    let mut read_files = 0usize;
    for (path, rel) in &group.files {
        stats.scanned += 1;
        seen.insert(rel.clone());

        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(err) => {
                stats.errors += 1;
                warn!(path = %path.display(), error = %err, "stat failed");
                continue;
            }
        };
        let size = meta.len() as i64;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        match known_files.get(rel) {
            Some((known_size, known_mtime)) if *known_size == size && *known_mtime == mtime => {
                if !force_reread {
                    work.push((path, rel, FileWork::Relink));
                    continue;
                }
            }
            // `-1`: marked stale by a schema upgrade, not changed on disk.
            Some((_, -1)) => {}
            _ => changed_files += 1,
        }
        read_files += 1;
        let file_stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Unknown")
            .to_string();
        // The picture comes with the same read, for the first few files of
        // an album that needs one.
        let want_picture = cover_store.is_some() && hunt.wants_more();
        let mut meta = read_audio_meta(path, &file_stem, &group.artist, read_tags, want_picture);
        if want_picture {
            hunt.offer(rel, meta.picture.take());
        }
        work.push((
            path,
            rel,
            FileWork::Index {
                meta: Box::new(meta),
                size: size as u64,
                mtime,
            },
        ));
    }

    let cover = choose_cover(
        group,
        folder_cover,
        legacy_cover,
        cover_store,
        prev_from,
        read_files > 0,
        &mut hunt,
    );

    // Loose tracks share a synthetic album: its name is the folder constant.
    let folder_title = if group.loose {
        group.album.clone()
    } else {
        crate::db::text::album_display_title(&group.album)
    };
    let policy = embedded.merge_policy();
    let (indexed, unchanged) = db.write_batch(|batch| {
        let artist_id = batch.upsert_artist(&group.artist)?;
        let album_id = batch.upsert_album(
            &folder_title,
            &group.artist,
            Some(artist_id),
            &group.folder_key,
            cover.path.as_deref(),
            group.loose,
        )?;
        batch.set_album_cover_info(
            album_id,
            cover.source,
            cover.embedded_from.as_ref().map(|f| f.as_deref()),
        )?;
        let album_name = batch.album_name(album_id)?;
        let mut indexed = 0u64;
        let mut unchanged = 0u64;
        for (path, rel, item) in &work {
            match item {
                // Unchanged on disk: keep DB row (and any Studio edits) untouched,
                // just make sure it points at the current album/artist rows.
                FileWork::Relink => {
                    batch.relink_track(rel, album_id, artist_id, &group.artist, &album_name)?;
                    unchanged += 1;
                }
                FileWork::Index { meta, size, mtime } => {
                    batch.upsert_track(&meta.track_row(RowPlace {
                        rel_path: rel,
                        file_path: path,
                        artist_name: &group.artist,
                        album_name: &album_name,
                        album_id: Some(album_id),
                        artist_id: Some(artist_id),
                        size: *size,
                        mtime: *mtime,
                        duration_ms: meta.duration_ms,
                        policy,
                        write_file_state: true,
                    }))?;
                    batch.set_mp3_seek_header(
                        rel,
                        *size,
                        *mtime,
                        meta.mp3_seek_header
                            .as_ref()
                            .map(|h| (h.insert_at, h.frame.as_slice())),
                    )?;
                    indexed += 1;
                }
            }
        }
        batch.sync_album_display(album_id, &folder_title, !group.loose)?;
        if indexed > 0 {
            batch.backfill_album_meta_from_tracks(album_id, policy.prefer_embedded)?;
        }
        if changed_files > 0 {
            batch.touch_album(album_id)?;
        }
        Ok((indexed, unchanged))
    })?;
    stats.indexed += indexed;
    stats.unchanged += unchanged;
    Ok(())
}

/// Folder image > legacy artwork > embedded picture. The embedded one is
/// looked for when the album was never checked, when files were (re)read
/// in this pass, or when its stored copy is gone; otherwise the stored copy
/// (or the absence of a picture) is reused without opening anything.
fn choose_cover(
    group: &AlbumGroup,
    folder_cover: Option<PathBuf>,
    legacy_cover: Option<PathBuf>,
    cover_store: Option<&Path>,
    prev_from: Option<String>,
    files_read: bool,
    hunt: &mut PictureHunt,
) -> CoverChoice {
    if let Some(p) = folder_cover {
        return CoverChoice {
            path: Some(p),
            source: Some("folder"),
            embedded_from: None,
        };
    }
    if let Some(p) = legacy_cover {
        return CoverChoice {
            path: Some(p),
            source: Some("legacy"),
            embedded_from: None,
        };
    }
    let none = CoverChoice {
        path: None,
        source: None,
        embedded_from: None,
    };
    let Some(store) = cover_store else {
        return none;
    };
    let stored = crate::embedded::cover::stored_path(store, &group.folder_key);
    let had_picture = prev_from.as_deref().is_some_and(|f| !f.is_empty());
    let must_check = prev_from.is_none() || files_read || (had_picture && !stored.is_file());
    if !must_check {
        return if had_picture {
            CoverChoice {
                path: Some(stored),
                source: Some("embedded"),
                embedded_from: None,
            }
        } else {
            none
        };
    }
    // Files that were not re-read in this pass are opened for their picture
    // only, a few at most.
    for (path, rel) in &group.files {
        if !hunt.wants_more() {
            break;
        }
        if hunt.tried.contains(rel) {
            continue;
        }
        hunt.offer(rel, crate::embedded::tags::read_picture(path));
    }
    let Some((rel, picture)) = hunt.best.take() else {
        return CoverChoice {
            embedded_from: Some(Some(String::new())),
            ..none
        };
    };
    match crate::embedded::cover::save(store, &group.folder_key, &picture.data) {
        Ok(path) => CoverChoice {
            path: Some(path),
            source: Some("embedded"),
            embedded_from: Some(Some(rel)),
        },
        Err(err) => {
            // Logged once: the album is marked checked until its files change.
            warn!(album = %group.folder_key, track = %rel, error = %err, "embedded cover skipped");
            CoverChoice {
                embedded_from: Some(Some(String::new())),
                ..none
            }
        }
    }
}

/// Where a read of a file goes in the catalog (see [`AudioMeta::track_row`]).
pub(crate) struct RowPlace<'a> {
    pub rel_path: &'a str,
    pub file_path: &'a Path,
    pub artist_name: &'a str,
    pub album_name: &'a str,
    pub album_id: Option<i64>,
    pub artist_id: Option<i64>,
    pub size: u64,
    pub mtime: i64,
    pub duration_ms: i64,
    pub policy: crate::embedded::MergePolicy,
    pub write_file_state: bool,
}

/// One read of a file, resolved for the catalog: tag values with the file
/// name as fallback, and which values came from the tags.
pub(crate) struct AudioMeta {
    pub title: String,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub duration_ms: i64,
    pub tags: EmbeddedTags,
    /// `db::field` bits of the values that came from the tags.
    pub embedded_mask: i64,
    pub picture: Option<EmbeddedPicture>,
    /// Boxed: rare, and it would bloat every queued file.
    mp3_seek_header: Option<Box<Mp3SeekHeader>>,
}

impl AudioMeta {
    pub(crate) fn track_row<'a>(&'a self, at: RowPlace<'a>) -> TrackRow<'a> {
        let t = &self.tags;
        TrackRow {
            rel_path: at.rel_path,
            file_path: at.file_path,
            title: &self.title,
            artist_name: at.artist_name,
            album_name: at.album_name,
            duration_ms: at.duration_ms,
            track_number: self.track_number,
            album_id: at.album_id,
            artist_id: at.artist_id,
            size: at.size,
            mtime: at.mtime,
            genre: t.genre.as_deref(),
            release_date: t.date.as_deref(),
            lyrics: t.lyrics.as_deref(),
            bpm: t.bpm,
            disc_number: self.disc_number,
            tag_album: t.album.as_deref(),
            tag_artist: t.artist.as_deref(),
            tag_album_artist: t.album_artist.as_deref(),
            track_total: t.track_total,
            disc_total: t.disc_total,
            mb_recording_id: t.mb_recording_id.as_deref(),
            mb_release_id: t.mb_release_id.as_deref(),
            mb_artist_id: t.mb_artist_id.as_deref(),
            mb_release_group_id: t.mb_release_group_id.as_deref(),
            embedded_mask: self.embedded_mask,
            tags_version: Some(crate::embedded::TAGS_VERSION),
            policy: at.policy,
            write_file_state: at.write_file_state,
        }
    }
}

/// Which fields of `tags` hold a value (`db::field` bits); the title only
/// when it is the display title (not a copy of the file name).
fn embedded_mask(tags: &EmbeddedTags, title_from_tag: bool) -> i64 {
    use crate::db::field;
    [
        (title_from_tag, field::TITLE),
        (tags.date.is_some(), field::RELEASE_DATE),
        (tags.genre.is_some(), field::GENRE),
        (tags.track_number.is_some(), field::TRACK_NUMBER),
        (tags.disc_number.is_some(), field::DISC_NUMBER),
        (tags.lyrics.is_some(), field::LYRICS),
        (tags.bpm.is_some(), field::BPM),
        (tags.album.is_some(), field::ALBUM),
        (tags.artist.is_some(), field::ARTIST),
        (tags.album_artist.is_some(), field::ALBUM_ARTIST),
        (tags.track_total.is_some(), field::TRACK_TOTAL),
        (tags.disc_total.is_some(), field::DISC_TOTAL),
        (
            tags.mb_recording_id.is_some()
                || tags.mb_release_id.is_some()
                || tags.mb_artist_id.is_some()
                || tags.mb_release_group_id.is_some(),
            field::MUSICBRAINZ,
        ),
    ]
    .iter()
    .filter(|(has, _)| *has)
    .fold(0, |mask, (_, bit)| mask | bit)
}

/// Display values of a file from its tags (`tags` empty when embedded
/// metadata is off): a missing title (or one that only repeats the file
/// name) is cleaned up from the file name, numbers fall back to it too.
pub(crate) fn resolve_meta(
    tags: EmbeddedTags,
    file_stem: &str,
    artist_folder: &str,
    duration_ms: i64,
) -> AudioMeta {
    let (guess_disc, guess_track) = crate::db::text::guess_track_numbers(file_stem);
    let title = crate::db::text::track_display_title(
        tags.title.as_deref(),
        file_stem,
        tags.artist.as_deref().unwrap_or(artist_folder),
    );
    let title_from_tag = tags.title.as_deref().is_some_and(|t| t.trim() == title);
    AudioMeta {
        track_number: tags.track_number.or(guess_track),
        disc_number: tags.disc_number.or(guess_disc),
        embedded_mask: embedded_mask(&tags, title_from_tag),
        title,
        duration_ms,
        tags,
        picture: None,
        mp3_seek_header: None,
    }
}

/// Tags (when `read_tags`), the picture (when asked) and the exact duration
/// of one file, from a single read of its headers.
fn read_audio_meta(
    path: &Path,
    file_stem: &str,
    artist_folder: &str,
    read_tags: bool,
    want_picture: bool,
) -> AudioMeta {
    let read = crate::embedded::tags::read_file(
        path,
        ReadRequest {
            tags: read_tags,
            picture: want_picture,
            properties: true,
        },
    );
    let mut duration_ms = read.duration_ms;
    let mut mp3_seek_header = None;
    // lofty only estimates VBR files without a Xing/VBRI header; a file it
    // cannot parse at all is walked frame by frame.
    let counted = if read.is_mpeg {
        mp3_count(path)
    } else if !read.parsed && is_mp3(path) {
        mp3_frames::count(path, true)
    } else {
        None
    };
    if let Some(counted) = counted {
        duration_ms = counted.duration_ms;
        mp3_seek_header = counted.seek_header.map(Box::new);
    }
    if duration_ms <= 0 && read.parsed {
        // lofty can't time some containers: ask ffmpeg.
        duration_ms = crate::embedded::tags::ffmpeg::probe(path)
            .map(|p| p.duration_ms)
            .unwrap_or(0);
    }
    let mut meta = resolve_meta(read.tags, file_stem, artist_folder, duration_ms);
    meta.picture = read.picture;
    meta.mp3_seek_header = mp3_seek_header;
    meta
}

fn is_mp3(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp3"))
}

pub use crate::embedded::tags::parse_bpm;

/// Frame count of an MP3 whose duration lofty (and `ffmpeg -i`) can only
/// *estimate*, see [`mp3_count`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mp3Count {
    pub duration_ms: i64,
    /// Xing header the file lacks; `/media` splices it in so players get the
    /// exact length and seek by its table of contents instead of guessing.
    pub seek_header: Option<Mp3SeekHeader>,
}

/// A synthetic Xing frame (frame count, byte count, TOC) and the file offset
/// of the first MPEG frame, where it belongs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mp3SeekHeader {
    pub insert_at: u64,
    pub frame: Vec<u8>,
}

/// Exact MP3 duration where lofty (and `ffmpeg -i`) only estimate it.
///
/// Without a Xing/VBRI header both extrapolate a bitrate over the whole file,
/// which is right for CBR and wrong — by many minutes on a long DJ set — for
/// VBR (typical of YouTube rips). `None` when the estimate is trustworthy: a
/// Xing/VBRI frame count or an `Info` (CBR) header is present, or sampling
/// shows a constant bitrate on a file small enough for an error not to
/// matter. Otherwise every frame header is walked (sequential read, no
/// decoding) and the samples are summed.
pub fn mp3_count(path: &Path) -> Option<Mp3Count> {
    mp3_frames::count(path, false)
}

/// [`mp3_count`]'s duration.
pub fn mp3_counted_duration_ms(path: &Path) -> Option<i64> {
    mp3_count(path).map(|c| c.duration_ms)
}

/// Like [`mp3_counted_duration_ms`], but always walks the frames.
pub fn mp3_frame_walk_duration_ms(path: &Path) -> Option<i64> {
    mp3_frames::count(path, true).map(|c| c.duration_ms)
}

mod mp3_frames {
    use super::{Mp3Count, Mp3SeekHeader};
    use std::fs::File;
    use std::io::{Read, Seek, SeekFrom};
    use std::path::Path;

    /// Files at least this big are always counted when they have no frame
    /// count header: an estimate error on a multi-hour set is minutes.
    const ALWAYS_COUNT_BYTES: u64 = 48 * 1024 * 1024;
    /// Frames sampled (at the start and in the middle) to tell CBR from VBR.
    const SAMPLE_FRAMES: usize = 600;
    const BUF_BYTES: usize = 1024 * 1024;
    /// Every this many frames the walk remembers an offset (for the TOC).
    const TOC_STRIDE: u64 = 32;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct Header {
        version: u8, // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
        layer: u8,   // 1..=3
        mono: bool,
        bitrate_kbps: u32,
        sample_rate: u32,
        samples: u32,
        len: usize,
    }

    impl Header {
        fn parse(b: &[u8]) -> Option<Header> {
            if b.len() < 4 || b[0] != 0xFF || b[1] & 0xE0 != 0xE0 {
                return None;
            }
            let version = (b[1] >> 3) & 3;
            let layer = match (b[1] >> 1) & 3 {
                0 => return None,
                bits => 4 - bits,
            };
            let br_ix = (b[2] >> 4) as usize;
            let sr_ix = ((b[2] >> 2) & 3) as usize;
            if version == 1 || br_ix == 0 || br_ix == 15 || sr_ix == 3 {
                return None;
            }
            const V1: [[u32; 14]; 3] = [
                [
                    32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
                ],
                [
                    32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384,
                ],
                [
                    32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
                ],
            ];
            const V2_L1: [u32; 14] = [
                32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256,
            ];
            const V2_L23: [u32; 14] = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
            let bitrate_kbps = match (version, layer) {
                (3, l) => V1[l as usize - 1][br_ix - 1],
                (_, 1) => V2_L1[br_ix - 1],
                _ => V2_L23[br_ix - 1],
            };
            let base_sr = [44100u32, 48000, 32000][sr_ix];
            let sample_rate = match version {
                3 => base_sr,
                2 => base_sr / 2,
                _ => base_sr / 4,
            };
            let samples = match (layer, version) {
                (1, _) => 384,
                (2, _) | (3, 3) => 1152,
                _ => 576,
            };
            let pad = u32::from((b[2] >> 1) & 1);
            let len = if layer == 1 {
                (12 * bitrate_kbps * 1000 / sample_rate + pad) * 4
            } else {
                samples / 8 * bitrate_kbps * 1000 / sample_rate + pad
            } as usize;
            if len < 4 {
                return None;
            }
            Some(Header {
                version,
                layer,
                mono: b[3] >> 6 == 3,
                bitrate_kbps,
                sample_rate,
                samples,
                len,
            })
        }

        /// Same stream: frames of one file never change these.
        fn same_stream(&self, other: &Header) -> bool {
            self.version == other.version
                && self.layer == other.layer
                && self.sample_rate == other.sample_rate
        }

        /// Offset of a Xing header inside the frame (after the side info).
        fn xing_offset(&self) -> usize {
            4 + match (self.version == 3, self.mono) {
                (true, false) => 32,
                (true, true) | (false, false) => 17,
                (false, true) => 9,
            }
        }
    }

    /// Sequential frame reader over a large buffer (no decoding).
    struct Frames {
        file: File,
        buf: Vec<u8>,
        /// File offset of `buf[0]`.
        base: u64,
        lo: usize,
        hi: usize,
        eof: bool,
        stream: Option<Header>,
        locked: bool,
    }

    impl Frames {
        fn open(path: &Path) -> Option<Frames> {
            let mut file = File::open(path).ok()?;
            let start = id3v2_len(&mut file)?;
            let mut frames = Frames {
                file,
                buf: vec![0; BUF_BYTES],
                base: 0,
                lo: 0,
                hi: 0,
                eof: false,
                stream: None,
                locked: false,
            };
            frames.seek(start)?;
            Some(frames)
        }

        /// Jump to `offset` and look for a frame boundary again.
        fn seek(&mut self, offset: u64) -> Option<()> {
            self.file.seek(SeekFrom::Start(offset)).ok()?;
            self.base = offset;
            self.lo = 0;
            self.hi = 0;
            self.eof = false;
            self.locked = false;
            Some(())
        }

        /// At least `need` bytes buffered from `lo` (false at end of file).
        fn fill(&mut self, need: usize) -> bool {
            if self.hi - self.lo >= need {
                return true;
            }
            self.buf.copy_within(self.lo..self.hi, 0);
            self.base += self.lo as u64;
            self.hi -= self.lo;
            self.lo = 0;
            while self.hi < need && !self.eof {
                match self.file.read(&mut self.buf[self.hi..]) {
                    Ok(0) | Err(_) => self.eof = true,
                    Ok(n) => self.hi += n,
                }
            }
            self.hi - self.lo >= need
        }

        /// Next frame (header, file offset, its bytes; `lo` advanced past
        /// it), or `None` at end of file. Out of sync (start, junk, a seek),
        /// a candidate is only accepted when the header after it fits too.
        fn next_frame(&mut self) -> Option<(Header, u64, &[u8])> {
            loop {
                if !self.fill(4) {
                    return None;
                }
                let at = self.lo;
                let Some(h) = Header::parse(&self.buf[at..at + 4]) else {
                    self.locked = false;
                    self.lo += 1;
                    continue;
                };
                if !self.stream.is_none_or(|s| s.same_stream(&h)) {
                    self.locked = false;
                    self.lo += 1;
                    continue;
                }
                if !self.fill(h.len) {
                    return None; // truncated last frame
                }
                if !self.locked {
                    // Confirm with the following header (when there is one).
                    let at = self.lo;
                    let confirmed = self.fill(h.len + 4) && {
                        let next = &self.buf[at + h.len..at + h.len + 4];
                        Header::parse(next).is_some_and(|n| n.same_stream(&h))
                    };
                    if !confirmed {
                        self.lo += 1;
                        continue;
                    }
                    self.locked = true;
                    self.stream.get_or_insert(h);
                }
                let at = self.lo;
                self.lo += h.len;
                return Some((h, self.base + at as u64, &self.buf[at..at + h.len]));
            }
        }

        /// File offset of the next unread byte.
        fn position(&self) -> u64 {
            self.base + self.lo as u64
        }
    }

    /// Bytes taken by leading ID3v2 tags (there may be more than one).
    fn id3v2_len(file: &mut File) -> Option<u64> {
        let mut offset = 0u64;
        loop {
            let mut head = [0u8; 10];
            file.seek(SeekFrom::Start(offset)).ok()?;
            if file.read_exact(&mut head).is_err() || &head[..3] != b"ID3" {
                return Some(offset);
            }
            let size = head[6..10]
                .iter()
                .fold(0u64, |acc, b| (acc << 7) | u64::from(b & 0x7F));
            let footer = if head[5] & 0x10 != 0 { 10 } else { 0 };
            offset += 10 + size + footer;
        }
    }

    enum InfoFrame {
        /// Xing (VBR) or VBRI header with usable counts: lofty times it.
        FrameCount,
        /// `Info`: LAME's CBR header.
        Cbr,
        /// A Xing/VBRI frame without usable counts: not audio, not counted.
        Empty,
    }

    fn be32(b: &[u8]) -> u32 {
        u32::from_be_bytes([b[0], b[1], b[2], b[3]])
    }

    /// Xing / Info / VBRI header inside the first frame.
    fn info_frame(h: &Header, frame: &[u8]) -> Option<InfoFrame> {
        let xing = h.xing_offset();
        if let Some(tag) = frame.get(xing..xing + 16) {
            if &tag[..4] == b"Xing" || &tag[..4] == b"Info" {
                // Same rule as lofty: frame and byte counts both present.
                let usable =
                    be32(&tag[4..]) & 3 == 3 && be32(&tag[8..]) > 0 && be32(&tag[12..]) > 0;
                return Some(match (usable, &tag[..4] == b"Info") {
                    (true, true) => InfoFrame::Cbr,
                    (true, false) => InfoFrame::FrameCount,
                    (false, _) => InfoFrame::Empty,
                });
            }
        }
        if let Some(tag) = frame.get(36..36 + 18) {
            if &tag[..4] == b"VBRI" {
                let usable = be32(&tag[10..]) > 0 && be32(&tag[14..]) > 0;
                return Some(if usable {
                    InfoFrame::FrameCount
                } else {
                    InfoFrame::Empty
                });
            }
        }
        None
    }

    /// Whether `SAMPLE_FRAMES` frames from the reader's position all have
    /// `bitrate_kbps` (true at end of file).
    fn constant_bitrate(frames: &mut Frames, bitrate_kbps: u32) -> bool {
        for _ in 0..SAMPLE_FRAMES {
            match frames.next_frame() {
                Some((h, _, _)) if h.bitrate_kbps != bitrate_kbps => return false,
                Some(_) => {}
                None => break,
            }
        }
        true
    }

    /// A Layer III Xing frame matching `first` (same version, sample rate and
    /// channel mode, so decoders read it at the usual offset), as small as the
    /// header allows. `toc` gets the frame's own length.
    fn xing_frame(
        first_raw: [u8; 4],
        first: &Header,
        audio_frames: u64,
        stream_bytes: u64,
        toc: impl Fn(u64) -> [u8; 100],
    ) -> Option<Vec<u8>> {
        if first.layer != 3 {
            return None;
        }
        let at = first.xing_offset();
        let need = at + 4 + 4 + 4 + 4 + 100;
        let (raw, h) = (1u8..=14).find_map(|br_ix| {
            let raw = [
                0xFF,
                first_raw[1] | 1, // no CRC
                (br_ix << 4) | (first_raw[2] & 0x0C),
                first_raw[3] & 0xC0,
            ];
            Header::parse(&raw)
                .filter(|h| h.len >= need)
                .map(|h| (raw, h))
        })?;
        let frames = u32::try_from(audio_frames).ok()?;
        let bytes = u32::try_from(stream_bytes + h.len as u64).ok()?;
        let mut out = vec![0u8; h.len];
        out[..4].copy_from_slice(&raw);
        out[at..at + 4].copy_from_slice(b"Xing");
        out[at + 4..at + 8].copy_from_slice(&7u32.to_be_bytes()); // frames | bytes | TOC
        out[at + 8..at + 12].copy_from_slice(&frames.to_be_bytes());
        out[at + 12..at + 16].copy_from_slice(&bytes.to_be_bytes());
        out[at + 16..at + 116].copy_from_slice(&toc(h.len as u64));
        Some(out)
    }

    pub(super) fn count(path: &Path, always: bool) -> Option<Mp3Count> {
        let size = std::fs::metadata(path).ok()?.len();
        let mut frames = Frames::open(path)?;
        let (first, first_off, first_frame) = frames.next_frame()?;
        let first_raw = [
            first_frame[0],
            first_frame[1],
            first_frame[2],
            first_frame[3],
        ];
        let info = info_frame(&first, first_frame);
        if !always && matches!(info, Some(InfoFrame::FrameCount | InfoFrame::Cbr)) {
            return None;
        }
        if !always && size < ALWAYS_COUNT_BYTES {
            // Small file: worth a full read only when the bitrate varies.
            let after_first = frames.position();
            let cbr = constant_bitrate(&mut frames, first.bitrate_kbps) && {
                frames.seek(size / 2)?;
                constant_bitrate(&mut frames, first.bitrate_kbps)
            };
            if cbr {
                return None;
            }
            frames.seek(after_first)?;
        }
        // Offsets (from `first_off`) of every TOC_STRIDE-th audio frame.
        let mut marks: Vec<u64> = Vec::new();
        let mut audio_frames = 0u64;
        let mut samples = 0u64;
        // A Xing/Info/VBRI frame carries no audio.
        if info.is_none() {
            marks.push(0);
            audio_frames = 1;
            samples = u64::from(first.samples);
        }
        while let Some((h, off, _)) = frames.next_frame() {
            if audio_frames.is_multiple_of(TOC_STRIDE) {
                marks.push(off - first_off);
            }
            audio_frames += 1;
            samples += u64::from(h.samples);
        }
        let rate = u64::from(first.sample_rate);
        let ms = (samples * 1000 + rate / 2) / rate;
        if ms == 0 {
            return None;
        }
        // Files with a usable header keep it; the others get one at serve time.
        let seek_header = matches!(info, None | Some(InfoFrame::Empty))
            .then(|| {
                let stream_bytes = size - first_off;
                xing_frame(first_raw, &first, audio_frames, stream_bytes, |xing_len| {
                    let total = (stream_bytes + xing_len) as f64;
                    let mut toc = [0u8; 100];
                    for (i, slot) in toc.iter_mut().enumerate() {
                        let frame = i as u64 * audio_frames / 100;
                        let mark = marks[((frame / TOC_STRIDE) as usize).min(marks.len() - 1)];
                        *slot = (((xing_len + mark) as f64 * 256.0 / total).round() as u64).min(255)
                            as u8;
                    }
                    toc
                })
            })
            .flatten()
            .map(|frame| Mp3SeekHeader {
                insert_at: first_off,
                frame,
            });
        Some(Mp3Count {
            duration_ms: ms as i64,
            seek_header,
        })
    }
}
