//! Bookkeeping of the embedded-tags backfill (see `crate::embedded::backfill`):
//! which tracks still need a read of their tags, which albums still need a
//! look for an embedded picture.

use super::catalog::CatalogBatch;
use super::Db;
use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use std::path::{Path, PathBuf};

/// A track whose tags the backfill reads, with what the catalog already
/// knows about it (the backfill does not move it, nor re-time it).
#[derive(Debug, Clone)]
pub struct PendingTrack {
    pub id: i64,
    pub rel_path: String,
    pub file_path: PathBuf,
    pub artist_name: String,
    pub album_name: String,
    pub album_id: Option<i64>,
    pub artist_id: Option<i64>,
    pub duration_ms: i64,
    pub size: u64,
    pub mtime: i64,
}

/// An album to look at for an embedded picture.
#[derive(Debug, Clone)]
pub struct PendingCoverAlbum {
    pub id: i64,
    pub folder_key: String,
    /// Up to a few of its files, in track order.
    pub files: Vec<(String, PathBuf)>,
}

/// SQL condition (over `albums`) of the albums the cover pass looks at.
const COVER_PENDING: &str = "loose = 0 AND embedded_cover_from IS NULL \
     AND (has_cover = 0 OR cover_source = 'embedded')";

impl Db {
    /// `(tracks, albums)` the backfill still has to look at.
    pub fn embedded_pending(&self, tags_version: i64) -> Result<(u64, u64)> {
        let conn = self.read();
        let tracks: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tracks WHERE tags_version < ?1",
            params![tags_version],
            |r| r.get(0),
        )?;
        let albums: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM albums WHERE {COVER_PENDING}"),
            [],
            |r| r.get(0),
        )?;
        Ok((tracks as u64, albums as u64))
    }

    /// The next `limit` tracks not read by tag reader `tags_version`, album
    /// by album.
    pub fn embedded_pending_tracks(
        &self,
        tags_version: i64,
        limit: usize,
    ) -> Result<Vec<PendingTrack>> {
        let conn = self.read();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, rel_path, file_path, artist_name, album_name, album_id, artist_id,
                   duration_ms, size, mtime
            FROM tracks WHERE tags_version < ?1
            ORDER BY album_id, id
            LIMIT ?2
            "#,
        )?;
        let rows = stmt.query_map(params![tags_version, limit as i64], |r| {
            Ok(PendingTrack {
                id: r.get(0)?,
                rel_path: r.get(1)?,
                file_path: PathBuf::from(r.get::<_, String>(2)?),
                artist_name: r.get(3)?,
                album_name: r.get(4)?,
                album_id: r.get(5)?,
                artist_id: r.get(6)?,
                duration_ms: r.get(7)?,
                size: r.get::<_, i64>(8)?.max(0) as u64,
                mtime: r.get(9)?,
            })
        })?;
        Ok(rows.flatten().collect())
    }

    /// The next `limit` albums to look at for an embedded picture, each with
    /// its first `files` tracks.
    pub fn embedded_pending_cover_albums(
        &self,
        limit: usize,
        files: usize,
    ) -> Result<Vec<PendingCoverAlbum>> {
        let conn = self.read();
        let mut stmt = conn.prepare(&format!(
            "SELECT id, folder_key FROM albums WHERE {COVER_PENDING} ORDER BY id LIMIT ?1"
        ))?;
        let albums: Vec<(i64, String)> = stmt
            .query_map(params![limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?
            .flatten()
            .collect();
        let mut tracks = conn.prepare(
            r#"
            SELECT rel_path, file_path FROM tracks WHERE album_id = ?1
            ORDER BY COALESCE(disc_number, 1), COALESCE(track_number, 9999), rel_path
            LIMIT ?2
            "#,
        )?;
        let mut out = Vec::with_capacity(albums.len());
        for (id, folder_key) in albums {
            let files = tracks
                .query_map(params![id, files as i64], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        PathBuf::from(r.get::<_, String>(1)?),
                    ))
                })?
                .flatten()
                .collect();
            out.push(PendingCoverAlbum {
                id,
                folder_key,
                files,
            });
        }
        Ok(out)
    }

    /// Outcome of the cover pass for one album: the stored picture and the
    /// track it came from, or none (an embedded cover it had is dropped).
    pub fn set_album_embedded_cover(
        &self,
        album_id: i64,
        cover: Option<(&Path, &str)>,
    ) -> Result<()> {
        let conn = self.lock();
        match cover {
            Some((path, from)) => {
                let version = super::catalog::cover_version_of(path);
                conn.execute(
                    r#"
                    UPDATE albums SET cover_path = ?2, has_cover = 1, cover_version = ?3,
                      cover_source = 'embedded', embedded_cover_from = ?4
                    WHERE id = ?1 AND (has_cover = 0 OR cover_source = 'embedded')
                    "#,
                    params![album_id, path.to_string_lossy(), version, from],
                )?;
            }
            None => {
                conn.execute(
                    r#"
                    UPDATE albums SET embedded_cover_from = '',
                      cover_path = CASE WHEN cover_source = 'embedded' THEN NULL ELSE cover_path END,
                      has_cover = CASE WHEN cover_source = 'embedded' THEN 0 ELSE has_cover END,
                      cover_version = CASE WHEN cover_source = 'embedded' THEN NULL ELSE cover_version END,
                      cover_source = CASE WHEN cover_source = 'embedded' THEN NULL ELSE cover_source END
                    WHERE id = ?1
                    "#,
                    params![album_id],
                )?;
            }
        }
        Ok(())
    }

    /// "Re-read embedded tags" / a settings change: every track is read
    /// again and every album without a folder image is looked at again.
    pub fn reset_embedded_markers(&self) -> Result<()> {
        let conn = self.lock();
        conn.execute_batch(
            r#"
            UPDATE tracks SET tags_version = 0 WHERE tags_version != 0;
            UPDATE albums SET embedded_cover_from = NULL
              WHERE embedded_cover_from IS NOT NULL
                AND (cover_source IS NULL OR cover_source = 'embedded');
            "#,
        )?;
        Ok(())
    }

    /// `(folder_key, loose)` of an album.
    pub fn album_folder(&self, album_id: i64) -> Result<Option<(String, bool)>> {
        let conn = self.read();
        Ok(conn
            .query_row(
                "SELECT folder_key, loose FROM albums WHERE id = ?1",
                params![album_id],
                |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)),
            )
            .optional()?)
    }
}

impl CatalogBatch<'_> {
    /// Whether the row of `t` is still what the backfill read: same file
    /// state, same place, still pending.
    pub fn pending_track_unchanged(&self, t: &PendingTrack, version: i64) -> Result<bool> {
        Ok(self
            .conn()
            .query_row(
                "SELECT 1 FROM tracks
                  WHERE id = ?1 AND rel_path = ?2 AND size = ?3 AND mtime = ?4
                    AND album_id IS ?5 AND tags_version < ?6",
                params![
                    t.id,
                    t.rel_path,
                    t.size as i64,
                    t.mtime,
                    t.album_id,
                    version
                ],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// Record that a file was looked at by tag reader `version` even though
    /// it could not be read (missing, unreadable): the next scan handles it.
    pub fn mark_tags_version(&self, track_id: i64, version: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE tracks SET tags_version = ?2 WHERE id = ?1",
            params![track_id, version],
        )?;
        Ok(())
    }

    /// Canonical genre labels of an album and its tracks after their genres
    /// changed outside a scan.
    pub fn refresh_album_genres(&self, album_id: i64) -> Result<()> {
        super::genres::refresh_genres_where(self.conn(), "tracks", "album_id = ?1", &album_id)?;
        super::genres::refresh_genres_where(self.conn(), "albums", "id = ?1", &album_id)?;
        Ok(())
    }
}
