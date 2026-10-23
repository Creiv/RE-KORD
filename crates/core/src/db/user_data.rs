//! Per-account user data: favorites and playlists.
//!
//! Links whose track is not in the catalog right now (a backup restored before
//! the scan, a drive that is not mounted) are parked by rel_path; see
//! `catalog.rs`. Exports include parked links so backups never lose them.

use super::catalog::{park_favorite, park_playlist_track, track_id_by_rel};
use super::{Db, LibraryTrack, Playlist, PlaylistBackup, PlaylistBackupTrack, Track};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use uuid::Uuid;

/// Case/space-insensitive playlist name key used when merging imports.
fn playlist_name_key(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn insert_playlist(conn: &Connection, account_id: &str, name: &str) -> Result<Playlist> {
    insert_playlist_at(
        conn,
        account_id,
        name,
        None,
        &chrono::Utc::now().to_rfc3339(),
    )
}

/// Insert a playlist; `legacy_id` is the identity it had in the source of an
/// import. Lists are ordered by `created_at` (newest first).
fn insert_playlist_at(
    conn: &Connection,
    account_id: &str,
    name: &str,
    legacy_id: Option<&str>,
    created_at: &str,
) -> Result<Playlist> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO playlists(id, account_id, name, created_at, legacy_id) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, account_id, name, created_at, legacy_id],
    )?;
    Ok(Playlist {
        id,
        name: name.to_string(),
        created_at: created_at.to_string(),
        track_count: 0,
    })
}

/// `created_at` stamps that keep an imported list in its original order
/// under the newest-first listing: the first playlist gets `now`.
fn import_stamps(n: usize) -> Vec<String> {
    let now = chrono::Utc::now();
    (0..n)
        .map(|i| {
            (now - chrono::Duration::milliseconds(i as i64))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .collect()
}

/// Linked + parked rel_paths of one playlist, in playlist order.
fn playlist_rel_paths(conn: &Connection, playlist_id: &str) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT rel_path, position FROM (
          SELECT t.rel_path AS rel_path, pt.position AS position
          FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
          WHERE pt.playlist_id = ?1
          UNION ALL
          SELECT rel_path, position FROM parked_playlist_tracks WHERE playlist_id = ?1
        )
        ORDER BY position, rel_path
        "#,
    )?;
    let rows = stmt.query_map(params![playlist_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    Ok(rows.flatten().collect())
}

/// Append `rel_path` to a playlist (linked if indexed, parked otherwise).
/// Returns true when it was linked to an indexed track.
fn append_playlist_rel(
    conn: &Connection,
    playlist_id: &str,
    rel_path: &str,
    position: i64,
) -> Result<bool> {
    match track_id_by_rel(conn, rel_path)? {
        Some(id) => {
            let n = conn.execute(
                "INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position) VALUES (?1,?2,?3)",
                params![playlist_id, id, position],
            )?;
            Ok(n > 0)
        }
        None => {
            park_playlist_track(conn, playlist_id, rel_path, position)?;
            Ok(false)
        }
    }
}

impl Db {
    pub fn list_favorites(&self, account_id: &str) -> Result<Vec<LibraryTrack>> {
        self.query_library_tracks(
            "JOIN favorites f ON f.track_id = t.id WHERE f.account_id = ?1 ORDER BY f.created_at DESC",
            params![account_id],
        )
    }

    pub fn add_favorite(&self, account_id: &str, track_id: i64) -> Result<()> {
        let conn = self.lock();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT OR IGNORE INTO favorites(account_id, track_id, created_at) VALUES (?1, ?2, ?3)",
            params![account_id, track_id, now],
        )?;
        Ok(())
    }

    pub fn remove_favorite(&self, account_id: &str, track_id: i64) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM favorites WHERE account_id = ?1 AND track_id = ?2",
            params![account_id, track_id],
        )?;
        Ok(())
    }

    /// Favorites as rel_paths, newest first, including parked ones.
    pub fn export_favorite_rel_paths(&self, account_id: &str) -> Result<Vec<String>> {
        let conn = self.read();
        let mut stmt = conn.prepare(
            r#"
            SELECT rel_path FROM (
              SELECT t.rel_path AS rel_path, f.created_at AS created_at
              FROM favorites f JOIN tracks t ON t.id = f.track_id
              WHERE f.account_id = ?1
              UNION ALL
              SELECT rel_path, created_at FROM parked_favorites WHERE account_id = ?1
            )
            ORDER BY created_at DESC
            "#,
        )?;
        let rows = stmt.query_map(params![account_id], |r| r.get::<_, String>(0))?;
        let mut seen = HashSet::new();
        Ok(rows
            .filter_map(|r| r.ok())
            .filter(|p| seen.insert(p.clone()))
            .collect())
    }

    /// Distinct account ids that own favorites or playlists.
    pub fn list_user_data_account_ids(&self) -> Result<Vec<String>> {
        let conn = self.read();
        let mut ids = std::collections::BTreeSet::new();
        for sql in [
            "SELECT DISTINCT account_id FROM favorites",
            "SELECT DISTINCT account_id FROM parked_favorites",
            "SELECT DISTINCT account_id FROM playlists",
        ] {
            let mut stmt = conn.prepare(sql)?;
            for row in stmt.query_map([], |r| r.get::<_, String>(0))?.flatten() {
                ids.insert(row);
            }
        }
        Ok(ids.into_iter().collect())
    }

    /// Replace favorites for one account from stable rel_path keys. Paths not
    /// in the catalog yet are parked; returns how many were linked now.
    pub fn replace_favorites_by_rel_paths(
        &self,
        account_id: &str,
        paths: &[String],
    ) -> Result<u32> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM favorites WHERE account_id = ?1",
            params![account_id],
        )?;
        tx.execute(
            "DELETE FROM parked_favorites WHERE account_id = ?1",
            params![account_id],
        )?;
        let linked = insert_favorites(&tx, account_id, paths)?;
        tx.commit()?;
        Ok(linked)
    }

    /// Add favorites by rel_path, keeping the ones already there (union).
    /// Returns how many new favorites were linked to indexed tracks.
    pub fn merge_favorites_by_rel_paths(&self, account_id: &str, paths: &[String]) -> Result<u32> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let linked = insert_favorites(&tx, account_id, paths)?;
        tx.commit()?;
        Ok(linked)
    }

    /// Playlists with their tracks as rel_paths (parked entries included, with
    /// empty display fields).
    pub fn export_playlists_backup(&self, account_id: &str) -> Result<Vec<PlaylistBackup>> {
        let playlists = self.list_playlists(account_id)?;
        let mut out = Vec::with_capacity(playlists.len());
        for pl in playlists {
            let linked: std::collections::HashMap<String, Track> = self
                .playlist_tracks(account_id, &pl.id)?
                .into_iter()
                .map(|t| (t.rel_path.clone(), t))
                .collect();
            let order = playlist_rel_paths(&self.lock(), &pl.id)?;
            let legacy_id: Option<String> = self
                .lock()
                .query_row(
                    "SELECT legacy_id FROM playlists WHERE id = ?1",
                    params![pl.id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            out.push(PlaylistBackup {
                id: Some(legacy_id.unwrap_or_else(|| pl.id.clone())),
                name: pl.name,
                tracks: order
                    .into_iter()
                    .map(|(rel, _)| match linked.get(&rel) {
                        Some(t) => PlaylistBackupTrack {
                            rel_path: t.rel_path.clone(),
                            title: t.title.clone(),
                            artist_name: t.artist_name.clone(),
                            album_name: t.album_name.clone(),
                        },
                        None => PlaylistBackupTrack {
                            rel_path: rel,
                            title: String::new(),
                            artist_name: String::new(),
                            album_name: String::new(),
                        },
                    })
                    .collect(),
            });
        }
        Ok(out)
    }

    /// Wipe one account's playlists and recreate from backup, in one
    /// transaction. Returns (playlists, tracks linked now); entries whose file
    /// is not indexed yet are parked and re-attach on scan.
    pub fn replace_playlists_backup(
        &self,
        account_id: &str,
        playlists: &[PlaylistBackup],
    ) -> Result<(u32, u32)> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE account_id = ?1)",
            params![account_id],
        )?;
        tx.execute(
            "DELETE FROM parked_playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE account_id = ?1)",
            params![account_id],
        )?;
        tx.execute(
            "DELETE FROM playlists WHERE account_id = ?1",
            params![account_id],
        )?;
        let mut pl_n = 0u32;
        let mut tr_n = 0u32;
        let stamps = import_stamps(playlists.len());
        for (pl, stamp) in playlists.iter().zip(&stamps) {
            let legacy_id = pl.id.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let created = insert_playlist_at(&tx, account_id, &pl.name, legacy_id, stamp)?;
            pl_n += 1;
            for (i, row) in pl.tracks.iter().enumerate() {
                if append_playlist_rel(&tx, &created.id, &row.rel_path, i as i64)? {
                    tr_n += 1;
                }
            }
        }
        tx.commit()?;
        Ok((pl_n, tr_n))
    }

    /// Merge playlists into one account. A playlist with an `id` matches the
    /// playlist imported from it earlier (so same-name playlists stay apart);
    /// without one, or the first time, a playlist with the same name (ignoring
    /// case and spacing) that has no identity yet is adopted. Matches get the
    /// missing tracks appended, the rest is created in the given order.
    /// Nothing is removed. Returns (playlists created, tracks added).
    pub fn merge_playlists_backup(
        &self,
        account_id: &str,
        playlists: &[PlaylistBackup],
    ) -> Result<(u32, u32)> {
        let (created, added, _) = self.merge_playlists_backup_opts(account_id, playlists, false)?;
        Ok((created, added))
    }

    /// [`Db::merge_playlists_backup`] that also counts the parked entries
    /// (file not indexed): returns (playlists created, tracks added, of which
    /// parked). `dry_run` computes everything and rolls back.
    pub fn merge_playlists_backup_opts(
        &self,
        account_id: &str,
        playlists: &[PlaylistBackup],
        dry_run: bool,
    ) -> Result<(u32, u32, u32)> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        // (id, name key, legacy id)
        let mut existing: Vec<(String, String, Option<String>)> = {
            let mut stmt = tx.prepare(
                "SELECT id, name, legacy_id FROM playlists WHERE account_id = ?1 ORDER BY created_at",
            )?;
            let rows = stmt.query_map(params![account_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    playlist_name_key(&r.get::<_, String>(1)?),
                    r.get::<_, Option<String>>(2)?,
                ))
            })?;
            rows.flatten().collect()
        };
        let stamps = import_stamps(playlists.len());
        let mut created_n = 0u32;
        let mut added_n = 0u32;
        let mut parked_n = 0u32;
        let mut used: HashSet<String> = HashSet::new();
        for (pl, stamp) in playlists.iter().zip(&stamps) {
            let key = playlist_name_key(&pl.name);
            if key.is_empty() {
                continue;
            }
            let ident = pl.id.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let by_ident = ident.and_then(|want| {
                existing
                    .iter()
                    .find(|(id, _, legacy)| legacy.as_deref() == Some(want) || id == want)
                    .map(|(id, _, _)| id.clone())
            });
            let by_name = || {
                existing
                    .iter()
                    .find(|(id, k, legacy)| {
                        *k == key && (ident.is_none() || legacy.is_none()) && !used.contains(id)
                    })
                    .map(|(id, _, _)| id.clone())
            };
            let playlist_id = match by_ident.or_else(by_name) {
                Some(id) => {
                    if let Some(want) = ident {
                        tx.execute(
                            "UPDATE playlists SET legacy_id = ?2 WHERE id = ?1 AND legacy_id IS NULL",
                            params![id, want],
                        )?;
                        if let Some(row) = existing.iter_mut().find(|(eid, _, _)| *eid == id) {
                            row.2.get_or_insert_with(|| want.to_string());
                        }
                    }
                    id
                }
                None => {
                    let created =
                        insert_playlist_at(&tx, account_id, pl.name.trim(), ident, stamp)?;
                    created_n += 1;
                    existing.push((created.id.clone(), key, ident.map(str::to_string)));
                    created.id
                }
            };
            used.insert(playlist_id.clone());
            let current = playlist_rel_paths(&tx, &playlist_id)?;
            let mut present: HashSet<String> = current.iter().map(|(r, _)| r.clone()).collect();
            let mut next_pos = current.iter().map(|(_, p)| *p + 1).max().unwrap_or(0);
            for row in &pl.tracks {
                let rel = row.rel_path.trim();
                if rel.is_empty() || !present.insert(rel.to_string()) {
                    continue;
                }
                if !append_playlist_rel(&tx, &playlist_id, rel, next_pos)? {
                    parked_n += 1;
                }
                next_pos += 1;
                added_n += 1;
            }
        }
        if !dry_run {
            tx.commit()?;
        }
        Ok((created_n, added_n, parked_n))
    }

    pub fn delete_account_user_data(&self, account_id: &str) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE account_id = ?1)",
            params![account_id],
        )?;
        tx.execute(
            "DELETE FROM parked_playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE account_id = ?1)",
            params![account_id],
        )?;
        tx.execute(
            "DELETE FROM playlists WHERE account_id = ?1",
            params![account_id],
        )?;
        tx.execute(
            "DELETE FROM favorites WHERE account_id = ?1",
            params![account_id],
        )?;
        tx.execute(
            "DELETE FROM parked_favorites WHERE account_id = ?1",
            params![account_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn list_playlists(&self, account_id: &str) -> Result<Vec<Playlist>> {
        let conn = self.read();
        let mut stmt = conn.prepare(
            r#"
            SELECT p.id, p.name, p.created_at,
                   (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id)
            FROM playlists p
            WHERE p.account_id = ?1
            ORDER BY p.created_at DESC
            "#,
        )?;
        let rows = stmt.query_map(params![account_id], |r| {
            Ok(Playlist {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                track_count: r.get(3)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn create_playlist(&self, account_id: &str, name: &str) -> Result<Playlist> {
        insert_playlist(&self.lock(), account_id, name)
    }

    fn playlist_belongs(&self, account_id: &str, playlist_id: &str) -> Result<bool> {
        let conn = self.lock();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM playlists WHERE id = ?1 AND account_id = ?2",
            params![playlist_id, account_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn delete_playlist(&self, account_id: &str, id: &str) -> Result<bool> {
        let conn = self.lock();
        let n = conn.execute(
            "DELETE FROM playlists WHERE id = ?1 AND account_id = ?2",
            params![id, account_id],
        )?;
        Ok(n > 0)
    }

    pub fn rename_playlist(&self, account_id: &str, id: &str, name: &str) -> Result<bool> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE playlists SET name = ?1 WHERE id = ?2 AND account_id = ?3",
            params![name, id, account_id],
        )?;
        Ok(n > 0)
    }

    /// Playlist tracks with the library extras, in playlist order.
    pub fn playlist_library_tracks(&self, account_id: &str, id: &str) -> Result<Vec<LibraryTrack>> {
        if !self.playlist_belongs(account_id, id)? {
            return Ok(Vec::new());
        }
        self.query_library_tracks(
            "JOIN playlist_tracks pt ON pt.track_id = t.id WHERE pt.playlist_id = ?1 ORDER BY pt.position",
            params![id],
        )
    }

    pub fn playlist_tracks(&self, account_id: &str, id: &str) -> Result<Vec<Track>> {
        if !self.playlist_belongs(account_id, id)? {
            return Ok(Vec::new());
        }
        let conn = self.read();
        let sql = format!(
            "SELECT {} FROM playlist_tracks pt
             JOIN tracks t ON t.id = pt.track_id
             WHERE pt.playlist_id = ?1
             ORDER BY pt.position",
            Self::TRACK_COLS_T
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![id], Self::map_track)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn add_to_playlist(
        &self,
        account_id: &str,
        playlist_id: &str,
        track_id: i64,
    ) -> Result<()> {
        if !self.playlist_belongs(account_id, playlist_id)? {
            anyhow::bail!("playlist not found");
        }
        let conn = self.lock();
        // Parked entries keep their slot, so new tracks go after them too.
        let pos: i64 = conn
            .query_row(
                r#"
                SELECT COALESCE(MAX(position), -1) + 1 FROM (
                  SELECT position FROM playlist_tracks WHERE playlist_id = ?1
                  UNION ALL
                  SELECT position FROM parked_playlist_tracks WHERE playlist_id = ?1
                )
                "#,
                params![playlist_id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        conn.execute(
            "INSERT OR IGNORE INTO playlist_tracks(playlist_id, track_id, position) VALUES (?1,?2,?3)",
            params![playlist_id, track_id, pos],
        )?;
        Ok(())
    }

    /// Rewrites the order of a playlist. `track_ids` must be exactly the tracks
    /// already in the playlist, so a stale client cannot drop or add entries.
    pub fn reorder_playlist(
        &self,
        account_id: &str,
        playlist_id: &str,
        track_ids: &[i64],
    ) -> Result<()> {
        if !self.playlist_belongs(account_id, playlist_id)? {
            anyhow::bail!("playlist not found");
        }
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let current: Vec<i64> = {
            let mut stmt =
                tx.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1")?;
            let rows = stmt.query_map(params![playlist_id], |r| r.get::<_, i64>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let wanted: HashSet<i64> = track_ids.iter().copied().collect();
        if wanted.len() != track_ids.len() {
            anyhow::bail!("duplicate track in order");
        }
        let existing: HashSet<i64> = current.iter().copied().collect();
        if wanted != existing {
            anyhow::bail!("order does not match the playlist tracks");
        }
        for (pos, track_id) in track_ids.iter().enumerate() {
            tx.execute(
                "UPDATE playlist_tracks SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
                params![pos as i64, playlist_id, track_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn remove_from_playlist(
        &self,
        account_id: &str,
        playlist_id: &str,
        track_id: i64,
    ) -> Result<()> {
        if !self.playlist_belongs(account_id, playlist_id)? {
            anyhow::bail!("playlist not found");
        }
        let conn = self.lock();
        conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
            params![playlist_id, track_id],
        )?;
        Ok(())
    }
}

/// Link (or park) favorites by rel_path; returns how many were newly linked.
fn insert_favorites(conn: &Connection, account_id: &str, paths: &[String]) -> Result<u32> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut linked = 0u32;
    for rel in paths {
        let rel = rel.trim();
        if rel.is_empty() {
            continue;
        }
        match track_id_by_rel(conn, rel)? {
            Some(id) => {
                linked += conn.execute(
                    "INSERT OR IGNORE INTO favorites(account_id, track_id, created_at) VALUES (?1, ?2, ?3)",
                    params![account_id, id, now],
                )? as u32;
            }
            None => park_favorite(conn, account_id, rel, &now)?,
        }
    }
    Ok(linked)
}
