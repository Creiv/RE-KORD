//! Queries use pooled read-only connections: they see every committed write
//! and keep working while other threads write.

use rekord_core::db::Db;
use std::sync::Arc;

fn temp_db(tag: &str) -> (std::path::PathBuf, Db) {
    let dir = std::env::temp_dir().join(format!("rekord-readpool-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("rekord.db");
    let db = Db::open(&path).unwrap();
    (dir, db)
}

#[test]
fn reads_see_committed_writes_at_once() {
    let (dir, db) = temp_db("visible");
    assert_eq!(db.get_meta("k").unwrap(), None);
    db.set_meta("k", "one").unwrap();
    assert_eq!(db.get_meta("k").unwrap().as_deref(), Some("one"));
    db.set_meta("k", "two").unwrap();
    assert_eq!(db.get_meta("k").unwrap().as_deref(), Some("two"));
    // More readers than the pool holds, all at once.
    let db = Arc::new(db);
    let readers: Vec<_> = (0..8)
        .map(|_| {
            let db = Arc::clone(&db);
            std::thread::spawn(move || {
                for _ in 0..50 {
                    let v = db.get_meta("k").unwrap();
                    assert!(matches!(v.as_deref(), Some("two") | Some("three")), "{v:?}");
                }
            })
        })
        .collect();
    db.set_meta("k", "three").unwrap();
    for r in readers {
        r.join().unwrap();
    }
    assert_eq!(db.get_meta("k").unwrap().as_deref(), Some("three"));
    assert_eq!(db.count_tracks().unwrap(), 0);
    drop(db);
    let _ = std::fs::remove_dir_all(dir);
}
