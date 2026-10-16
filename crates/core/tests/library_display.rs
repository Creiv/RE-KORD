//! Library display model: titles cleaned from file names, album titles from
//! tags, curated values that survive rescans, date precedence, genre tokens,
//! FTS search, per-account stats, covers and media headers, folder rescans.

#[path = "http_support/mod.rs"]
mod support;

use axum::http::{Method, StatusCode};
use rekord_core::db::text::{
    album_display_title, guess_track_numbers, sanitize_track_title, split_genres,
    track_display_title,
};
use rekord_core::db::{CuratedTrackMeta, CuratedWrite, Db};
use rekord_core::scan::{scan_library, scan_library_with, ScanMode};
use std::fs;
use std::path::{Path, PathBuf};
use support::{req, Hub};

// ---------------------------------------------------------------- helpers

fn syncsafe(n: usize) -> [u8; 4] {
    [
        ((n >> 21) & 0x7f) as u8,
        ((n >> 14) & 0x7f) as u8,
        ((n >> 7) & 0x7f) as u8,
        (n & 0x7f) as u8,
    ]
}

/// A tiny but valid MP3: an ID3v2.4 tag with the given text frames, then a
/// few silent MPEG-1 Layer III frames.
fn mp3_with_tags(frames: &[(&str, &str)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (id, text) in frames {
        let mut data = vec![3u8];
        data.extend_from_slice(text.as_bytes());
        body.extend_from_slice(id.as_bytes());
        body.extend_from_slice(&syncsafe(data.len()));
        body.extend_from_slice(&[0, 0]);
        body.extend_from_slice(&data);
    }
    let mut out = b"ID3\x04\x00\x00".to_vec();
    out.extend_from_slice(&syncsafe(body.len()));
    out.extend_from_slice(&body);
    for _ in 0..20 {
        out.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        out.extend_from_slice(&[0u8; 413]);
    }
    out
}

struct Lib {
    root: PathBuf,
}

impl Lib {
    fn new(tag: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("rekord-display-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn file(&self, rel: &str, bytes: &[u8]) -> PathBuf {
        let p = self.root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, bytes).unwrap();
        p
    }

    fn db(&self) -> Db {
        Db::open(self.root.join("hub.db")).unwrap()
    }
}

impl Drop for Lib {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn track_title(db: &Db, rel: &str) -> String {
    db.track_by_rel(rel).unwrap().unwrap().title
}

fn album_by_folder(db: &Db, folder: &str) -> rekord_core::db::Album {
    db.list_albums()
        .unwrap()
        .into_iter()
        .find(|a| a.folder_key == folder)
        .unwrap()
}

/// Minimal legacy `.kord/rekord.db` with the columns the importer reads.
fn write_legacy_db(path: &Path, sql: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE albums (
          id TEXT PRIMARY KEY, artist_id TEXT, folder_rel_path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL, title TEXT, release_date TEXT, genre TEXT, label TEXT,
          country TEXT, musicbrainz_release_id TEXT, expected_track_count INTEGER,
          cover_art_id TEXT, has_album_meta INTEGER NOT NULL DEFAULT 0,
          added_at INTEGER, updated_at INTEGER, user_edited INTEGER NOT NULL DEFAULT 0,
          discogs_release_id INTEGER, discogs_extra_json TEXT
        );
        CREATE TABLE tracks (
          id TEXT PRIMARY KEY, rel_path TEXT NOT NULL UNIQUE, album_id TEXT,
          title TEXT NOT NULL, artist_name TEXT, album_name TEXT, genre TEXT,
          release_date TEXT, lyrics TEXT, track_number INTEGER, disc_number INTEGER,
          source TEXT, url TEXT, added_at INTEGER, updated_at INTEGER,
          user_edited INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE artwork (
          id TEXT PRIMARY KEY, album_id TEXT, kind TEXT NOT NULL, full_path TEXT NOT NULL
        );
        "#,
    )
    .unwrap();
    conn.execute_batch(sql).unwrap();
}

// ------------------------------------------------------- title sanitising

/// Cases of legacy `server/sanitizeLocalTrackTitle.test.ts`.
#[test]
fn sanitize_matches_the_legacy_cases() {
    assert_eq!(sanitize_track_title("01 - Foo [2024] Bar", None), "Foo Bar");
    assert_eq!(
        sanitize_track_title("Song (Official Music Video)", None),
        "Song"
    );
    assert_eq!(sanitize_track_title("Track (lyrics)", None), "Track");
    assert_eq!(
        sanitize_track_title("Luna (Official Audio) - Topic", Some("NotUsed")),
        "Luna"
    );
    assert_eq!(
        sanitize_track_title(
            "Måneskin - Zitti e buoni (Official Video)",
            Some("Måneskin")
        ),
        "Zitti e buoni"
    );
    let other = "Altra banda - Un brano";
    assert_eq!(sanitize_track_title(other, Some("Måneskin")), other);
    assert_eq!(
        sanitize_track_title(
            "02 - Good Goodbye [Official Music Video] - Linkin Park (feat. Pusha T and Stormzy)",
            Some("Linkin Park")
        ),
        "Good Goodbye (feat. Pusha T and Stormzy)"
    );
    assert_eq!(
        sanitize_track_title(
            "01 - Nobody Can Save Me (Official Audio) - Linkin Park",
            Some("Linkin Park")
        ),
        "Nobody Can Save Me"
    );
    assert_eq!(
        sanitize_track_title("Brano (Original Mix) (2017 remaster)", None),
        "Brano"
    );
    assert_eq!(
        sanitize_track_title("X (official audio) (feat. Y)", None),
        "X (feat. Y)"
    );
}

#[test]
fn sanitize_strips_numbers_but_keeps_musical_versions() {
    assert_eq!(
        sanitize_track_title("01 - In the Evening (Remaster)", None),
        "In the Evening"
    );
    assert_eq!(sanitize_track_title("01-Intro", None), "Intro");
    assert_eq!(sanitize_track_title("1. Intro", None), "Intro");
    assert_eq!(
        sanitize_track_title("07 – Song (Remix)", None),
        "Song (Remix)"
    );
    assert_eq!(sanitize_track_title("Song (Live)", None), "Song (Live)");
    assert_eq!(
        sanitize_track_title("Song (Robin Schulz Remix)", None),
        "Song (Robin Schulz Remix)"
    );
    assert_eq!(
        sanitize_track_title("Song (Live Edit)", None),
        "Song (Live Edit)"
    );
    assert_eq!(
        sanitize_track_title("Two Faced (Instrumental)", None),
        "Two Faced (Instrumental)"
    );
    assert_eq!(
        sanitize_track_title("Song （Official Video）", None),
        "Song"
    );
    // A bare number is a title, not a prefix.
    assert_eq!(sanitize_track_title("1999", None), "1999");
}

#[test]
fn display_title_prefers_real_tags() {
    assert_eq!(
        track_display_title(
            Some("In the Evening"),
            "01 - In the Evening (Remaster)",
            "LZ"
        ),
        "In the Evening"
    );
    assert_eq!(
        track_display_title(None, "01 - In the Evening (Remaster)", "LZ"),
        "In the Evening"
    );
    // A tag that only repeats the file name is cleaned like the file name.
    assert_eq!(
        track_display_title(Some("03 - Song"), "03 - Song", "A"),
        "Song"
    );
    assert_eq!(
        track_display_title(Some("03 - Song (Official Audio)"), "03 - Other", "A"),
        "Song"
    );
}

#[test]
fn track_numbers_from_file_names() {
    assert_eq!(guess_track_numbers("07 - Song"), (None, Some(7)));
    assert_eq!(guess_track_numbers("07. Song"), (None, Some(7)));
    assert_eq!(guess_track_numbers("7 Song"), (None, Some(7)));
    assert_eq!(guess_track_numbers("1-03 Song"), (Some(1), Some(3)));
    assert_eq!(guess_track_numbers("Song"), (None, None));
    assert_eq!(guess_track_numbers("1999"), (None, None));
}

#[test]
fn album_titles_get_ascii_punctuation() {
    assert_eq!(album_display_title("？!"), "?!");
    assert_eq!(
        album_display_title("From Zero： A Cappellas"),
        "From Zero: A Cappellas"
    );
    assert_eq!(album_display_title("Album - Lo-files"), "Lo-files");
    assert_eq!(album_display_title("Albums"), "Albums");
}

// ----------------------------------------------------------------- genres

#[test]
fn genres_split_and_drop_junk() {
    assert_eq!(split_genres("Hip Hop; Pop Rap"), vec!["Hip Hop", "Pop Rap"]);
    assert_eq!(
        split_genres("Rock/Pop, Indie | Alt"),
        vec!["Rock", "Pop", "Indie", "Alt"]
    );
    assert_eq!(
        split_genres("Hip Hop; 8; ; (17); Music; hip-hop"),
        vec!["Hip Hop"]
    );
    assert!(split_genres("  ").is_empty());
}

#[test]
fn genre_variants_share_one_canonical_label() {
    let lib = Lib::new("genres");
    for (rel, genre) in [
        ("A/X/01.mp3", "Hip Hop; Pop Rap"),
        ("A/X/02.mp3", "Hip-hop"),
        ("A/X/03.mp3", "Hip Hop"),
        ("B/Y/01.mp3", "Hip-Hop; 8"),
    ] {
        lib.file(rel, &mp3_with_tags(&[("TIT2", "t"), ("TCON", genre)]));
    }
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();
    let tracks = db.list_library_tracks(100, 0).unwrap();
    for t in &tracks {
        assert!(
            t.genres.iter().all(|g| g == "Hip Hop" || g == "Pop Rap"),
            "{:?}",
            t.genres
        );
    }
    let first = tracks.iter().find(|t| t.rel_path == "A/X/01.mp3").unwrap();
    assert_eq!(first.genres, vec!["Hip Hop", "Pop Rap"]);
    // Raw string kept for compatibility.
    assert_eq!(first.genre.as_deref(), Some("Hip Hop; Pop Rap"));
    let counts = rekord_core::db::count_genres(
        tracks
            .iter()
            .map(|t| (t.genres.as_slice(), t.album_id, t.artist_id)),
    );
    assert_eq!(counts[0].label, "Hip Hop");
    assert_eq!(counts[0].track_count, 4);
    assert_eq!(counts[0].artist_count, 2);
}

// ------------------------------------------- titles, tags and curated values

#[test]
fn scan_uses_tags_for_album_titles_and_cleans_file_titles() {
    let lib = Lib::new("scan-titles");
    lib.file(
        "prova/Find Me Now/01 - Born in the U.S.A..mp3",
        &mp3_with_tags(&[("TALB", "Born In the U.S.A."), ("TDRC", "1984-06-04")]),
    );
    lib.file("Caparezza/？!/03 - Nessuno.mp3", b"no tags");
    lib.file(
        "Bring Me the Horizon/Album - Lo-files/02-Kool-Aid.mp3",
        b"x",
    );
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();

    let album = album_by_folder(&db, "prova/Find Me Now");
    assert_eq!(album.name, "Born In the U.S.A.");
    assert_eq!(album.folder_name, "Find Me Now");
    assert_eq!(album.release_date.as_deref(), Some("1984-06-04"));
    let t = db
        .track_by_rel("prova/Find Me Now/01 - Born in the U.S.A..mp3")
        .unwrap()
        .unwrap();
    assert_eq!(t.title, "Born in the U.S.A.");
    assert_eq!(t.album_name, "Born In the U.S.A.");
    assert_eq!(t.track_number, Some(1));
    assert_eq!(t.release_date.as_deref(), Some("1984-06-04"));

    assert_eq!(album_by_folder(&db, "Caparezza/？!").name, "?!");
    assert_eq!(
        track_title(&db, "Caparezza/？!/03 - Nessuno.mp3"),
        "Nessuno"
    );
    assert_eq!(
        album_by_folder(&db, "Bring Me the Horizon/Album - Lo-files").name,
        "Lo-files"
    );
    let kool = db
        .track_by_rel("Bring Me the Horizon/Album - Lo-files/02-Kool-Aid.mp3")
        .unwrap()
        .unwrap();
    assert_eq!(kool.title, "Kool-Aid");
    assert_eq!(kool.track_number, Some(2));
}

#[test]
fn user_edits_survive_rescans() {
    let lib = Lib::new("user-edits");
    lib.file(
        "Artist/Album/01 - Song.mp3",
        &mp3_with_tags(&[
            ("TIT2", "Tag Title"),
            ("TALB", "Tag Album"),
            ("TCON", "Rock"),
        ]),
    );
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();
    assert_eq!(album_by_folder(&db, "Artist/Album").name, "Tag Album");

    db.save_album_fields(
        "Artist/Album",
        Some("My Album"),
        None,
        Some("2001-02-03"),
        None,
    )
    .unwrap();
    db.save_track_fields(
        "Artist/Album/01 - Song.mp3",
        Some("My Title"),
        Some("Jazz"),
        None,
        None,
    )
    .unwrap();

    // Full rescan re-reads every tag.
    scan_library_with(&db, &lib.root, ScanMode::Full).unwrap();
    let album = album_by_folder(&db, "Artist/Album");
    assert_eq!(album.name, "My Album");
    assert_eq!(album.release_date.as_deref(), Some("2001-02-03"));
    assert!(album.user_edited);
    let t = db
        .get_library_track(
            db.track_id_by_rel("Artist/Album/01 - Song.mp3")
                .unwrap()
                .unwrap(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(t.title, "My Title");
    assert_eq!(t.album_name, "My Album");
    assert_eq!(t.genre.as_deref(), Some("Jazz"));
    assert!(t.user_edited);
    assert!(t.curated_fields.contains(&"title".to_string()));

    // A fetch may not replace what a person typed.
    db.apply_curated_track(
        "Artist/Album/01 - Song.mp3",
        &CuratedTrackMeta {
            title: Some("Fetched".into()),
            ..Default::default()
        },
        CuratedWrite::Override,
    )
    .unwrap();
    assert_eq!(track_title(&db, "Artist/Album/01 - Song.mp3"), "My Title");
}

#[test]
fn sidecar_values_apply_once_and_win_over_tags() {
    let lib = Lib::new("sidecar");
    lib.file(
        "Artist/Album/01 - Song.mp3",
        &mp3_with_tags(&[("TIT2", "Tag Title")]),
    );
    lib.file(
        "Artist/Album/kord-trackinfo.json",
        br#"{"01 - Song.mp3":{"title":"Sidecar Title","trackNumber":4,"releaseDate":"1999-09-09"}}"#,
    );
    lib.file(
        "Artist/Album/kord-albuminfo.json",
        br#"{"title":"Sidecar Album","releaseDate":"1999"}"#,
    );
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();
    rekord_core::backup::import_sidecar_metadata(&db, &lib.root).unwrap();
    scan_library_with(&db, &lib.root, ScanMode::Full).unwrap();
    let t = db
        .track_by_rel("Artist/Album/01 - Song.mp3")
        .unwrap()
        .unwrap();
    assert_eq!(t.title, "Sidecar Title");
    assert_eq!(t.track_number, Some(4));
    assert_eq!(t.release_date.as_deref(), Some("1999-09-09"));
    assert_eq!(album_by_folder(&db, "Artist/Album").name, "Sidecar Album");
    // Re-applying the same sidecars changes nothing.
    assert_eq!(
        rekord_core::backup::import_sidecar_metadata(&db, &lib.root).unwrap(),
        (0, 0)
    );
}

#[test]
fn curated_dates_beat_upload_dates_and_full_dates_stay_full() {
    let lib = Lib::new("dates");
    // yt-dlp writes the upload date as the recording date.
    lib.file(
        "Artist/Album/01 - Song.mp3",
        &mp3_with_tags(&[("TDRC", "2014-11-08")]),
    );
    lib.file(
        "Artist/Other/01 - Old.mp3",
        &mp3_with_tags(&[("TDRC", "1994-08-01")]),
    );
    write_legacy_db(
        &lib.root.join(".kord/rekord.db"),
        r#"
        INSERT INTO albums(id, folder_rel_path, name, title, release_date)
          VALUES ('a', 'Artist/Album', 'Album', 'Album', '1984-06-04'),
                 ('b', 'Artist/Other', 'Other', 'Other', '1994');
        INSERT INTO tracks(id, rel_path, album_id, title, release_date)
          VALUES ('t', 'Artist/Album/01 - Song.mp3', 'a', 'Song', '1984-06-04'),
                 ('u', 'Artist/Other/01 - Old.mp3', 'b', 'Old', '1994');
        "#,
    );
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();
    assert_eq!(
        album_by_folder(&db, "Artist/Album").release_date.as_deref(),
        Some("2014-11-08")
    );
    rekord_core::backup::import_legacy_library_db_metadata(&db, &lib.root.join(".kord/rekord.db"))
        .unwrap();
    scan_library_with(&db, &lib.root, ScanMode::Full).unwrap();

    assert_eq!(
        album_by_folder(&db, "Artist/Album").release_date.as_deref(),
        Some("1984-06-04")
    );
    let t = db
        .track_by_rel("Artist/Album/01 - Song.mp3")
        .unwrap()
        .unwrap();
    assert_eq!(t.release_date.as_deref(), Some("1984-06-04"));
    // A legacy bare year never collapses the full date of the same year.
    let old = db
        .track_by_rel("Artist/Other/01 - Old.mp3")
        .unwrap()
        .unwrap();
    assert_eq!(old.release_date.as_deref(), Some("1994-08-01"));
    assert_eq!(
        album_by_folder(&db, "Artist/Other").release_date.as_deref(),
        Some("1994-08-01")
    );
}

#[test]
fn legacy_titles_numbers_and_flags_are_imported() {
    let lib = Lib::new("legacy-titles");
    lib.file("prova/Find Me Now/01 - Glory Days (Remaster).mp3", b"x");
    lib.file("prova/Find Me Now/02 - Dancing.mp3", b"x");
    write_legacy_db(
        &lib.root.join(".kord/rekord.db"),
        r#"
        INSERT INTO albums(id, folder_rel_path, name, title, user_edited, added_at, updated_at)
          VALUES ('a', 'prova/Find Me Now', 'Born In the U.S.A.', 'Born In the U.S.A.', 1,
                  1779196043194.46, 1785341825777);
        INSERT INTO tracks(id, rel_path, album_id, title, track_number, disc_number, user_edited)
          VALUES ('t1', 'prova/Find Me Now/01 - Glory Days (Remaster).mp3', 'a', 'Glory Days', 5, 2, 0),
                 ('t2', 'prova/Find Me Now/02 - Dancing.mp3', 'a', '02 - Dancing', 2, NULL, 0);
        "#,
    );
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();
    rekord_core::backup::import_legacy_library_db_metadata(&db, &lib.root.join(".kord/rekord.db"))
        .unwrap();
    scan_library_with(&db, &lib.root, ScanMode::Full).unwrap();

    let album = album_by_folder(&db, "prova/Find Me Now");
    assert_eq!(album.name, "Born In the U.S.A.");
    assert!(album.user_edited);
    assert!(album.added_at.as_deref().unwrap().starts_with("2026-05-19"));
    assert!(album
        .updated_at
        .as_deref()
        .unwrap()
        .starts_with("2026-07-29"));
    let id = db
        .track_id_by_rel("prova/Find Me Now/01 - Glory Days (Remaster).mp3")
        .unwrap()
        .unwrap();
    let t = db.get_library_track(id).unwrap().unwrap();
    assert_eq!(t.title, "Glory Days");
    assert_eq!(t.track_number, Some(5));
    assert_eq!(t.disc_number, Some(2));
    // Legacy title equal to the file name is not curated: cleaned instead.
    assert_eq!(
        track_title(&db, "prova/Find Me Now/02 - Dancing.mp3"),
        "Dancing"
    );
}

// ------------------------------------------------------------- legacy import

fn write_legacy_personal(root: &Path) {
    let kord = root.join(".kord");
    fs::create_dir_all(kord.join("global_info")).unwrap();
    fs::write(
        kord.join("global_info/accounts.json"),
        r#"{"accounts":[{"id":"default","name":"Default"},{"id":"guest","name":"Ospite"}]}"#,
    )
    .unwrap();
    fs::create_dir_all(kord.join("default_info")).unwrap();
    fs::write(
        kord.join("default_info/user-state.json"),
        r#"{
          "favorites": ["Artist/Album/01.mp3"],
          "playlists": [
            {"id": "p1", "name": "Queue", "tracks": [{"relPath": "Artist/Album/02.mp3"}, {"relPath": "Artist/Album/01.mp3"}]},
            {"id": "p2", "name": "Queue", "tracks": [{"relPath": "Artist/Album/03.mp3"}]},
            {"id": "p3", "name": "Other", "tracks": []}
          ],
          "trackMoods": {"Artist/Album/01.mp3": ["chill_relax"]},
          "trackPlayCounts": {"Artist/Album/01.mp3": 9},
          "settings": {"theme": "dark"},
          "plectrBests": {"Artist/Album/01.mp3": {"score": 6300, "grade": "D", "accuracy": 0.2, "maxCombo": 13, "hits": 29, "misses": 105, "updatedAt": "2026-06-07T17:23:03.496Z"}}
        }"#,
    )
    .unwrap();
    fs::create_dir_all(kord.join("guest_info")).unwrap();
    fs::write(
        kord.join("guest_info/library-selection.json"),
        r#"{"version":1,"includeAll":false,"artists":[],"albums":["Artist/Album"],"tracks":[]}"#,
    )
    .unwrap();
    // A legacy account that no longer exists in the legacy registry.
    fs::create_dir_all(kord.join("deleted_info")).unwrap();
    fs::write(
        kord.join("deleted_info/user-state.json"),
        r#"{"trackPlayCounts": {"Artist/Album/01.mp3": 3}}"#,
    )
    .unwrap();
}

#[tokio::test]
async fn legacy_library_is_imported_once_and_never_resurrected() {
    let hub = Hub::new("legacy-once");
    for rel in [
        "Artist/Album/01.mp3",
        "Artist/Album/02.mp3",
        "Artist/Album/03.mp3",
    ] {
        hub.file(rel, b"audio");
    }
    write_legacy_personal(&hub.root);
    hub.state
        .run_scan_mode(ScanMode::Incremental)
        .await
        .unwrap();

    let data = hub.data.clone();
    let marker = rekord_core::backup::read_legacy_import_marker(&data).expect("marker");
    assert!(marker.imported_at.is_some());
    assert_eq!(
        marker
            .accounts
            .get("deleted")
            .and_then(|a| a.reason.clone())
            .as_deref(),
        Some("not_registered")
    );
    assert!(!data.join("accounts/deleted_info").exists());
    assert!(!data.join("accounts/deleted").exists());

    let registry = rekord_core::accounts::ensure_accounts(&data).unwrap();
    let default = registry.iter().find(|a| a.id == "default").unwrap();
    assert_eq!(default.name, "Default");
    assert!(registry.iter().any(|a| a.id == "guest"));

    let db = &hub.state.db;
    let favs: Vec<String> = db
        .list_favorites("default")
        .unwrap()
        .into_iter()
        .map(|t| t.rel_path.clone())
        .collect();
    assert_eq!(favs, vec!["Artist/Album/01.mp3"]);

    // Same-name legacy playlists stay apart, in legacy order.
    let pls = db.list_playlists("default").unwrap();
    let names: Vec<&str> = pls.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["Queue", "Queue", "Other"]);
    let first: Vec<String> = db
        .playlist_tracks("default", &pls[0].id)
        .unwrap()
        .into_iter()
        .map(|t| t.rel_path)
        .collect();
    assert_eq!(first, vec!["Artist/Album/02.mp3", "Artist/Album/01.mp3"]);

    let state = rekord_core::user_state::load_user_state(&data, "default");
    assert_eq!(
        state.play_counts["Artist/Album/01.mp3"],
        serde_json::json!(9)
    );
    assert_eq!(state.settings["theme"], serde_json::json!("dark"));
    let plectr = &state.settings["plectr"];
    assert_eq!(plectr["version"], serde_json::json!(1));
    assert_eq!(
        plectr["bests"]["Artist/Album/01.mp3"]["score"],
        serde_json::json!(6300)
    );

    let sel = rekord_core::selection::read_library_selection(&data, "guest").unwrap();
    assert_eq!(sel.albums, vec!["Artist/Album"]);

    // The person clears play counts and moods, then the library is rescanned
    // (and the hub restarted): nothing comes back.
    rekord_core::user_state::update_user_state(&data, "default", None, |s| {
        s.play_counts.clear();
        s.track_moods.clear();
    })
    .unwrap();
    hub.state.run_scan_mode(ScanMode::Full).await.unwrap();
    hub.state.spawn_initial_scan_if_needed();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let state = rekord_core::user_state::load_user_state(&data, "default");
    assert!(state.play_counts.is_empty());
    assert!(state.track_moods.is_empty());
    assert_eq!(db.list_playlists("default").unwrap().len(), 3);

    // The explicit sync stays a merge keyed on legacy ids: no duplicates.
    rekord_core::backup::sync_legacy_library_data(db, &data, &hub.root).unwrap();
    assert_eq!(db.list_playlists("default").unwrap().len(), 3);
}

#[tokio::test]
async fn accounts_already_used_in_next_are_merged_not_overwritten() {
    let hub = Hub::new("legacy-used");
    hub.file("Artist/Album/01.mp3", b"audio");
    write_legacy_personal(&hub.root);
    rekord_core::user_state::update_user_state(&hub.data, "default", None, |s| {
        s.settings
            .insert("theme".into(), serde_json::json!("light"));
    })
    .unwrap();
    hub.state
        .run_scan_mode(ScanMode::Incremental)
        .await
        .unwrap();
    let marker = rekord_core::backup::read_legacy_import_marker(&hub.data).unwrap();
    assert!(marker.accounts["default"].imported);
    let state = rekord_core::user_state::load_user_state(&hub.data, "default");
    assert_eq!(state.settings["theme"], serde_json::json!("light"));
    assert_eq!(
        state.track_moods["Artist/Album/01.mp3"],
        serde_json::json!(["chill_relax"])
    );
    let favs: Vec<String> = hub
        .state
        .db
        .list_favorites("default")
        .unwrap()
        .into_iter()
        .map(|t| t.rel_path.clone())
        .collect();
    assert_eq!(favs, vec!["Artist/Album/01.mp3"]);
}

// ---------------------------------------------------------------- search

#[tokio::test]
async fn search_uses_fts_and_finds_albums_and_artists_by_genre() {
    let hub = Hub::new("search");
    hub.file(
        "Caparezza/Verità Supposte/01 - Fuori dal tunnel.mp3",
        &mp3_with_tags(&[("TCON", "Hip Hop; Pop Rap")]),
    );
    hub.file(
        "Linkin Park/Minutes to Midnight/01 - Wake.mp3",
        &mp3_with_tags(&[("TCON", "Rock")]),
    );
    hub.state
        .run_scan_mode(ScanMode::Incremental)
        .await
        .unwrap();
    let get = |uri: &str| hub.send(req(Method::GET, uri).build());

    // Accents ignored, words as prefixes.
    let res = get("/api/v1/library/search?q=verita").await.json();
    assert_eq!(res["data"].as_array().unwrap().len(), 1);
    let res = get("/api/v1/library/search?q=fuori%20tun").await.json();
    assert_eq!(res["data"][0]["title"], "Fuori dal tunnel");
    // Number prefixes and paths do not match.
    let res = get("/api/v1/library/search?q=01").await.json();
    assert!(res["data"].as_array().unwrap().is_empty(), "{res}");
    let res = get("/api/v1/library/search?q=mp3").await.json();
    assert!(res["data"].as_array().unwrap().is_empty(), "{res}");
    // Genre.
    let res = get("/api/v1/library/search?q=pop%20rap").await.json();
    assert_eq!(res["data"].as_array().unwrap().len(), 1);

    let res = get("/api/v1/library/search?q=hip&scope=all").await.json();
    let albums = res["data"]["albums"].as_array().unwrap();
    assert_eq!(albums.len(), 1);
    assert_eq!(albums[0]["name"], "Verità Supposte");
    assert_eq!(res["data"]["artists"][0]["name"], "Caparezza");
    let res = get("/api/v1/library/search?q=linkin&scope=all")
        .await
        .json();
    assert_eq!(res["data"]["artists"][0]["name"], "Linkin Park");
    assert_eq!(res["data"]["albums"][0]["name"], "Minutes to Midnight");

    let genres = get("/api/v1/library/genres").await.json();
    let labels: Vec<&str> = genres["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels.len(), 3);
    assert!(labels.contains(&"Hip Hop") && labels.contains(&"Rock"));
}

// ------------------------------------------------------- stats per account

#[tokio::test]
async fn stats_follow_the_account_selection() {
    let hub = Hub::new("stats-sel");
    hub.file("A/One/01.mp3", b"x");
    hub.file("A/One/02.mp3", b"x");
    hub.file("B/Two/01.mp3", b"x");
    hub.state
        .run_scan_mode(ScanMode::Incremental)
        .await
        .unwrap();
    let snap = rekord_core::accounts::create_account(&hub.data, "Guest").unwrap();
    let guest = snap.created_account_id.unwrap();

    let all = hub
        .send(req(Method::GET, "/api/v1/library/stats").build())
        .await
        .json();
    assert_eq!(all["data"]["track_count"], 3);
    assert_eq!(all["data"]["artist_count"], 2);

    let uri = format!("/api/v1/library/stats?accountId={guest}");
    let empty = hub.send(req(Method::GET, &uri).build()).await.json();
    assert_eq!(empty["data"]["track_count"], 0);
    assert_eq!(empty["data"]["catalog_track_count"], 3);

    rekord_core::selection::write_library_selection(
        &hub.data,
        &guest,
        &rekord_core::selection::LibrarySelection {
            albums: vec!["A/One".into()],
            ..Default::default()
        },
    )
    .unwrap();
    let some = hub.send(req(Method::GET, &uri).build()).await.json();
    assert_eq!(some["data"]["track_count"], 2);
    assert_eq!(some["data"]["album_count"], 1);
    assert_eq!(some["data"]["artist_count"], 1);
}

/// The quality counters mean the same thing whether the hub counts them in SQL
/// (whole library) or over an account's selection, and the selection only
/// counts what that account sees. Definitions: `db::quality`.
#[tokio::test]
async fn quality_counts_agree_between_sql_and_selection() {
    let hub = Hub::new("stats-quality");
    hub.file("A/One/01.mp3", &mp3_with_tags(&[("TCON", "Unknown")]));
    hub.file("A/One/02.mp3", &mp3_with_tags(&[("TDRC", "2020")]));
    hub.file("A/One/03.mp3", &mp3_with_tags(&[("TCON", "Rock")]));
    hub.file("B/Two/01.mp3", &mp3_with_tags(&[("TIT2", "untagged")]));
    hub.file("B/Two/cover.jpg", b"\xFF\xD8\xFFjpeg");
    hub.file("B/loose.mp3", &mp3_with_tags(&[("TIT2", "loose")]));
    hub.state
        .run_scan_mode(ScanMode::Incremental)
        .await
        .unwrap();
    let snap = rekord_core::accounts::create_account(&hub.data, "Guest").unwrap();
    let guest = snap.created_account_id.unwrap();
    let keys = [
        "track_count",
        "albums_without_cover",
        "albums_without_meta",
        "tracks_without_meta",
        "loose_album_count",
    ];
    let pick = |v: &serde_json::Value| keys.map(|k| v["data"][k].as_i64().unwrap());

    // Default account: everything, counted in SQL.
    let all = hub
        .send(req(Method::GET, "/api/v1/library/stats").build())
        .await
        .json();
    // Guest selecting both artists: the same library, counted in Rust.
    rekord_core::selection::write_library_selection(
        &hub.data,
        &guest,
        &rekord_core::selection::LibrarySelection {
            artists: vec!["A".into(), "B".into()],
            ..Default::default()
        },
    )
    .unwrap();
    let uri = format!("/api/v1/library/stats?accountId={guest}");
    let sel = hub.send(req(Method::GET, &uri).build()).await.json();
    assert_eq!(pick(&all), pick(&sel), "SQL and selection counts differ");
    let [tracks, no_cover, _, no_meta, loose] = pick(&all);
    assert_eq!(tracks, 5);
    // "A/One" has no cover; "B/Two" has one; the loose folder is not counted.
    assert_eq!(no_cover, 1);
    // "Unknown" is no genre: A/One/01, B/Two/01 and the loose track.
    assert_eq!(no_meta, 3);
    assert_eq!(loose, 1);

    // A partial selection counts only what the guest sees.
    rekord_core::selection::write_library_selection(
        &hub.data,
        &guest,
        &rekord_core::selection::LibrarySelection {
            albums: vec!["B/Two".into()],
            ..Default::default()
        },
    )
    .unwrap();
    let part = hub.send(req(Method::GET, &uri).build()).await.json();
    assert_eq!(pick(&part), [1, 0, pick(&part)[2], 1, 0]);
}

// ------------------------------------------------- covers, media, caching

#[tokio::test]
async fn covers_have_versions_etags_and_cacheable_404s() {
    let hub = Hub::new("covers");
    hub.file("A/WithCover/01.m4a", b"m4a-bytes");
    hub.file("A/WithCover/cover.jpg", b"\xFF\xD8\xFFjpeg");
    hub.file("A/NoCover/01.mp3", b"x");
    hub.state
        .run_scan_mode(ScanMode::Incremental)
        .await
        .unwrap();

    let albums = hub
        .send(req(Method::GET, "/api/v1/library/albums").build())
        .await
        .json();
    let list = albums["data"].as_array().unwrap();
    let with = list
        .iter()
        .find(|a| a["folder_key"] == "A/WithCover")
        .unwrap();
    let without = list
        .iter()
        .find(|a| a["folder_key"] == "A/NoCover")
        .unwrap();
    assert_eq!(with["has_cover"], true);
    assert!(with["cover_version"].is_string());
    assert!(with["updated_at"].is_string());
    assert_eq!(without["has_cover"], false);

    let tracks = hub
        .send(req(Method::GET, "/api/v1/library/tracks-page").build())
        .await
        .json();
    let t = tracks["data"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["rel_path"] == "A/WithCover/01.m4a")
        .unwrap()
        .clone();
    assert_eq!(t["has_cover"], true);
    assert_eq!(t["cover_version"], with["cover_version"]);

    let uri = format!(
        "/api/v1/covers/album/{}?v={}",
        with["id"],
        with["cover_version"].as_str().unwrap()
    );
    let res = hub.send(req(Method::GET, &uri).build()).await;
    assert_eq!(res.status, StatusCode::OK);
    let etag = res.header("etag").expect("etag");
    assert!(res.header("cache-control").unwrap().contains("immutable"));
    let again = hub
        .send(
            req(Method::GET, &uri)
                .header("if-none-match", &etag)
                .build(),
        )
        .await;
    assert_eq!(again.status, StatusCode::NOT_MODIFIED);

    let missing = hub
        .send(
            req(
                Method::GET,
                &format!("/api/v1/covers/album/{}", without["id"]),
            )
            .build(),
        )
        .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(
        missing.header("cache-control").as_deref(),
        Some("public, max-age=3600")
    );

    let media = hub
        .send(
            req(Method::GET, "/media/A/WithCover/01.m4a")
                .header("accept-encoding", "gzip")
                .build(),
        )
        .await;
    assert_eq!(media.header("content-type").as_deref(), Some("audio/mp4"));
    assert_eq!(
        media.header("cache-control").as_deref(),
        Some("private, max-age=31536000")
    );
    assert!(media.header("content-encoding").is_none());
}

#[tokio::test]
async fn json_responses_are_compressed() {
    let hub = Hub::new("gzip");
    for i in 0..40 {
        hub.file(&format!("Artist/Album/{i:02} - Track number {i}.mp3"), b"x");
    }
    hub.state
        .run_scan_mode(ScanMode::Incremental)
        .await
        .unwrap();
    let res = hub
        .send(
            req(Method::GET, "/api/v1/library/tracks-page")
                .header("accept-encoding", "gzip")
                .build(),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.header("content-encoding").as_deref(), Some("gzip"));
}

// ------------------------------------------------------ folder rescans

#[tokio::test]
async fn rescan_path_indexes_one_folder_and_bumps_the_epoch() {
    let hub = Hub::new("rescan-path");
    hub.file("A/Old/01.mp3", b"x");
    hub.file("B/Keep/01.mp3", b"x");
    let first = hub
        .state
        .run_scan_mode(ScanMode::Incremental)
        .await
        .unwrap();

    hub.file("A/New/01 - Fresh.mp3", b"x");
    // A file vanished elsewhere: a folder rescan must not prune it.
    fs::remove_file(hub.root.join("B/Keep/01.mp3")).unwrap();
    let epoch = hub.state.rescan_path("A/New").await.unwrap();
    assert_eq!(epoch, first.index_epoch + 1);

    let db = &hub.state.db;
    assert_eq!(track_title(db, "A/New/01 - Fresh.mp3"), "Fresh");
    assert!(db.track_by_rel("B/Keep/01.mp3").unwrap().is_some());
    let stats = db.stats(None).unwrap();
    assert_eq!(stats.index_epoch, epoch);
}

#[test]
fn sidecar_user_edits_beat_legacy_and_canonical_genre_labels_apply() {
    let lib = Lib::new("sidecar-user");
    lib.file(
        "Artist/Album/01 - Song.mp3",
        &mp3_with_tags(&[("TCON", "rnb; hip-hop")]),
    );
    lib.file(
        "Artist/Album/kord-trackinfo.json",
        br#"{"01 - Song.mp3":{"title":"Typed Title","userEdited":["title"]}}"#,
    );
    write_legacy_db(
        &lib.root.join(".kord/rekord.db"),
        r#"
        INSERT INTO albums(id, folder_rel_path, name, title) VALUES ('a', 'Artist/Album', 'Album', 'Album');
        INSERT INTO tracks(id, rel_path, album_id, title)
          VALUES ('t', 'Artist/Album/01 - Song.mp3', 'a', 'Legacy Title');
        "#,
    );
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();
    rekord_core::backup::sync_restored_library_metadata(&db, &lib.root).unwrap();
    scan_library_with(&db, &lib.root, ScanMode::Full).unwrap();
    let id = db
        .track_id_by_rel("Artist/Album/01 - Song.mp3")
        .unwrap()
        .unwrap();
    let t = db.get_library_track(id).unwrap().unwrap();
    assert_eq!(t.title, "Typed Title");
    assert!(t.user_edited);
    assert_eq!(t.genres, vec!["R&B", "Hip Hop"]);
    // A later legacy merge does not replace what the person typed.
    rekord_core::backup::import_legacy_library_db_metadata(&db, &lib.root.join(".kord/rekord.db"))
        .unwrap();
    assert_eq!(
        track_title(&db, "Artist/Album/01 - Song.mp3"),
        "Typed Title"
    );
}

/// `genre_count` in the stats follows track edits and deletes at once, not
/// only after the next scan rebuilds the genre table.
#[test]
fn genre_count_follows_track_edits_and_deletes() {
    let lib = Lib::new("genre-count");
    for (rel, genre) in [
        ("A/X/01.mp3", "Rock"),
        ("A/X/02.mp3", "Jazz"),
        ("A/X/03.mp3", "Rock; rock"),
    ] {
        lib.file(rel, &mp3_with_tags(&[("TIT2", "t"), ("TCON", genre)]));
    }
    let db = lib.db();
    scan_library(&db, &lib.root).unwrap();
    let count = |db: &Db| db.stats(None).unwrap().genre_count;
    assert_eq!(count(&db), 2);

    // Jazz → Blues: still two genres, but a new one.
    db.save_track_fields("A/X/02.mp3", None, Some("Blues"), None, None)
        .unwrap();
    assert_eq!(count(&db), 2);
    // Both Rock tracks become Blues: Rock is gone.
    db.save_track_fields("A/X/01.mp3", None, Some("Blues"), None, None)
        .unwrap();
    assert_eq!(count(&db), 2, "the other Rock track still counts");
    db.save_track_fields("A/X/03.mp3", None, Some("Blues"), None, None)
        .unwrap();
    assert_eq!(count(&db), 1);
    // A second genre on one track, a spelling variant on another.
    db.save_track_fields("A/X/01.mp3", None, Some("Blues; Funk"), None, None)
        .unwrap();
    db.save_track_fields("A/X/02.mp3", None, Some("blues"), None, None)
        .unwrap();
    assert_eq!(count(&db), 2);
    // The only Funk track goes away.
    assert!(db.delete_track_by_rel("A/X/01.mp3").unwrap());
    assert_eq!(count(&db), 1);

    // What a full rebuild finds is what the edits kept.
    db.rebuild_genres().unwrap();
    assert_eq!(count(&db), 1);
}
