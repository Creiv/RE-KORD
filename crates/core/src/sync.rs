//! Poison-tolerant locking.
//!
//! The hub shares its state behind `std::sync` locks. If a task panics while
//! holding one (a bug, a corrupt file, an assertion in a dependency), the
//! lock is poisoned and `lock().unwrap()` turns every later request that
//! touches it into a panic: the hub keeps running but answers 500 until it is
//! restarted. Recovering the guard instead keeps the hub usable; the data
//! under these locks is either plain settings or re-derived state, never a
//! half-applied multi-step update that must not be observed.

use std::sync::{Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub trait LockRecover<T> {
    /// `lock()`, taking the guard back from a poisoned lock.
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockRecover<T> for Mutex<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

pub trait RwLockRecover<T> {
    fn read_or_recover(&self) -> RwLockReadGuard<'_, T>;
    fn write_or_recover(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T> RwLockRecover<T> for RwLock<T> {
    fn read_or_recover(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write_or_recover(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_panic_under_the_lock_does_not_take_the_hub_down() {
        let shared = Arc::new(Mutex::new(1u32));
        let poisoner = Arc::clone(&shared);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock_or_recover();
            panic!("boom while holding the lock");
        })
        .join();
        assert!(shared.is_poisoned());
        // `lock().unwrap()` would panic here; the recovering lock goes on.
        *shared.lock_or_recover() += 1;
        assert_eq!(*shared.lock_or_recover(), 2);

        let rw = Arc::new(RwLock::new(String::from("a")));
        let poisoner = Arc::clone(&rw);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.write_or_recover();
            panic!("boom");
        })
        .join();
        assert!(rw.is_poisoned());
        rw.write_or_recover().push('b');
        assert_eq!(rw.read_or_recover().as_str(), "ab");
    }
}
