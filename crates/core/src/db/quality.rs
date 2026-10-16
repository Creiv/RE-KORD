//! Library quality checks (the dashboard "Alert qualità"): one definition per
//! issue. `Db::stats` counts them in SQL over the whole library,
//! `selection::selection_stats` over one account's selection, and the client
//! (`apps/client-ui/src/lib/libraryQuality.ts`) lists them from its catalog
//! with the same rules, so the tile, the hub stats and the list agree:
//!
//! - **album without cover**: not a loose-tracks folder, `has_cover` false;
//! - **album without metadata**: not loose, no album metadata applied
//!   (`has_album_meta`) and no release date, label or country either;
//! - **track without metadata**: no genre and no release date. Junk and
//!   placeholder genre tokens ("8", "(17)", "Unknown", "Music") are not a genre
//!   ([`super::text::split_genres`], the hub's `genres` list);
//! - **loose album**: a folder of loose tracks (informational).

use super::Album;

fn blank(value: Option<&str>) -> bool {
    value.is_none_or(|s| s.trim().is_empty())
}

pub fn album_missing_cover(album: &Album) -> bool {
    !album.loose && !album.has_cover
}

pub fn album_missing_meta(album: &Album) -> bool {
    !album.loose
        && !album.has_album_meta
        && blank(album.release_date.as_deref())
        && blank(album.label.as_deref())
        && blank(album.country.as_deref())
}

/// `genres`: the track's genre labels (junk already dropped).
pub fn track_missing_meta(genres: &[String], release_date: Option<&str>) -> bool {
    genres.is_empty() && blank(release_date)
}

/// SQL twin of [`album_missing_cover`] over `albums`.
pub(super) const ALBUM_MISSING_COVER_SQL: &str = "loose = 0 AND has_cover = 0";

/// SQL twin of [`album_missing_meta`] over `albums`.
pub(super) const ALBUM_MISSING_META_SQL: &str = "loose = 0 AND has_album_meta = 0 \
     AND trim(coalesce(release_date, '')) = '' \
     AND trim(coalesce(label, '')) = '' \
     AND trim(coalesce(country, '')) = ''";

/// SQL twin of [`track_missing_meta`] over `tracks`: `genres` holds the cleaned
/// labels as JSON. A row whose labels were never computed falls back to the raw
/// `genre` (the stored form is already normalized, so it has no junk tokens).
pub(super) const TRACK_MISSING_META_SQL: &str = "(CASE WHEN genres IS NULL OR trim(genres) = '' \
       THEN trim(coalesce(genre, '')) = '' \
       ELSE genres = '[]' END) \
     AND trim(coalesce(release_date, '')) = ''";

#[cfg(test)]
mod tests {
    use super::*;

    fn album() -> Album {
        serde_json::from_value(serde_json::json!({
            "id": 1,
            "name": "One",
            "artist_name": "A",
            "track_count": 1,
            "artist_id": null,
            "folder_key": "A/One",
            "has_cover": false,
            "loose": false,
        }))
        .unwrap()
    }

    #[test]
    fn albums_need_a_cover_unless_loose() {
        let mut a = album();
        assert!(album_missing_cover(&a));
        a.has_cover = true;
        assert!(!album_missing_cover(&a));
        a.has_cover = false;
        a.loose = true;
        assert!(!album_missing_cover(&a));
    }

    #[test]
    fn album_metadata_is_the_flag_or_any_album_field() {
        let mut a = album();
        assert!(album_missing_meta(&a));
        a.release_date = Some("   ".into());
        assert!(album_missing_meta(&a), "a blank date is no date");
        a.release_date = Some("1976".into());
        assert!(!album_missing_meta(&a));
        a.release_date = None;
        a.label = Some("Swan Song".into());
        assert!(!album_missing_meta(&a));
        a.label = None;
        a.country = Some("UK".into());
        assert!(!album_missing_meta(&a));
        a.country = None;
        a.has_album_meta = true;
        assert!(!album_missing_meta(&a));
        a.has_album_meta = false;
        a.loose = true;
        assert!(
            !album_missing_meta(&a),
            "loose folders are not albums to tag"
        );
    }

    #[test]
    fn tracks_need_a_real_genre_or_a_date() {
        assert!(track_missing_meta(&[], None));
        assert!(track_missing_meta(&[], Some(" ")));
        assert!(!track_missing_meta(&[], Some("2024-05-01")));
        assert!(!track_missing_meta(&["Rock".into()], None));
        // Junk tokens never become labels, so "Unknown" alone is no genre.
        let junk = crate::db::text::split_genres("Unknown; 8; (17); Music");
        assert!(track_missing_meta(&junk, None));
    }
}
