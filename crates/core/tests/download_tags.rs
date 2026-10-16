//! Tags and covers of Studio downloads (5.2): the pass after yt-dlp writes
//! tags and a square cover into the files of this run only, saves
//! `cover.jpg` for an album folder without one, never touches files that
//! were already there or an existing cover.

use rekord_core::download_tags::{finish_downloads, FinishJob, META_MARKER};
use rekord_core::embedded::tags::{read_file, ReadRequest};
use rekord_core::ytdlp::ItemTracker;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/embedded");

struct Tmp(PathBuf);

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn tmp() -> Tmp {
    let dir = std::env::temp_dir().join(format!("rekord-dltags-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(dir.join("lib")).unwrap();
    Tmp(dir)
}

fn add(root: &Path, fixture: &str, rel: &str) -> PathBuf {
    let dest = root.join(rel);
    fs::create_dir_all(dest.parent().unwrap()).unwrap();
    fs::copy(Path::new(FIXTURES).join(fixture), &dest).unwrap();
    dest
}

/// A 1280×720 PNG "video thumbnail", whatever the URL.
fn wide_thumbnail(_url: &str) -> Option<Vec<u8>> {
    let img = image::RgbImage::from_pixel(1280, 720, image::Rgb([200, 30, 30]));
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    Some(out.into_inner())
}

const THUMB: &str = "https://i.ytimg.com/vi/x/maxresdefault.webp";

fn read(path: &Path) -> rekord_core::embedded::tags::FileRead {
    read_file(
        path,
        ReadRequest {
            tags: true,
            picture: true,
            properties: false,
        },
    )
}

fn picture_size(data: &[u8]) -> (u32, u32) {
    let img = image::load_from_memory(data).unwrap();
    (img.width(), img.height())
}

#[test]
fn album_download_gets_tags_square_covers_and_one_cover_jpg() {
    let t = tmp();
    let root = t.0.join("lib");
    let first = add(&root, "silent.m4a", "Band/Real Album/01 - Uno.m4a");
    let second = add(&root, "silent.opus", "Band/Real Album/02 - Due.opus");
    // Already in the folder before the run: yt-dlp reports it as such.
    let existing = add(&root, "silent.m4a", "Band/Real Album/03 - Tre.m4a");
    let before = fs::read(&existing).unwrap();

    let mut tracker = ItemTracker::new();
    let lines = [
        "[download] Downloading item 1 of 3".to_string(),
        "[rekord-item] vid00000001\t1\tUno".into(),
        "[download] Destination: Band/Real Album/01 - Uno.m4a".into(),
        format!(
            "{META_MARKER} {}",
            json!({"thumbnail": THUMB, "id": "vid00000001", "title": "Uno", "track": "Uno", "artists": ["Band", "Guest"],
                   "album": "Real Album", "uploader": "Band - Topic", "playlist_index": 1,
                   "n_entries": 3, "playlist_title": "Album - Real Album", "release_year": 2020,
                   "filepath": "Band/Real Album/01 - Uno.m4a"})
        ),
        "[download] Downloading item 2 of 3".into(),
        "[rekord-item] vid00000002\t2\tDue".into(),
        "[download] Destination: Band/Real Album/02 - Due.opus".into(),
        format!(
            "{META_MARKER} {}",
            json!({"thumbnail": THUMB, "id": "vid00000002", "title": "Due", "uploader": "Band - Topic",
                   "playlist_index": 2, "n_entries": 3, "filepath": "Band/Real Album/02 - Due.opus"})
        ),
        "[download] Downloading item 3 of 3".into(),
        "[rekord-item] vid00000003\t3\tTre".into(),
        "[download] Band/Real Album/03 - Tre.m4a has already been downloaded".into(),
        format!(
            "{META_MARKER} {}",
            json!({"thumbnail": THUMB, "id": "vid00000003", "title": "Tre", "playlist_index": 3,
                   "filepath": "Band/Real Album/03 - Tre.m4a"})
        ),
    ];
    for l in &lines {
        tracker.feed_line(l);
    }
    let summary = tracker.summary();
    assert_eq!((summary.downloaded, summary.skipped), (2, 1));

    let report = finish_downloads(
        &FinishJob {
            music_root: &root,
            kind: "download_playlist",
            fetch: &wide_thumbnail,
            ffmpeg: None,
            has_cover: &|_| false,
        },
        &summary.items,
    );
    assert_eq!((report.tagged, report.covers), (2, 2), "{report:?}");
    assert_eq!(
        report.cover_files,
        vec!["Band/Real Album/cover.jpg".to_string()]
    );
    assert!(report.failed.is_empty(), "{report:?}");

    let a = read(&first);
    assert_eq!(a.tags.title.as_deref(), Some("Uno"));
    assert_eq!(a.tags.artist.as_deref(), Some("Band"));
    assert_eq!(a.tags.album_artist.as_deref(), Some("Band"));
    assert_eq!(a.tags.album.as_deref(), Some("Real Album"));
    assert_eq!(
        (a.tags.track_number, a.tags.track_total),
        (Some(1), Some(3))
    );
    assert_eq!(a.tags.date.as_deref(), Some("2020"));
    let pic = a.picture.expect("embedded cover");
    assert_eq!(picture_size(&pic.data), (720, 720));

    let b = read(&second);
    assert_eq!(b.tags.artist.as_deref(), Some("Band"));
    assert_eq!(b.tags.album.as_deref(), Some("Real Album"));
    assert_eq!(b.tags.track_number, Some(2));
    assert_eq!(
        picture_size(&b.picture.expect("opus cover").data),
        (720, 720)
    );

    // The file that was already there is untouched.
    assert_eq!(fs::read(&existing).unwrap(), before);
    let cover = fs::read(root.join("Band/Real Album/cover.jpg")).unwrap();
    assert_eq!(picture_size(&cover), (720, 720));
}

#[test]
fn existing_cover_is_never_replaced_and_singles_save_none() {
    let t = tmp();
    let root = t.0.join("lib");
    add(&root, "silent.m4a", "Band/Album/05 - Five.m4a");
    fs::write(root.join("Band/Album/cover.jpg"), b"user cover").unwrap();
    let mut tracker = ItemTracker::new();
    for l in [
        "[rekord-item] vid00000005\tNA\tFive".to_string(),
        "[download] Destination: Band/Album/05 - Five.m4a".into(),
        format!(
            "{META_MARKER} {}",
            json!({"thumbnail": THUMB, "id": "vid00000005", "title": "Band - Five (Official Video)",
                   "uploader": "BandVEVO", "filepath": "Band/Album/05 - Five.m4a"})
        ),
    ] {
        tracker.feed_line(&l);
    }
    let items = tracker.summary().items;
    for kind in ["download_playlist", "download_single"] {
        let report = finish_downloads(
            &FinishJob {
                music_root: &root,
                kind,
                fetch: &wide_thumbnail,
                ffmpeg: None,
                has_cover: &|_| false,
            },
            &items,
        );
        assert_eq!(report.tagged, 1);
        assert!(report.cover_files.is_empty());
    }
    assert_eq!(
        fs::read(root.join("Band/Album/cover.jpg")).unwrap(),
        b"user cover"
    );
    let r = read(&root.join("Band/Album/05 - Five.m4a"));
    assert_eq!(r.tags.title.as_deref(), Some("Five"));
    assert_eq!(r.tags.artist.as_deref(), Some("Band"));
    assert_eq!(r.tags.track_number, Some(5));

    // An album whose cover the hub already knows (legacy artwork): no file.
    fs::remove_file(root.join("Band/Album/cover.jpg")).unwrap();
    let report = finish_downloads(
        &FinishJob {
            music_root: &root,
            kind: "download_playlist",
            fetch: &wide_thumbnail,
            ffmpeg: None,
            has_cover: &|folder| folder == "Band/Album",
        },
        &items,
    );
    assert!(report.cover_files.is_empty());
    assert!(!root.join("Band/Album/cover.jpg").exists());
}

#[test]
fn files_outside_the_library_are_ignored() {
    let t = tmp();
    let root = t.0.join("lib");
    let outside = add(&t.0, "silent.m4a", "elsewhere/x.m4a");
    let before = fs::read(&outside).unwrap();
    let mut tracker = ItemTracker::new();
    for l in [
        "[rekord-item] vid00000009\tNA\tX".to_string(),
        "[download] Destination: ../elsewhere/x.m4a".into(),
        format!(
            "{META_MARKER} {}",
            json!({"thumbnail": THUMB, "id": "vid00000009", "title": "X", "filepath": outside.to_string_lossy()})
        ),
    ] {
        tracker.feed_line(&l);
    }
    let report = finish_downloads(
        &FinishJob {
            music_root: &root,
            kind: "download_single",
            fetch: &wide_thumbnail,
            ffmpeg: None,
            has_cover: &|_| false,
        },
        &tracker.summary().items,
    );
    assert_eq!(report.tagged, 0);
    assert_eq!(fs::read(&outside).unwrap(), before);
}

/// WebM (YouTube's fallback format) cannot hold the tags: its Opus stream is
/// copied into an `.opus` file, which then gets them. Needs ffmpeg.
#[test]
fn webm_is_copied_into_opus_and_tagged() {
    let ffmpeg = rekord_core::tools::resolve_blocking(
        rekord_core::tools::Tool::Ffmpeg,
        &rekord_core::tools::ToolContext::default(),
    );
    if !ffmpeg.available {
        eprintln!("ffmpeg not found: skipped");
        return;
    }
    let t = tmp();
    let root = t.0.join("lib");
    add(&root, "tagged.webm", "Band/Album/01 - W.webm");
    let mut tracker = ItemTracker::new();
    for l in [
        "[rekord-item] vid0000000w\t1\tW".to_string(),
        "[download] Destination: Band/Album/01 - W.webm".into(),
        format!(
            "{META_MARKER} {}",
            json!({"thumbnail": THUMB, "id": "vid0000000w", "title": "W", "playlist_index": 1, "n_entries": 1,
                   "filepath": "Band/Album/01 - W.webm"})
        ),
    ] {
        tracker.feed_line(&l);
    }
    let report = finish_downloads(
        &FinishJob {
            music_root: &root,
            kind: "download_playlist",
            fetch: &wide_thumbnail,
            ffmpeg: Some(&ffmpeg.path),
            has_cover: &|_| false,
        },
        &tracker.summary().items,
    );
    assert_eq!(report.tagged, 1, "{report:?}");
    assert_eq!(
        report.renamed,
        vec![(
            "Band/Album/01 - W.webm".to_string(),
            "Band/Album/01 - W.opus".to_string()
        )]
    );
    assert!(!root.join("Band/Album/01 - W.webm").exists());
    let r = read(&root.join("Band/Album/01 - W.opus"));
    assert_eq!(r.tags.album.as_deref(), Some("Album"));
    assert_eq!(picture_size(&r.picture.expect("cover").data), (720, 720));
}
