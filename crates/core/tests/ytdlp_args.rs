//! yt-dlp argument builder, per-item summary attribution and char-safe log
//! slicing (studio QA items 1, 2, 6).

use rekord_core::ytdlp::{
    build_download_args, build_download_args_with, display_command, summary_from_log, tail_bytes,
    DownloadExtras, ItemTracker, RollLog, Toolchain, AUDIO_FORMAT, DONE_FIELD_MAX, ROLL_CAP,
};
use std::path::PathBuf;

fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

#[test]
fn args_are_audio_only_with_ffmpeg_and_absolute_js_runtime() {
    let tc = Toolchain {
        ytdlp: PathBuf::from("/opt/rekord/bin/yt-dlp"),
        ffmpeg: Some(PathBuf::from("/opt/rekord/bin/ffmpeg")),
        js_runtime: Some("node:/usr/local/bin/node".into()),
    };
    let url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    let args = build_download_args(&tc, url, "download_single", "Artist/Album", None).unwrap();
    let format = value_after(&args, "-f").unwrap();
    assert_eq!(format, AUDIO_FORMAT);
    assert!(
        !format.ends_with("/best"),
        "never fall back to a video format"
    );
    assert_eq!(
        value_after(&args, "--ffmpeg-location"),
        Some("/opt/rekord/bin/ffmpeg")
    );
    assert_eq!(
        value_after(&args, "--js-runtimes"),
        Some("node:/usr/local/bin/node")
    );
    assert!(args.iter().any(|a| a == "--no-playlist"));
    assert!(args
        .iter()
        .any(|a| a.starts_with("pre_process:[rekord-item]")));
    assert!(value_after(&args, "-o")
        .unwrap()
        .starts_with("Artist/Album/"));
    assert_eq!(args.last().map(String::as_str), Some(url));

    // Shown command: no absolute paths, no URL.
    let shown = display_command(&tc.ytdlp, &args);
    assert!(shown.starts_with("yt-dlp "));
    assert!(!shown.contains("/opt/rekord"), "{shown}");
    assert!(!shown.contains("/usr/local/bin/node"), "{shown}");
    assert!(!shown.contains("dQw4w9WgXcQ"), "{shown}");
}

#[test]
fn args_omit_js_runtime_and_ffmpeg_when_missing() {
    let tc = Toolchain {
        ytdlp: PathBuf::from("yt-dlp"),
        ffmpeg: None,
        js_runtime: None,
    };
    let args = build_download_args(
        &tc,
        "https://www.youtube.com/playlist?list=PL123",
        "download_playlist",
        "",
        None,
    )
    .unwrap();
    assert!(!args.iter().any(|a| a == "--js-runtimes"));
    assert!(!args.iter().any(|a| a == "--ffmpeg-location"));
    assert!(!args.iter().any(|a| a == "--no-playlist"));
    assert!(args.iter().all(|a| a != "node:node"));
}

#[test]
fn cookies_copy_is_passed_and_hidden_in_the_shown_command() {
    let tc = Toolchain {
        ytdlp: PathBuf::from("yt-dlp"),
        ffmpeg: None,
        js_runtime: None,
    };
    let jar = PathBuf::from("/data/tmp/ytdlp-cookies/cookies-abc.txt");
    let url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    let args = build_download_args(&tc, url, "download_single", "A/B", Some(&jar)).unwrap();
    assert_eq!(
        value_after(&args, "--cookies"),
        Some("/data/tmp/ytdlp-cookies/cookies-abc.txt")
    );
    let shown = display_command(&tc.ytdlp, &args);
    assert!(shown.contains("--cookies <cookies>"), "{shown}");
    assert!(!shown.contains("cookies-abc"), "{shown}");
    let none = build_download_args(&tc, url, "download_single", "A/B", None).unwrap();
    assert!(!none.iter().any(|a| a == "--cookies"));
}

/// 5.2: a single takes its own track number, else the folder's next free
/// one (not `01 - …` every time); album downloads keep the release order.
#[test]
fn singles_are_numbered_after_the_folder_and_albums_by_release_order() {
    let tc = Toolchain::default();
    let single = |slot| {
        build_download_args_with(
            &tc,
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
            "download_single",
            "Artist/Album",
            None,
            &DownloadExtras {
                single_slot: slot,
                tags: false,
            },
        )
        .unwrap()
    };
    assert_eq!(
        value_after(&single(Some(8)), "-o"),
        Some("Artist/Album/%(track_number|08)02d - %(track,title)s.%(ext)s")
    );
    // Without a slot (old callers) the legacy fragment stays.
    assert!(!value_after(&single(None), "-o")
        .unwrap()
        .contains("track_number"));
    let album = build_download_args_with(
        &tc,
        "https://music.youtube.com/playlist?list=OLAK5uy_x",
        "download_playlist",
        "Artist/Album",
        None,
        &DownloadExtras {
            single_slot: Some(8),
            tags: false,
        },
    )
    .unwrap();
    assert_eq!(
        value_after(&album, "-o"),
        Some("Artist/Album/%(playlist_index)02d - %(track,title)s.%(ext)s")
    );
}

#[test]
fn tag_pass_asks_only_for_the_metadata_line() {
    let tc = Toolchain::default();
    let url = "https://music.youtube.com/playlist?list=OLAK5uy_x";
    let off = build_download_args(&tc, url, "download_playlist", "A/B", None).unwrap();
    assert!(!off.iter().any(|a| a.contains("[rekord-meta]")));
    let args = build_download_args_with(
        &tc,
        url,
        "download_playlist",
        "A/B",
        None,
        &DownloadExtras {
            single_slot: None,
            tags: true,
        },
    )
    .unwrap();
    assert!(args
        .iter()
        .any(|a| a.starts_with("after_move:[rekord-meta] %(.{id,")));
    // No yt-dlp embedding (it would also rewrite files already there) and
    // no thumbnail files next to the audio.
    assert!(!args.iter().any(|a| a.starts_with("--embed")));
    assert!(!args.iter().any(|a| a == "--write-thumbnail"));
    assert_eq!(args.iter().filter(|a| *a == "-o").count(), 1);
}

#[test]
fn meta_lines_attach_to_their_item_and_stay_out_of_the_summary_json() {
    let mut t = ItemTracker::new();
    for l in [
        "[rekord-item] abcdefghijk\t1\tSong",
        "[download] Destination: A/B/01 - Song.m4a",
        r#"[rekord-meta] {"id": "abcdefghijk", "title": "Song", "artists": ["X"]}"#,
    ] {
        t.feed_line(l);
    }
    let s = t.summary();
    assert_eq!(s.items.len(), 1);
    assert_eq!(s.items[0].meta.as_ref().unwrap()["artists"][0], "X");
    let json = serde_json::to_string(&s.items[0]).unwrap();
    assert!(!json.contains("artists"), "{json}");
}

/// The QA run: 12 items, all failing with the same message. The old summary
/// deduplicated identical ERROR lines and reported "1 error".
#[test]
fn every_failed_item_is_counted_and_attributed() {
    let mut stdout = String::new();
    let mut stderr = String::new();
    for i in 1..=12 {
        let id = format!("vid{i:08}");
        stdout.push_str(&format!("[download] Downloading item {i} of 12\n"));
        stdout.push_str(&format!("[rekord-item] {id}\t{i}\tSong number {i}\n"));
        stdout.push_str(&format!("[youtube] {id}: Downloading webpage\n"));
        stderr.push_str(&format!(
            "ERROR: [youtube] {id}: Requested format is not available. Use --list-formats for a list of available formats\n"
        ));
    }
    let s = summary_from_log(&stdout, &stderr);
    assert_eq!(s.failed, 12);
    assert_eq!(s.downloaded, 0);
    assert_eq!(s.total, Some(12));
    assert_eq!(s.failed_items.len(), 12);
    let third = &s.failed_items[2];
    assert_eq!(third.id.as_deref(), Some("vid00000003"));
    assert_eq!(third.index, Some(3));
    assert_eq!(third.title.as_deref(), Some("Song number 3"));
    assert_eq!(third.code, "no_audio_format");
    assert!(third.reason.starts_with("Requested format"));
}

#[test]
fn mixed_results_are_attributed_per_item() {
    let stdout = "\
[youtube:tab] PL1: Downloading webpage
[download] Downloading item 1 of 3
[rekord-item] aaaaaaaaaaa\t1\tFirst
[youtube] aaaaaaaaaaa: Downloading webpage
[info] aaaaaaaaaaa: Downloading 1 format(s): 140
[download] Destination: Artist/Album/01 - First.m4a
[download]  50.0% of 3.00MiB at 1.00MiB/s ETA 00:01
[download] 100% of 3.00MiB in 00:00:02
[download] Downloading item 2 of 3
[rekord-item] bbbbbbbbbbb\t2\tSecond
[download] Artist/Album/02 - Second.m4a has already been downloaded
[download] Downloading item 3 of 3
";
    let stderr = "\
WARNING: [youtube:tab] YouTube said: INFO - 1 unavailable video is hidden
ERROR: [youtube] ccccccccccc: Video unavailable. This video is private
";
    let s = summary_from_log(stdout, stderr);
    assert_eq!((s.downloaded, s.skipped, s.failed), (1, 1, 1));
    assert_eq!(s.downloaded_items, vec!["Artist/Album/01 - First.m4a"]);
    assert_eq!(s.skipped_items[0].label, "Second");
    assert_eq!(s.failed_items[0].id.as_deref(), Some("ccccccccccc"));
    assert_eq!(s.failed_items[0].index, Some(3));
    assert_eq!(s.formats, vec!["140"]);
}

/// Japanese / accented output beyond the 12 KB preview and the 64 KB rolling
/// cap used to panic on byte-index slicing.
#[test]
fn multibyte_logs_over_caps_do_not_panic() {
    let line = "[download] Destination: 宇多田ヒカル/初恋/07 - 誰かの願いが叶うころ – Café Ünïcödé àèìòù.m4a";
    let mut log = RollLog::new();
    let mut tracker = ItemTracker::new();
    let mut fed = 0usize;
    let mut i = 0u32;
    while fed < 3 * ROLL_CAP {
        i += 1;
        let l = format!("{line} {i}");
        tracker.feed_line(&l);
        // Odd offsets so the cut lands inside multi-byte characters.
        log.append(&l[..]);
        log.append("é\n");
        fed += l.len() + 3;
    }
    let (text, truncated, total) = log.trim_for_done();
    assert!(truncated);
    assert!(total >= 3 * ROLL_CAP);
    assert!(text.len() <= DONE_FIELD_MAX);
    assert!(text.contains("truncated"));
    for max in [
        1,
        2,
        3,
        5,
        12 * 1024,
        12 * 1024 + 1,
        64 * 1024,
        64 * 1024 + 1,
    ] {
        let _ = tail_bytes(&text, max);
    }
    assert!(tracker.summary().downloaded >= 1);
}
