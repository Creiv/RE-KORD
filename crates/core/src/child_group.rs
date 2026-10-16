//! Stopping yt-dlp for good.
//!
//! The yt-dlp release binaries are PyInstaller one-file executables: the
//! process the hub spawns is a bootloader that runs the real yt-dlp as its
//! child. Tokio's `kill_on_drop` sends SIGKILL to the bootloader only, so an
//! abandoned run (probe timeout, a client that went away, hub shutdown) went on
//! as an orphan: still downloading, and rewriting its `--cookies` copy after
//! the hub had removed it, which left live session cookies on disk.
//!
//! [`isolate`] starts the child as the leader of its own process group and
//! [`GroupKill`] kills that whole group when dropped. [`signal_group`] sends a
//! signal to the group (Cancel). Unix only: on Windows nothing changes.

use tokio::process::{Child, Command};

/// Start the command in a new process group (its pid becomes the group id).
pub fn isolate(cmd: &mut Command) {
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(not(unix))]
    let _ = cmd;
}

/// Kills the child's process group on drop, unless [`GroupKill::disarm`]ed
/// once the child has exited and been waited for (its group id may then be
/// reused). Declare it after anything that must outlive the process, such as
/// the cookie copy: locals drop in reverse order.
#[derive(Debug)]
pub struct GroupKill {
    #[cfg_attr(not(unix), allow(dead_code))]
    pgid: Option<u32>,
}

impl GroupKill {
    /// For a child spawned after [`isolate`].
    pub fn new(child: &Child) -> Self {
        Self { pgid: child.id() }
    }

    /// The process was waited for: nothing left to kill.
    pub fn disarm(&mut self) {
        self.pgid = None;
    }
}

impl Drop for GroupKill {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pgid) = self.pgid {
            signal_group(pgid, libc::SIGKILL);
        }
    }
}

/// Send `signal` to the process group led by `pgid` (a child spawned after
/// [`isolate`]).
#[cfg(unix)]
pub fn signal_group(pgid: u32, signal: libc::c_int) {
    if let Ok(pgid) = libc::pid_t::try_from(pgid) {
        if pgid > 1 {
            // SAFETY: plain syscall on a process group we created; no memory involved.
            unsafe {
                libc::killpg(pgid, signal);
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    use tokio::io::AsyncBufReadExt;

    fn running(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the pid exists.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return false;
        }
        // A zombie waiting for init to reap it is not running either.
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|s| {
                s.rsplit(')')
                    .next()
                    .and_then(|rest| rest.split_whitespace().next())
                    != Some("Z")
            })
            .unwrap_or(false)
    }

    #[tokio::test]
    async fn dropping_the_guard_kills_grandchildren() {
        // `sh` stands in for the PyInstaller bootloader, `sleep` for yt-dlp.
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30 & echo $!; wait"])
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        isolate(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");
        let guard = GroupKill::new(&child);
        let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
        let grandchild: i32 = lines
            .next_line()
            .await
            .unwrap()
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(running(grandchild));

        drop(guard);
        drop(child);

        let deadline = Instant::now() + Duration::from_secs(5);
        while running(grandchild) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(!running(grandchild), "the grandchild outlived the guard");
    }

    #[tokio::test]
    async fn a_disarmed_guard_leaves_the_group_alone() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "exit 0"]);
        isolate(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");
        let mut guard = GroupKill::new(&child);
        assert!(child.wait().await.unwrap().success());
        guard.disarm();
        assert!(guard.pgid.is_none());
    }
}
