//! Deleting tracks and album folders from disk: what leaves, what is refused,
//! and what the database does afterwards.
//!
//! The HTTP handlers are thin wrappers over these two pieces (the `studio_fs`
//! helpers and the db cleanup), so this is where the behaviour is pinned down.

use rekord_core::db::Db;
use rekord_core::scan::scan_library;
use rekord_core::studio_fs::{delete_album_folder, delete_audio_files};
use std::fs;
use std::path::PathBuf;

struct TempLibrary {
    root: PathBuf,
}

impl TempLibrary {
    fn new(tag: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("rekord-delete-test-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn track(&self, rel: &str) -> PathBuf {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not-a-real-mp3-but-indexable").unwrap();
        path
    }

    fn file(&self, rel: &str, body: &[u8]) -> PathBuf {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        path
    }

    fn exists(&self, rel: &str) -> bool {
        self.root.join(rel).exists()
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

fn owned(paths: &[&str]) -> Vec<String> {
    paths.iter().map(|p| (*p).to_string()).collect()
}

#[test]
fn deletes_the_audio_files_it_was_given() {
    let lib = TempLibrary::new("audio");
    lib.track("Artist/Album/01.mp3");
    lib.track("Artist/Album/02.mp3");

    let report = delete_audio_files(&lib.root, &owned(&["Artist/Album/01.mp3"]));

    assert_eq!(report.deleted, vec!["Artist/Album/01.mp3"]);
    assert!(report.skipped.is_empty());
    assert!(!lib.exists("Artist/Album/01.mp3"));
    assert!(lib.exists("Artist/Album/02.mp3"), "the rest stays put");
}

#[test]
fn a_stale_path_is_skipped_without_stopping_the_others() {
    let lib = TempLibrary::new("stale");
    lib.track("Artist/Album/01.mp3");
    lib.track("Artist/Album/02.mp3");

    let report = delete_audio_files(
        &lib.root,
        &owned(&[
            "Artist/Album/gone-yesterday.mp3",
            "Artist/Album/01.mp3",
            "Artist/Album/02.mp3",
        ]),
    );

    assert_eq!(report.deleted.len(), 2);
    assert_eq!(report.skipped, vec!["Artist/Album/gone-yesterday.mp3"]);
}

#[test]
fn only_audio_files_can_be_deleted() {
    let lib = TempLibrary::new("kinds");
    lib.file("Artist/Album/cover.jpg", b"jpeg");
    lib.file("Artist/Album/notes.txt", b"text");
    lib.track("Artist/Album/01.mp3");

    let report = delete_audio_files(
        &lib.root,
        &owned(&[
            "Artist/Album/cover.jpg",
            "Artist/Album/notes.txt",
            "Artist/Album",
        ]),
    );

    assert!(report.deleted.is_empty());
    assert_eq!(report.skipped.len(), 3, "cover, text file and the folder");
    assert!(lib.exists("Artist/Album/cover.jpg"));
    assert!(lib.exists("Artist/Album/01.mp3"));
}

#[test]
fn nothing_outside_the_library_can_be_reached() {
    let lib = TempLibrary::new("escape");
    lib.track("Artist/Album/01.mp3");
    let outside = std::env::temp_dir().join(format!("rekord-outside-{}.mp3", uuid::Uuid::new_v4()));
    fs::write(&outside, b"precious").unwrap();

    let report = delete_audio_files(
        &lib.root,
        &owned(&[
            "../../../etc/hosts",
            "..",
            &format!("Artist/../../{}", outside.file_name().unwrap().to_string_lossy()),
        ]),
    );

    assert!(report.deleted.is_empty());
    assert!(outside.exists(), "a path climbing out must not be followed");
    fs::remove_file(&outside).unwrap();
}

#[cfg(unix)]
#[test]
fn a_symlink_pointing_out_of_the_library_is_refused() {
    let lib = TempLibrary::new("symlink");
    let outside = std::env::temp_dir().join(format!("rekord-target-{}.mp3", uuid::Uuid::new_v4()));
    fs::write(&outside, b"precious").unwrap();
    fs::create_dir_all(lib.root.join("Artist/Album")).unwrap();
    std::os::unix::fs::symlink(&outside, lib.root.join("Artist/Album/link.mp3")).unwrap();

    let report = delete_audio_files(&lib.root, &owned(&["Artist/Album/link.mp3"]));

    assert_eq!(report.deleted, Vec::<String>::new());
    assert!(outside.exists(), "the link resolves outside: hands off");
    fs::remove_file(&outside).unwrap();
}

#[test]
fn deletes_an_album_folder_whole() {
    let lib = TempLibrary::new("album");
    lib.track("Artist/Album/01.mp3");
    lib.track("Artist/Album/CD2/01.mp3");
    lib.file("Artist/Album/cover.jpg", b"jpeg");
    lib.track("Artist/Other/01.mp3");

    let removed = delete_album_folder(&lib.root, "Artist/Album").unwrap();

    assert_eq!(removed.folder, "Artist/Album");
    assert_eq!(
        removed.deleted,
        vec!["Artist/Album/01.mp3", "Artist/Album/CD2/01.mp3"],
        "audio in nested discs is reported too"
    );
    assert!(!lib.exists("Artist/Album"), "cover and sidecars go with it");
    assert!(lib.exists("Artist/Other/01.mp3"));
}

#[test]
fn an_artist_folder_is_not_an_album() {
    let lib = TempLibrary::new("artist-guard");
    lib.track("Artist/Album/01.mp3");

    let outcome = delete_album_folder(&lib.root, "Artist");

    assert!(outcome.is_err(), "one segment deep is the artist, not an album");
    assert!(lib.exists("Artist/Album/01.mp3"));
}

#[test]
fn a_folder_without_audio_is_left_alone() {
    let lib = TempLibrary::new("no-audio");
    lib.file("Artist/Scans/booklet.jpg", b"jpeg");

    let outcome = delete_album_folder(&lib.root, "Artist/Scans");

    assert!(outcome.is_err());
    assert!(lib.exists("Artist/Scans/booklet.jpg"));
}

#[test]
fn a_missing_album_folder_is_an_error_not_a_panic() {
    let lib = TempLibrary::new("missing-album");
    lib.track("Artist/Album/01.mp3");

    assert!(delete_album_folder(&lib.root, "Artist/Never Released").is_err());
}

#[test]
fn the_database_drops_the_deleted_track_and_keeps_the_album() {
    let lib = TempLibrary::new("db-track");
    lib.track("Artist/Album/01.mp3");
    lib.track("Artist/Album/02.mp3");
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();

    let report = delete_audio_files(&lib.root, &owned(&["Artist/Album/01.mp3"]));
    for rel in &report.deleted {
        assert!(db.delete_track_by_rel(rel).unwrap());
    }
    db.prune_empty_albums().unwrap();
    db.prune_empty_artists().unwrap();

    let stats = db.stats(None).unwrap();
    assert_eq!(stats.track_count, 1);
    assert_eq!(stats.album_count, 1, "the album still has a track");
    assert_eq!(stats.artist_count, 1);
}

#[test]
fn the_last_track_of_an_album_takes_album_and_artist_with_it() {
    let lib = TempLibrary::new("db-last");
    lib.track("Artist/Album/01.mp3");
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();

    let removed = delete_album_folder(&lib.root, "Artist/Album").unwrap();
    for rel in &removed.deleted {
        db.delete_track_by_rel(rel).unwrap();
    }
    db.delete_album_by_folder(&removed.folder).unwrap();
    db.prune_empty_albums().unwrap();
    db.prune_empty_artists().unwrap();

    let stats = db.stats(None).unwrap();
    assert_eq!(stats.track_count, 0);
    assert_eq!(stats.album_count, 0);
    assert_eq!(stats.artist_count, 0);
}

#[test]
fn other_clients_learn_of_the_deletion_from_the_delta() {
    let lib = TempLibrary::new("delta");
    lib.track("Artist/Album/01.mp3");
    lib.track("Artist/Album/02.mp3");
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();
    // A cursor from before the delete: everything after it is what a client
    // syncing now would receive.
    let cursor = "1970-01-01T00:00:00Z".to_string();

    let report = delete_audio_files(&lib.root, &owned(&["Artist/Album/01.mp3"]));
    for rel in &report.deleted {
        db.delete_track_by_rel(rel).unwrap();
    }

    let (_updated, removed) = db.tracks_changed_since(&cursor, 100).unwrap();
    assert_eq!(
        removed,
        vec!["Artist/Album/01.mp3"],
        "the tombstone is what makes the track vanish on the phone too"
    );
}
