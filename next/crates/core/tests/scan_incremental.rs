//! Incremental scan behaviour: upsert, skip-unchanged, prune of deleted files.

use rekord_core::db::Db;
use rekord_core::scan::{scan_library, scan_library_with, ScanMode};
use std::fs;
use std::path::{Path, PathBuf};

struct TempLibrary {
    root: PathBuf,
}

impl TempLibrary {
    fn new(tag: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("rekord-scan-test-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn track(&self, rel: &str) -> PathBuf {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Tag-less bytes are fine: the scanner falls back to the file name.
        fs::write(&path, b"not-a-real-mp3-but-indexable").unwrap();
        path
    }

    fn db(&self) -> Db {
        Db::open(self.root.join("test.db")).unwrap()
    }
}

impl Drop for TempLibrary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn track_count(db: &Db) -> i64 {
    db.stats(None).unwrap().track_count
}

fn album_count(db: &Db) -> i64 {
    db.stats(None).unwrap().album_count
}

#[test]
fn indexes_albums_and_loose_tracks() {
    let lib = TempLibrary::new("index");
    lib.track("Caparezza/Orbit Orbit/01.mp3");
    lib.track("Caparezza/Orbit Orbit/02.mp3");
    lib.track("Caparezza/single.mp3");
    let db = lib.db();

    let report = scan_library(&db, &lib.root).unwrap();
    assert_eq!(report.indexed_tracks, 3);
    assert_eq!(track_count(&db), 3);
    // One real album plus the synthetic "Tracks" album for the loose file.
    assert_eq!(album_count(&db), 2);
}

#[test]
fn nested_disc_folders_stay_in_the_same_album() {
    let lib = TempLibrary::new("nested");
    lib.track("Artist/Album/CD1/01.mp3");
    lib.track("Artist/Album/CD2/01.mp3");
    lib.track("Artist/Album/root.mp3");
    let db = lib.db();

    let report = scan_library(&db, &lib.root).unwrap();
    assert_eq!(report.indexed_tracks, 3, "nested files must not be dropped");
    assert_eq!(album_count(&db), 1);
}

#[test]
fn second_scan_skips_unchanged_files() {
    let lib = TempLibrary::new("unchanged");
    lib.track("Artist/Album/01.mp3");
    lib.track("Artist/Album/02.mp3");
    let db = lib.db();

    scan_library(&db, &lib.root).unwrap();
    let again = scan_library(&db, &lib.root).unwrap();
    assert_eq!(again.unchanged, 2);
    assert_eq!(again.indexed_tracks, 0);
    assert_eq!(track_count(&db), 2);
}

#[test]
fn deleted_folders_are_pruned() {
    let lib = TempLibrary::new("prune");
    lib.track("Artist/Album/01.mp3");
    lib.track("Artist/Album/02.mp3");
    lib.track("Other/Album/01.mp3");
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();
    assert_eq!(track_count(&db), 3);

    fs::remove_dir_all(lib.root.join("Artist")).unwrap();
    let report = scan_library(&db, &lib.root).unwrap();

    assert_eq!(report.removed_tracks, 2);
    assert_eq!(report.removed_albums, 1);
    assert_eq!(report.removed_artists, 1);
    assert_eq!(track_count(&db), 1);
    assert_eq!(album_count(&db), 1);
}

#[test]
fn pruning_one_track_leaves_its_album_and_artist_alone() {
    let lib = TempLibrary::new("prune-one");
    lib.track("Artist/Album/01.mp3");
    lib.track("Artist/Album/02.mp3");
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();

    fs::remove_file(lib.root.join("Artist/Album/01.mp3")).unwrap();
    let report = scan_library(&db, &lib.root).unwrap();

    // An album that still holds a track is not empty: pruning must leave it be.
    assert_eq!(report.removed_tracks, 1);
    assert_eq!(report.removed_albums, 0);
    assert_eq!(report.removed_artists, 0);
    assert_eq!(track_count(&db), 1);
    assert_eq!(album_count(&db), 1);
}

#[test]
fn a_moved_file_is_reindexed_at_its_new_path() {
    let lib = TempLibrary::new("moved");
    lib.track("Artist/Album/01.mp3");
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();

    fs::create_dir_all(lib.root.join("Artist/Altro")).unwrap();
    fs::rename(
        lib.root.join("Artist/Album/01.mp3"),
        lib.root.join("Artist/Altro/01.mp3"),
    )
    .unwrap();
    let report = scan_library(&db, &lib.root).unwrap();

    assert_eq!(report.indexed_tracks, 1);
    assert_eq!(report.removed_tracks, 1);
    assert_eq!(track_count(&db), 1);
    assert!(db.track_id_by_rel("Artist/Album/01.mp3").unwrap().is_none());
    assert!(db.track_id_by_rel("Artist/Altro/01.mp3").unwrap().is_some());
}

#[test]
fn a_changed_file_is_read_again() {
    let lib = TempLibrary::new("changed");
    let path = lib.track("Artist/Album/01.mp3");
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();

    // A different size is enough to tell the file apart from the indexed one.
    fs::write(&path, b"different bytes, longer than before").unwrap();
    let report = scan_library(&db, &lib.root).unwrap();

    assert_eq!(report.indexed_tracks, 1);
    assert_eq!(report.unchanged, 0);
    assert_eq!(track_count(&db), 1);
}

#[test]
fn a_deleted_track_leaves_the_playlist_without_a_hole() {
    let lib = TempLibrary::new("prune-playlist");
    lib.track("Artist/Album/01.mp3");
    lib.track("Artist/Album/02.mp3");
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();

    let playlist = db.create_playlist("default", "Set").unwrap();
    for rel in ["Artist/Album/01.mp3", "Artist/Album/02.mp3"] {
        let id = db.track_id_by_rel(rel).unwrap().unwrap();
        db.add_to_playlist("default", &playlist.id, id).unwrap();
    }
    assert_eq!(db.playlist_tracks("default", &playlist.id).unwrap().len(), 2);

    fs::remove_file(lib.root.join("Artist/Album/01.mp3")).unwrap();
    scan_library(&db, &lib.root).unwrap();

    let left = db.playlist_tracks("default", &playlist.id).unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].rel_path, "Artist/Album/02.mp3");
    // The playlist itself survives losing a track.
    assert_eq!(db.list_playlists("default").unwrap().len(), 1);
}

#[test]
fn an_empty_library_scans_without_complaining() {
    let lib = TempLibrary::new("empty");
    let db = lib.db();

    let report = scan_library(&db, &lib.root).unwrap();
    assert_eq!(report.indexed_tracks, 0);
    assert_eq!(report.removed_tracks, 0);
    assert_eq!(track_count(&db), 0);
}

#[test]
fn everything_gone_means_everything_pruned() {
    let lib = TempLibrary::new("prune-all");
    lib.track("Artist/Album/01.mp3");
    lib.track("Other/Album/01.mp3");
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();

    for dir in ["Artist", "Other"] {
        fs::remove_dir_all(lib.root.join(dir)).unwrap();
    }
    let report = scan_library(&db, &lib.root).unwrap();

    assert_eq!(report.removed_tracks, 2);
    assert_eq!(track_count(&db), 0);
    assert_eq!(album_count(&db), 0);
}

#[test]
fn new_files_are_picked_up_without_touching_the_rest() {
    let lib = TempLibrary::new("add");
    lib.track("Artist/Album/01.mp3");
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();

    lib.track("Artist/Album/02.mp3");
    let report = scan_library(&db, &lib.root).unwrap();
    assert_eq!(report.indexed_tracks, 1);
    assert_eq!(report.unchanged, 1);
    assert_eq!(track_count(&db), 2);
}

#[test]
fn full_rebuild_reindexes_everything() {
    let lib = TempLibrary::new("full");
    lib.track("Artist/Album/01.mp3");
    lib.track("Artist/Album/02.mp3");
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();

    let report = scan_library_with(&db, &lib.root, ScanMode::Full).unwrap();
    assert_eq!(report.mode, "full");
    assert_eq!(report.indexed_tracks, 2);
    assert_eq!(report.unchanged, 0);
    assert_eq!(track_count(&db), 2);
}

#[test]
fn favorites_survive_an_incremental_scan() {
    let lib = TempLibrary::new("favs");
    lib.track("Artist/Album/01.mp3");
    lib.track("Artist/Album/02.mp3");
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();

    let keep = db.track_id_by_rel("Artist/Album/01.mp3").unwrap().unwrap();
    db.add_favorite("default", keep).unwrap();

    scan_library(&db, &lib.root).unwrap();
    assert_eq!(db.list_favorites("default").unwrap().len(), 1);

    // Removing the file drops the favorite with it.
    fs::remove_file(lib.root.join("Artist/Album/01.mp3")).unwrap();
    scan_library(&db, &lib.root).unwrap();
    assert!(db.list_favorites("default").unwrap().is_empty());
}

#[test]
fn junk_folders_are_ignored() {
    let lib = TempLibrary::new("junk");
    lib.track("Artist/Album/01.mp3");
    lib.track(".kord/cache/01.mp3");
    lib.track("node_modules/pkg/01.mp3");
    let db = lib.db();

    let report = scan_library(&db, &lib.root).unwrap();
    assert_eq!(report.indexed_tracks, 1);
}

#[test]
fn missing_root_is_an_error() {
    let missing = Path::new("/definitely/not/here/rekord");
    let lib = TempLibrary::new("missing");
    let db = lib.db();
    assert!(scan_library(&db, missing).is_err());
}
