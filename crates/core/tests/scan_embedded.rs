//! Embedded tags and covers (5.1): mapping per format, multi-value genres,
//! precedence over Studio values, embedded covers vs folder images, changed
//! files, the backfill of libraries indexed before 5.1, broken pictures.
//!
//! Fixtures are tiny silent files (`tests/fixtures/embedded`); tags and
//! pictures are written into copies at test time with lofty.

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::{ItemKey, ItemValue, Tag, TagItem, TagType};
use rekord_core::db::{CuratedTrackMeta, CuratedWrite, Db, LibraryTrack};
use rekord_core::embedded::{backfill, EmbeddedOptions, EmbeddedPriority, MergePolicy};
use rekord_core::scan::{scan_library_opts, ScanMode, ScanOptions};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/embedded");

struct Lib {
    base: PathBuf,
    root: PathBuf,
    data: PathBuf,
    db: Db,
}

impl Drop for Lib {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

impl Lib {
    fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join(format!("rekord-emb-{tag}-{}", uuid::Uuid::new_v4()));
        let root = base.join("music");
        let data = base.join("data");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&data).unwrap();
        let db = Db::open(data.join("rekord.db")).unwrap();
        Self {
            base,
            root,
            data,
            db,
        }
    }

    fn options(&self, priority: EmbeddedPriority) -> EmbeddedOptions {
        EmbeddedOptions {
            enabled: true,
            priority,
            cover_store: Some(self.data.join("covers").join("embedded")),
        }
    }

    fn scan_with(&self, embedded: EmbeddedOptions, mode: ScanMode) {
        self.db
            .set_prefer_embedded(embedded.priority == EmbeddedPriority::Embedded);
        scan_library_opts(
            &self.db,
            &self.root,
            ScanOptions {
                mode,
                embedded,
                ..Default::default()
            },
        )
        .unwrap();
    }

    fn scan(&self) {
        self.scan_with(
            self.options(EmbeddedPriority::Studio),
            ScanMode::Incremental,
        );
    }

    /// Copy a fixture to `rel` and return its path.
    fn add(&self, fixture: &str, rel: &str) -> PathBuf {
        let dest = self.root.join(rel);
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::copy(Path::new(FIXTURES).join(fixture), &dest).unwrap();
        dest
    }

    fn track(&self, rel: &str) -> LibraryTrack {
        let id = self.db.track_id_by_rel(rel).unwrap().expect(rel);
        self.db.get_library_track(id).unwrap().unwrap()
    }

    fn album(&self, folder_key: &str) -> rekord_core::db::Album {
        self.db
            .list_albums()
            .unwrap()
            .into_iter()
            .find(|a| a.folder_key == folder_key)
            .expect(folder_key)
    }
}

/// A small JPEG (or a PNG of the given size) as picture bytes.
fn image_bytes(w: u32, h: u32, format: image::ImageFormat) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 90])
    });
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut Cursor::new(&mut out), format)
        .unwrap();
    out
}

fn jpeg() -> Vec<u8> {
    image_bytes(48, 48, image::ImageFormat::Jpeg)
}

/// Tags to write; multi-value keys repeat.
#[derive(Default, Clone)]
struct Tags {
    items: Vec<(ItemKey, String)>,
    picture: Option<(PictureType, Vec<u8>)>,
    tag_type: Option<TagType>,
}

impl Tags {
    fn with(mut self, key: ItemKey, value: &str) -> Self {
        self.items.push((key, value.to_string()));
        self
    }

    fn picture(mut self, ty: PictureType, data: Vec<u8>) -> Self {
        self.picture = Some((ty, data));
        self
    }

    fn full() -> Self {
        Tags::default()
            .with(ItemKey::TrackTitle, "Embedded Title")
            .with(ItemKey::TrackArtist, "Tag Artist")
            .with(ItemKey::AlbumArtist, "Tag Album Artist")
            .with(ItemKey::AlbumTitle, "Tag Album")
            .with(ItemKey::TrackNumber, "3")
            .with(ItemKey::TrackTotal, "12")
            .with(ItemKey::DiscNumber, "1")
            .with(ItemKey::DiscTotal, "2")
            .with(ItemKey::RecordingDate, "2019-05-17")
            .with(ItemKey::Genre, "Trip Hop")
            .with(ItemKey::Bpm, "96")
            .with(ItemKey::IntegerBpm, "96")
            .with(
                ItemKey::Lyrics,
                "[00:01.00]first line\n[00:03.00]second line",
            )
            .with(
                ItemKey::MusicBrainzReleaseId,
                "11111111-2222-3333-4444-555555555555",
            )
            .with(
                ItemKey::MusicBrainzRecordingId,
                "66666666-7777-8888-9999-000000000000",
            )
            .picture(PictureType::CoverFront, jpeg())
    }
}

/// Replace the file's tags with `tags` (lofty, the format's primary tag
/// unless `tag_type` says otherwise) and bump its mtime.
fn write_tags(path: &Path, tags: &Tags) {
    let mut file = Probe::open(path)
        .unwrap()
        .guess_file_type()
        .unwrap()
        .read()
        .unwrap();
    let ty = tags.tag_type.unwrap_or_else(|| file.primary_tag_type());
    file.clear();
    let mut tag = Tag::new(ty);
    for (key, value) in &tags.items {
        let item = TagItem::new(key.clone(), ItemValue::Text(value.clone()));
        tag.push(item);
    }
    if let Some((ty, data)) = &tags.picture {
        let mime = if data.starts_with(&[0x89, b'P']) {
            MimeType::Png
        } else {
            MimeType::Jpeg
        };
        tag.push_picture(Picture::new_unchecked(*ty, Some(mime), None, data.clone()));
    }
    file.insert_tag(tag);
    file.save_to_path(path, WriteOptions::default()).unwrap();
    touch(path);
}

/// Move the mtime forward so an incremental scan sees a change.
fn touch(path: &Path) {
    static BUMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(10);
    let secs = BUMP.fetch_add(10, std::sync::atomic::Ordering::SeqCst);
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::now() + Duration::from_secs(secs))
        .unwrap();
}

fn assert_full_mapping(lib: &Lib, rel: &str, what: &str) {
    let t = lib.track(rel);
    assert_eq!(t.title, "Embedded Title", "{what}: title");
    assert_eq!(
        t.track_artist.as_deref(),
        Some("Tag Artist"),
        "{what}: artist"
    );
    assert_eq!(
        t.album_artist.as_deref(),
        Some("Tag Album Artist"),
        "{what}: album artist"
    );
    assert_eq!(t.album_name, "Tag Album", "{what}: album");
    assert_eq!(t.track_number, Some(3), "{what}: track");
    assert_eq!(t.track_total, Some(12), "{what}: track total");
    assert_eq!(t.disc_number, Some(1), "{what}: disc");
    assert_eq!(t.disc_total, Some(2), "{what}: disc total");
    assert_eq!(
        t.release_date.as_deref(),
        Some("2019-05-17"),
        "{what}: date"
    );
    assert_eq!(t.genres, vec!["Trip Hop".to_string()], "{what}: genre");
    assert_eq!(t.bpm, Some(96.0), "{what}: bpm");
    assert!(
        t.lyrics
            .as_deref()
            .is_some_and(|l| l.contains("second line")),
        "{what}: lyrics {:?}",
        t.lyrics
    );
    let mb = t.musicbrainz.clone().unwrap_or_default();
    assert_eq!(
        mb.release_id.as_deref(),
        Some("11111111-2222-3333-4444-555555555555"),
        "{what}: mb release"
    );
    for f in [
        "title",
        "genre",
        "release_date",
        "track_number",
        "lyrics",
        "artist",
    ] {
        assert!(
            t.embedded_fields.iter().any(|e| e == f),
            "{what}: {f} not embedded: {:?}",
            t.embedded_fields
        );
    }
    assert!(
        t.curated_fields.is_empty(),
        "{what}: {:?}",
        t.curated_fields
    );
}

#[test]
fn every_lofty_format_maps_its_tags_and_cover() {
    let lib = Lib::new("formats");
    let formats = [
        ("silent.mp3", "mp3"),
        ("silent.flac", "flac"),
        ("silent.ogg", "ogg"),
        ("silent.opus", "opus"),
        ("silent.m4a", "m4a"),
        ("silent.wav", "wav"),
        ("silent.aiff", "aiff"),
    ];
    for (fixture, ext) in formats {
        let rel = format!("Folder Artist/{ext} album/01 - file.{ext}");
        let path = lib.add(fixture, &rel);
        write_tags(&path, &Tags::full());
    }
    lib.scan();
    for (_, ext) in formats {
        let rel = format!("Folder Artist/{ext} album/01 - file.{ext}");
        assert_full_mapping(&lib, &rel, ext);
        let album = lib.album(&format!("Folder Artist/{ext} album"));
        assert!(album.has_cover, "{ext}: no embedded cover");
        assert_eq!(album.cover_source.as_deref(), Some("embedded"), "{ext}");
        assert_eq!(
            album.album_artist.as_deref(),
            Some("Tag Album Artist"),
            "{ext}"
        );
        assert_eq!(
            album.musicbrainz_release_id.as_deref(),
            Some("11111111-2222-3333-4444-555555555555"),
            "{ext}"
        );
        let cover = lib.db.album_cover_path(album.id).unwrap().unwrap();
        assert!(
            cover.starts_with(lib.data.join("covers")),
            "{ext}: {cover:?}"
        );
        assert!(album.cover_version.is_some());
    }
    // Nothing was written next to the music.
    for entry in walk(&lib.root) {
        let name = entry.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            name.starts_with("01 - file."),
            "unexpected file in the library: {entry:?}"
        );
    }
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

#[test]
fn id3v1_only_and_riff_info_fill_in_too() {
    let lib = Lib::new("v1");
    let mp3 = lib.add("silent.mp3", "A/B/01 - x.mp3");
    write_tags(
        &mp3,
        &Tags {
            tag_type: Some(TagType::Id3v1),
            ..Tags::default()
                .with(ItemKey::TrackTitle, "Old Title")
                .with(ItemKey::Genre, "Rock")
                .with(ItemKey::Year, "1994")
        },
    );
    let wav = lib.add("silent.wav", "A/B/02 - y.wav");
    write_tags(
        &wav,
        &Tags {
            tag_type: Some(TagType::RiffInfo),
            ..Tags::default()
                .with(ItemKey::TrackTitle, "Riff Title")
                .with(ItemKey::TrackArtist, "Riff Artist")
        },
    );
    lib.scan();
    let t = lib.track("A/B/01 - x.mp3");
    assert_eq!(t.title, "Old Title");
    assert_eq!(t.genres, vec!["Rock".to_string()]);
    assert_eq!(t.release_date.as_deref(), Some("1994"));
    let w = lib.track("A/B/02 - y.wav");
    assert_eq!(w.title, "Riff Title");
    assert_eq!(w.track_artist.as_deref(), Some("Riff Artist"));
}

#[test]
fn multi_value_genres_are_split_and_deduplicated() {
    let lib = Lib::new("genres");
    let flac = lib.add("silent.flac", "A/B/01 - x.flac");
    write_tags(
        &flac,
        &Tags::default()
            .with(ItemKey::Genre, "Hip Hop")
            .with(ItemKey::Genre, "Pop Rap; Trap")
            .with(ItemKey::Genre, "hip-hop"),
    );
    let mp3 = lib.add("silent.mp3", "A/B/02 - y.mp3");
    write_tags(
        &mp3,
        &Tags::default().with(ItemKey::Genre, "Rock/Alternative, Grunge"),
    );
    lib.scan();
    let t = lib.track("A/B/01 - x.flac");
    assert_eq!(t.genres, vec!["Hip Hop", "Pop Rap", "Trap"]);
    let m = lib.track("A/B/02 - y.mp3");
    assert_eq!(m.genres, vec!["Rock", "Alternative", "Grunge"]);
}

#[test]
fn studio_values_are_never_overwritten_by_tags() {
    let lib = Lib::new("studio");
    let rel = "A/B/01 - x.flac";
    let path = lib.add("silent.flac", rel);
    write_tags(&path, &Tags::full());
    lib.scan();

    // A person types a title and a genre; a fetch brings a date and lyrics.
    lib.db
        .save_track_fields(rel, Some("My Title"), Some("Jazz"), None, None)
        .unwrap();
    lib.db
        .apply_curated_track(
            rel,
            &CuratedTrackMeta {
                release_date: Some("2001-01-01".into()),
                ..Default::default()
            },
            CuratedWrite::Override,
        )
        .unwrap();

    // The file changes: tags are read again.
    write_tags(&path, &Tags::full().with(ItemKey::Comment, "changed"));
    lib.scan();
    let t = lib.track(rel);
    assert_eq!(t.title, "My Title");
    assert_eq!(t.genres, vec!["Jazz".to_string()]);
    assert_eq!(t.release_date.as_deref(), Some("2001-01-01"));
    assert!(t.curated_fields.contains(&"title".to_string()));
    assert!(!t.embedded_fields.contains(&"title".to_string()));
    // Fields nobody curated keep following the tags.
    assert_eq!(t.track_number, Some(3));

    // A full rescan changes nothing either.
    lib.scan_with(lib.options(EmbeddedPriority::Studio), ScanMode::Full);
    assert_eq!(lib.track(rel).title, "My Title");

    // Embedded priority: the fetched date gives way to the tag, typed values stay.
    write_tags(&path, &Tags::full().with(ItemKey::Comment, "again"));
    lib.scan_with(
        lib.options(EmbeddedPriority::Embedded),
        ScanMode::Incremental,
    );
    let t = lib.track(rel);
    assert_eq!(t.release_date.as_deref(), Some("2019-05-17"));
    assert!(t.embedded_fields.contains(&"release_date".to_string()));
    assert_eq!(t.title, "My Title");
    assert_eq!(t.genres, vec!["Jazz".to_string()]);

    // Only the admin's explicit re-read with "replace Studio too" does.
    lib.db.reset_embedded_markers().unwrap();
    let opts = lib.options(EmbeddedPriority::Embedded);
    while backfill::tag_batch(
        &lib.db,
        &opts,
        MergePolicy {
            prefer_embedded: true,
            override_user: true,
        },
    )
    .unwrap()
        > 0
    {}
    let t = lib.track(rel);
    assert_eq!(t.title, "Embedded Title");
    assert_eq!(t.genres, vec!["Trip Hop".to_string()]);
    assert!(!t.user_edited);
}

#[test]
fn sidecar_fills_do_not_replace_tags_with_the_embedded_priority() {
    let lib = Lib::new("fill");
    let rel = "A/B/01 - x.flac";
    let path = lib.add("silent.flac", rel);
    write_tags(&path, &Tags::default().with(ItemKey::Genre, "Shoegaze"));
    let fill = CuratedTrackMeta {
        genre: Some("Indie".into()),
        ..Default::default()
    };
    lib.scan_with(
        lib.options(EmbeddedPriority::Embedded),
        ScanMode::Incremental,
    );
    lib.db
        .apply_curated_track(rel, &fill, CuratedWrite::FillUncurated)
        .unwrap();
    assert_eq!(lib.track(rel).genres, vec!["Shoegaze".to_string()]);

    // Studio priority: the sidecar (curated) value wins over the tag.
    lib.db.set_prefer_embedded(false);
    lib.db
        .apply_curated_track(rel, &fill, CuratedWrite::FillUncurated)
        .unwrap();
    assert_eq!(lib.track(rel).genres, vec!["Indie".to_string()]);
}

#[test]
fn a_changed_file_is_read_again_and_removed_tags_fall_back_to_the_file_name() {
    let lib = Lib::new("changed");
    let rel = "A/B/07 - From The Name.m4a";
    let path = lib.add("silent.m4a", rel);
    write_tags(
        &path,
        &Tags::default()
            .with(ItemKey::TrackTitle, "First")
            .with(ItemKey::Genre, "Ambient")
            .with(ItemKey::TrackNumber, "2"),
    );
    lib.scan();
    let t = lib.track(rel);
    assert_eq!((t.title.as_str(), t.track_number), ("First", Some(2)));

    write_tags(&path, &Tags::default().with(ItemKey::TrackTitle, "Second"));
    lib.scan();
    let t = lib.track(rel);
    assert_eq!(t.title, "Second");
    // The tag lost its genre and number: the file name says 07, no genre.
    assert_eq!(t.track_number, Some(7));
    assert!(t.genres.is_empty(), "{:?}", t.genres);
    assert!(!t.embedded_fields.contains(&"genre".to_string()));

    write_tags(&path, &Tags::default());
    lib.scan();
    assert_eq!(lib.track(rel).title, "From The Name");
}

#[test]
fn embedded_covers_only_stand_in_for_missing_folder_images() {
    let lib = Lib::new("covers");
    // Album with a folder image: the folder wins.
    let a = lib.add("silent.flac", "A/With Folder/01 - x.flac");
    write_tags(&a, &Tags::full());
    fs::write(
        lib.root.join("A/With Folder/cover.jpg"),
        image_bytes(32, 32, image::ImageFormat::Jpeg),
    )
    .unwrap();
    // Album without: the picture of a track; the front cover beats others.
    let b1 = lib.add("silent.mp3", "A/No Folder/01 - x.mp3");
    write_tags(
        &b1,
        &Tags::default().picture(
            PictureType::Artist,
            image_bytes(20, 20, image::ImageFormat::Jpeg),
        ),
    );
    let b2 = lib.add("silent.mp3", "A/No Folder/02 - y.mp3");
    write_tags(
        &b2,
        &Tags::default().picture(
            PictureType::CoverFront,
            image_bytes(2400, 1200, image::ImageFormat::Png),
        ),
    );
    lib.scan();

    let with = lib.album("A/With Folder");
    assert_eq!(with.cover_source.as_deref(), Some("folder"));
    let path = lib.db.album_cover_path(with.id).unwrap().unwrap();
    assert_eq!(path.file_name().unwrap(), "cover.jpg");

    let without = lib.album("A/No Folder");
    assert_eq!(without.cover_source.as_deref(), Some("embedded"));
    let stored = lib.db.album_cover_path(without.id).unwrap().unwrap();
    let img = image::open(&stored).unwrap();
    // The PNG front cover, scaled to 1500 px and stored as JPEG.
    assert_eq!((img.width(), img.height()), (1500, 750));
    let version = without.cover_version.clone();

    // Unchanged rescan: same file, same version (no cache busting churn).
    lib.scan();
    assert_eq!(lib.album("A/No Folder").cover_version, version);

    // A cover saved from Studio (folder image) takes over; the stored copy goes.
    fs::write(
        lib.root.join("A/No Folder/cover.jpg"),
        image_bytes(32, 32, image::ImageFormat::Jpeg),
    )
    .unwrap();
    lib.scan();
    let now = lib.album("A/No Folder");
    assert_eq!(now.cover_source.as_deref(), Some("folder"));
    // Kept for a while (a cover saved moments ago may not be on its album
    // row yet), pruned once it is old.
    assert!(stored.exists(), "fresh cover pruned");
    fs::File::options()
        .write(true)
        .open(&stored)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(3600))
        .unwrap();
    lib.scan_with(lib.options(EmbeddedPriority::Studio), ScanMode::Full);
    assert!(!stored.exists(), "unused embedded cover kept");

    // With the setting off no picture is used.
    fs::remove_file(lib.root.join("A/No Folder/cover.jpg")).unwrap();
    let mut off = lib.options(EmbeddedPriority::Studio);
    off.enabled = false;
    lib.scan_with(off, ScanMode::Incremental);
    assert!(!lib.album("A/No Folder").has_cover);
    // And back on, it comes back.
    lib.scan_with(lib.options(EmbeddedPriority::Studio), ScanMode::Full);
    assert_eq!(
        lib.album("A/No Folder").cover_source.as_deref(),
        Some("embedded")
    );
}

#[test]
fn corrupt_and_huge_pictures_never_cost_the_tags() {
    let lib = Lib::new("corrupt");
    // A picture block that is not an image.
    let bad = lib.add("silent.flac", "A/Bad/01 - x.flac");
    let mut junk = vec![0xFF, 0xD8, 0xFF, 0xE0];
    junk.extend(std::iter::repeat_n(0x42u8, 4096));
    write_tags(
        &bad,
        &Tags::default()
            .with(ItemKey::TrackTitle, "Still Here")
            .picture(PictureType::CoverFront, junk),
    );
    // An APIC larger than lofty's 16 MiB allocation limit: tags are read,
    // the picture is too big to be used.
    let huge = lib.root.join("A/Huge/01 - x.mp3");
    fs::create_dir_all(huge.parent().unwrap()).unwrap();
    let mut big = jpeg();
    big.resize(17 * 1024 * 1024, 0);
    fs::write(
        &huge,
        mp3_with_id3(&[
            ("TIT2", b"\0Big Art".to_vec()),
            ("TCON", b"\0Drone".to_vec()),
            ("APIC", apic(&big)),
        ]),
    )
    .unwrap();
    lib.scan();
    assert_eq!(lib.track("A/Bad/01 - x.flac").title, "Still Here");
    let huge_t = lib.track("A/Huge/01 - x.mp3");
    assert_eq!(huge_t.title, "Big Art");
    assert_eq!(huge_t.genres, vec!["Drone".to_string()]);
    let bad_album = lib.album("A/Bad");
    assert!(!bad_album.has_cover);
    // Checked once: an unchanged rescan does not try again.
    assert_eq!(
        lib.db
            .album_embedded_cover_from("A/Bad")
            .unwrap()
            .as_deref(),
        Some("")
    );
    assert_eq!(lib.db.embedded_pending(1).unwrap(), (0, 0));
}

#[test]
fn webm_and_wma_are_read_through_ffmpeg() {
    let ffmpeg = rekord_core::tools::resolve_blocking(
        rekord_core::tools::Tool::Ffmpeg,
        &rekord_core::tools::ToolContext::default(),
    );
    if !ffmpeg.available {
        eprintln!("ffmpeg not available: skipped");
        return;
    }
    let lib = Lib::new("ffmpeg");
    lib.add("tagged.webm", "A/Web/01 - x.webm");
    lib.add("tagged.wma", "A/Wma/01 - y.wma");
    lib.scan();
    let w = lib.track("A/Web/01 - x.webm");
    assert_eq!(w.title, "Web Title");
    assert_eq!(w.track_artist.as_deref(), Some("Web Artist"));
    assert_eq!(w.album_name, "Web Album");
    assert_eq!(w.genres, vec!["Synthwave", "Electronic"]);
    assert_eq!(w.release_date.as_deref(), Some("2021-03-04"));
    assert_eq!(w.track_number, Some(3));
    assert!(w.duration_ms > 0);
    let m = lib.track("A/Wma/01 - y.wma");
    assert_eq!(m.title, "Wma Title");
    assert_eq!(m.genres, vec!["Jazz".to_string()]);
    assert_eq!(m.release_date.as_deref(), Some("1999"));
    assert_eq!(m.track_number, Some(5));
    assert_eq!(lib.album("A/Wma").cover_source.as_deref(), Some("embedded"));
}

/// ID3v2.3 tag with the given raw frames, then a few silent MPEG frames.
fn mp3_with_id3(frames: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (id, payload) in frames {
        body.extend_from_slice(id.as_bytes());
        body.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        body.extend_from_slice(&[0, 0]);
        body.extend_from_slice(payload);
    }
    let size = body.len() as u32;
    let mut out = b"ID3\x03\x00\x00".to_vec();
    out.extend_from_slice(&[
        ((size >> 21) & 0x7f) as u8,
        ((size >> 14) & 0x7f) as u8,
        ((size >> 7) & 0x7f) as u8,
        (size & 0x7f) as u8,
    ]);
    out.extend_from_slice(&body);
    for _ in 0..8 {
        out.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        out.extend_from_slice(&[0u8; 417 - 4]);
    }
    out
}

/// APIC payload: front cover, JPEG.
fn apic(data: &[u8]) -> Vec<u8> {
    let mut p = vec![0u8];
    p.extend_from_slice(b"image/jpeg\0");
    p.push(3);
    p.push(0);
    p.extend_from_slice(data);
    p
}

#[test]
fn vorbis_number_pairs_and_id3_in_flac_are_read() {
    let lib = Lib::new("pairs");
    let flac = lib.add("silent.flac", "A/B/x.flac");
    write_tags(
        &flac,
        &Tags::default()
            .with(ItemKey::TrackNumber, "4/11")
            .with(ItemKey::DiscNumber, "2/2"),
    );
    lib.scan();
    let t = lib.track("A/B/x.flac");
    assert_eq!((t.track_number, t.track_total), (Some(4), Some(11)));
    assert_eq!((t.disc_number, t.disc_total), (Some(2), Some(2)));

    // A FLAC whose only tag is an ID3v2 block in front of `fLaC`.
    let tagged = lib.root.join("A/C/y.flac");
    fs::create_dir_all(tagged.parent().unwrap()).unwrap();
    let id3 = mp3_with_id3(&[("TIT2", b"\0Id3 In Flac".to_vec())]);
    let id3_len = id3.len() - 8 * 417;
    let mut bytes = id3[..id3_len].to_vec();
    bytes.extend_from_slice(&fs::read(Path::new(FIXTURES).join("silent.flac")).unwrap());
    fs::write(&tagged, bytes).unwrap();
    lib.scan();
    assert_eq!(lib.track("A/C/y.flac").title, "Id3 In Flac");
}

/// A library indexed by 5.0 (schema v6): the v7 migration keeps every value,
/// the backfill reads what the tags add, fills covers, and keeps lyrics
/// that came from elsewhere.
#[test]
fn the_backfill_completes_a_library_indexed_before_5_1() {
    let lib = Lib::new("backfill");
    let rel = "A/B/01 - x.flac";
    let path = lib.add("silent.flac", rel);
    write_tags(&path, &Tags::full());
    let rel2 = "A/B/02 - y.flac";
    let path2 = lib.add("silent.flac", rel2);
    write_tags(
        &path2,
        &Tags::default().with(ItemKey::Lyrics, "lyrics in the file"),
    );
    lib.scan();
    // Studio value set under 5.0, and lyrics fetched from LRCLIB.
    lib.db
        .save_track_fields(rel, Some("Typed"), None, None, None)
        .unwrap();
    lib.db
        .with_conn(|c| {
            c.execute(
                "UPDATE tracks SET lyrics = 'fetched lyrics' WHERE rel_path = ?1",
                [rel],
            )?;
            Ok(())
        })
        .unwrap();
    drop(downgrade_to_v6(&lib));

    // 5.1 opens it: migration v7, nothing re-read yet.
    let db = Db::open(lib.data.join("rekord.db")).unwrap();
    assert_eq!(db.schema_version().unwrap(), 7);
    let before = {
        let id = db.track_id_by_rel(rel).unwrap().unwrap();
        db.get_library_track(id).unwrap().unwrap()
    };
    assert_eq!(before.title, "Typed");
    assert!(before.track_artist.is_none());
    assert_eq!(db.embedded_pending(1).unwrap(), (2, 1));

    let opts = lib.options(EmbeddedPriority::Studio);
    let policy = opts.merge_policy();
    let mut rounds = 0;
    while backfill::tag_batch(&db, &opts, policy).unwrap() > 0 {
        rounds += 1;
    }
    assert_eq!(rounds, 1);
    while backfill::cover_batch(&db, &opts).unwrap().0 > 0 {}
    assert_eq!(db.embedded_pending(1).unwrap(), (0, 0));

    let get = |rel: &str| {
        let id = db.track_id_by_rel(rel).unwrap().unwrap();
        db.get_library_track(id).unwrap().unwrap()
    };
    let t = get(rel);
    assert_eq!(t.title, "Typed", "typed title kept");
    assert_eq!(t.track_artist.as_deref(), Some("Tag Artist"));
    assert_eq!(t.track_total, Some(12));
    // Lyrics from elsewhere stay; the ones equal to the file become embedded.
    assert_eq!(t.lyrics.as_deref(), Some("fetched lyrics"));
    assert!(t.curated_fields.contains(&"lyrics".to_string()));
    let t2 = get(rel2);
    assert_eq!(t2.lyrics.as_deref(), Some("lyrics in the file"));
    assert!(t2.embedded_fields.contains(&"lyrics".to_string()));
    assert!(!t2.curated_fields.contains(&"lyrics".to_string()));

    let album = db
        .list_albums()
        .unwrap()
        .into_iter()
        .find(|a| a.folder_key == "A/B")
        .unwrap();
    assert_eq!(album.cover_source.as_deref(), Some("embedded"));
    assert_eq!(album.name, "Tag Album");
}

/// Bring a v7 database back to the v6 shape (as 5.0 left it).
fn downgrade_to_v6(lib: &Lib) -> rusqlite::Connection {
    let path = lib.data.join("rekord.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        r#"
        DROP INDEX IF EXISTS idx_tracks_tags_version;
        UPDATE tracks SET edited_fields = edited_fields & ~32, user_fields = user_fields & ~32;
        UPDATE albums SET has_cover = 0, cover_path = NULL, cover_version = NULL;
        ALTER TABLE tracks DROP COLUMN tag_artist;
        ALTER TABLE tracks DROP COLUMN tag_album_artist;
        ALTER TABLE tracks DROP COLUMN track_total;
        ALTER TABLE tracks DROP COLUMN disc_total;
        ALTER TABLE tracks DROP COLUMN mb_recording_id;
        ALTER TABLE tracks DROP COLUMN mb_release_id;
        ALTER TABLE tracks DROP COLUMN mb_artist_id;
        ALTER TABLE tracks DROP COLUMN mb_release_group_id;
        ALTER TABLE tracks DROP COLUMN embedded_fields;
        ALTER TABLE tracks DROP COLUMN tags_version;
        ALTER TABLE albums DROP COLUMN cover_source;
        ALTER TABLE albums DROP COLUMN embedded_cover_from;
        ALTER TABLE albums DROP COLUMN tag_album_artist;
        ALTER TABLE albums DROP COLUMN embedded_fields;
        PRAGMA user_version = 6;
        "#,
    )
    .unwrap();
    conn
}

/// Files in the library root are grouped by artist exactly like 5.0 did: the
/// group is part of their `rel_path`, which favorites and playlists hang on.
#[test]
fn root_files_keep_their_5_0_group() {
    let lib = Lib::new("rootgroup");
    // Not readable by lofty: 5.0 put it under the virtual artist.
    lib.add("tagged.webm", "loose.webm");
    // Two ARTIST fields: 5.0 took the first one.
    let flac = lib.add("silent.flac", "two.flac");
    write_tags(
        &flac,
        &Tags::default()
            .with(ItemKey::TrackArtist, "First")
            .with(ItemKey::TrackArtist, "Second")
            .with(ItemKey::TrackTitle, "Two"),
    );
    lib.scan();
    let virtual_artist = rekord_core::layout::LibraryLayout::default().virtual_artist;
    assert!(lib
        .db
        .track_id_by_rel(&format!("{virtual_artist}/Tracks/loose.webm"))
        .unwrap()
        .is_some());
    assert!(lib
        .db
        .track_id_by_rel("First/Tracks/two.flac")
        .unwrap()
        .is_some());
}

/// The backfill never wipes values of a file it cannot read, and never
/// writes over a row a scan changed (or removed) since it was listed.
#[test]
fn the_backfill_skips_unreadable_files_and_rows_changed_meanwhile() {
    let lib = Lib::new("bfguard");
    let rel = "A/B/01 - x.flac";
    let path = lib.add("silent.flac", rel);
    write_tags(&path, &Tags::full());
    let rel2 = "A/B/02 - y.flac";
    let path2 = lib.add("silent.flac", rel2);
    write_tags(&path2, &Tags::full());
    lib.scan();
    let opts = lib.options(EmbeddedPriority::Studio);
    let set_pending = || {
        lib.db
            .with_conn(|c| {
                c.execute("UPDATE tracks SET tags_version = 0", [])?;
                Ok(())
            })
            .unwrap();
    };

    // Unreadable (no permission): values kept, the track is not re-read.
    // Unix only: mode bits are how the test makes a file unreadable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let before = lib.track(rel);
        set_pending();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let readable_anyway = fs::File::open(&path).is_ok(); // running as root
        while backfill::tag_batch(&lib.db, &opts, opts.merge_policy()).unwrap() > 0 {}
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        if !readable_anyway {
            let after = lib.track(rel);
            assert_eq!(after.title, before.title);
            assert_eq!(after.genres, before.genres);
            assert_eq!(after.album_name, before.album_name);
        }
    }

    // A row the scan rewrote since it was listed: the scan's values stay.
    set_pending();
    let pending = lib.db.embedded_pending_tracks(1, 10).unwrap();
    assert_eq!(pending.len(), 2);
    lib.db
        .with_conn(|c| {
            c.execute(
                "UPDATE tracks SET size = size + 1, title = 'From the scan' WHERE rel_path = ?1",
                [rel2],
            )?;
            Ok(())
        })
        .unwrap();
    lib.db
        .write_batch(|w| {
            let t2 = pending.iter().find(|t| t.rel_path == rel2).unwrap();
            assert!(!w.pending_track_unchanged(t2, 1)?);
            let t1 = pending.iter().find(|t| t.rel_path == rel).unwrap();
            assert!(w.pending_track_unchanged(t1, 1)?);
            Ok(())
        })
        .unwrap();
    // Removed by a scan: not brought back.
    let id2 = lib.db.track_id_by_rel(rel2).unwrap().unwrap();
    lib.db
        .with_conn(|c| {
            c.execute("DELETE FROM tracks WHERE id = ?1", [id2])?;
            Ok(())
        })
        .unwrap();
    lib.db
        .write_batch(|w| {
            let t2 = pending.iter().find(|t| t.rel_path == rel2).unwrap();
            assert!(!w.pending_track_unchanged(t2, 1)?);
            Ok(())
        })
        .unwrap();
    while backfill::tag_batch(&lib.db, &opts, opts.merge_policy()).unwrap() > 0 {}
    assert!(lib.db.track_id_by_rel(rel2).unwrap().is_none());
    let _ = path2;
}

/// "Drum & Bass" and "Drum and Bass" (or "R&B" and "Rhythm & Blues") are one
/// genre in the library index, not two entries with split counts.
#[test]
fn ampersand_genre_aliases_are_one_library_genre() {
    let lib = Lib::new("ampgenres");
    for (i, g) in ["Drum & Bass", "Drum and Bass", "R&B", "Rhythm & Blues"]
        .iter()
        .enumerate()
    {
        let p = lib.add("silent.flac", &format!("A/B/0{i} - x.flac"));
        write_tags(&p, &Tags::default().with(ItemKey::Genre, g));
    }
    lib.scan();
    let labels = lib.db.genre_labels().unwrap();
    let mut shown: Vec<&String> = labels.values().collect();
    shown.sort();
    shown.dedup();
    assert_eq!(shown, vec!["Drum and Bass", "R&B"], "{labels:?}");
    assert_eq!(lib.track("A/B/00 - x.flac").genres, vec!["Drum and Bass"]);
    assert_eq!(lib.track("A/B/03 - x.flac").genres, vec!["R&B"]);
}
