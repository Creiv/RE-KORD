//! Playlist ordering: reorder rewrites positions and refuses mismatched sets.

use rekord_core::db::Db;
use rekord_core::scan::scan_library;
use std::fs;
use std::path::PathBuf;

const ACCOUNT: &str = "default";

struct TempLibrary {
    root: PathBuf,
}

impl TempLibrary {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "rekord-playlist-test-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn track(&self, rel: &str) {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not-a-real-mp3-but-indexable").unwrap();
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

/// Playlist with three tracks, returned in insertion order.
fn seeded() -> (TempLibrary, Db, String, Vec<i64>) {
    let lib = TempLibrary::new("reorder");
    lib.track("Artist/Album/01.mp3");
    lib.track("Artist/Album/02.mp3");
    lib.track("Artist/Album/03.mp3");
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();

    let playlist = db.create_playlist(ACCOUNT, "Set").unwrap();
    let ids: Vec<i64> = db
        .list_tracks(1000, 0)
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(ids.len(), 3);
    for id in &ids {
        db.add_to_playlist(ACCOUNT, &playlist.id, *id).unwrap();
    }
    let order: Vec<i64> = db
        .playlist_tracks(ACCOUNT, &playlist.id)
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(order, ids);
    let id = playlist.id.clone();
    (lib, db, id, ids)
}

#[test]
fn reorder_moves_a_track_to_the_front() {
    let (_lib, db, playlist_id, ids) = seeded();
    let wanted = vec![ids[2], ids[0], ids[1]];

    db.reorder_playlist(ACCOUNT, &playlist_id, &wanted).unwrap();

    let after: Vec<i64> = db
        .playlist_tracks(ACCOUNT, &playlist_id)
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(after, wanted);
}

#[test]
fn reorder_survives_a_later_append() {
    let (lib, db, playlist_id, ids) = seeded();
    db.reorder_playlist(ACCOUNT, &playlist_id, &[ids[1], ids[2], ids[0]])
        .unwrap();

    lib.track("Artist/Album/04.mp3");
    scan_library(&db, &lib.root).unwrap();
    let new_id = db
        .list_tracks(1000, 0)
        .unwrap()
        .into_iter()
        .find(|t| t.rel_path.ends_with("04.mp3"))
        .unwrap()
        .id;
    db.add_to_playlist(ACCOUNT, &playlist_id, new_id).unwrap();

    let after: Vec<i64> = db
        .playlist_tracks(ACCOUNT, &playlist_id)
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(after, vec![ids[1], ids[2], ids[0], new_id]);
}

#[test]
fn reorder_refuses_a_set_that_does_not_match() {
    let (_lib, db, playlist_id, ids) = seeded();

    // Missing one track.
    let short = db.reorder_playlist(ACCOUNT, &playlist_id, &[ids[0], ids[1]]);
    assert!(short.is_err());

    // Duplicated track.
    let dup = db.reorder_playlist(ACCOUNT, &playlist_id, &[ids[0], ids[0], ids[1]]);
    assert!(dup.is_err());

    // Unknown track.
    let alien = db.reorder_playlist(ACCOUNT, &playlist_id, &[ids[0], ids[1], 9_999]);
    assert!(alien.is_err());

    // The stored order is untouched by the rejected calls.
    let after: Vec<i64> = db
        .playlist_tracks(ACCOUNT, &playlist_id)
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(after, ids);
}

#[test]
fn reorder_rejects_another_account() {
    let (_lib, db, playlist_id, ids) = seeded();
    let res = db.reorder_playlist("someone-else", &playlist_id, &[ids[2], ids[1], ids[0]]);
    assert!(res.is_err());
}
