//! Filesystem capacity for the music library volume.

use std::path::Path;

#[derive(Debug, Clone, Copy)]
pub struct DiskSpace {
    pub total_bytes: u64,
    pub available_bytes: u64,
}

/// Total / available bytes for the filesystem that contains `path`.
pub fn volume_space(path: &Path) -> Option<DiskSpace> {
    let probe = if path.exists() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    volume_space_impl(probe)
}

#[cfg(unix)]
fn volume_space_impl(path: &Path) -> Option<DiskSpace> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let cpath = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: path is a valid C string; statvfs fills the struct or fails.
    unsafe {
        let mut s: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(cpath.as_ptr(), &mut s) != 0 {
            return None;
        }
        let frsize = s.f_frsize as u64;
        if frsize == 0 {
            return None;
        }
        let total = (s.f_blocks as u64).saturating_mul(frsize);
        let available = (s.f_bavail as u64).saturating_mul(frsize);
        Some(DiskSpace {
            total_bytes: total,
            available_bytes: available,
        })
    }
}

#[cfg(not(unix))]
fn volume_space_impl(_path: &Path) -> Option<DiskSpace> {
    None
}
