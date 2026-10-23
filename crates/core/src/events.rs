//! Hub events for the clients (`GET /api/v1/events`, server-sent events).
//!
//! The clients used to poll: the admin panel every 1.5 s while a job ran, the
//! Network panel every 15 s, the user state once a minute. Now the hub tells
//! them when something changed and they fetch what they show. The stream is
//! a hint, never the data: every event is a small JSON object naming what
//! moved, and the client re-reads the matching endpoint. A client that cannot
//! hold the stream falls back to its polling.
//!
//! Kinds: `jobs` (a job started, progressed, finished, was cancelled or
//! cleared), `library` (a scan or folder rescan bumped the index epoch),
//! `userState` (an account's state was saved: `{ accountId, revision }`),
//! `remoteAccess` (tunnel status changed), `downloads` (a Studio download
//! started or ended).
//!
//! One process-wide broadcast channel: publishers sit in modules without a
//! handle on the state (job handles, the tunnel manager, the scanner), and a
//! hub process serves one hub. `jobs` events are throttled per subscriber
//! (progress lines can come several times a second), keeping the last one.

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::{Stream, StreamExt};
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use crate::state::AppState;

#[derive(Clone, Debug)]
pub struct HubEvent {
    pub kind: &'static str,
    pub data: Value,
}

/// Events kept for a slow subscriber before it is told it lagged (and the
/// client simply refreshes everything).
const CAPACITY: usize = 256;
/// Shortest gap between two `jobs` events to one subscriber.
const JOBS_MIN_GAP: Duration = Duration::from_millis(400);

fn bus() -> &'static broadcast::Sender<HubEvent> {
    static BUS: OnceLock<broadcast::Sender<HubEvent>> = OnceLock::new();
    BUS.get_or_init(|| broadcast::channel(CAPACITY).0)
}

/// Tell every subscriber; nothing happens without subscribers.
pub fn publish(kind: &'static str, data: Value) {
    let _ = bus().send(HubEvent { kind, data });
}

pub fn subscribe() -> broadcast::Receiver<HubEvent> {
    bus().subscribe()
}

/// `GET /api/v1/events`: `event: <kind>` / `data: <json>` lines, a keep-alive
/// comment every 25 s, `event: hello` first so the client knows it is live.
pub async fn sse(
    State(_state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let rx = subscribe();
    let hello = futures::stream::once(async {
        Ok(Event::default().event("hello").data(
            json!({ "kinds": ["jobs", "library", "userState", "remoteAccess", "downloads"] })
                .to_string(),
        ))
    });
    let events = futures::stream::unfold(Throttled::new(rx), |mut st| async move {
        let ev = st.next().await?;
        Some((
            Ok(Event::default().event(ev.kind).data(ev.data.to_string())),
            st,
        ))
    });
    Sse::new(hello.chain(events)).keep_alive(KeepAlive::new().interval(Duration::from_secs(25)))
}

/// A subscriber's receiver with `jobs` events coalesced: after one is sent,
/// others within [`JOBS_MIN_GAP`] wait and only the last of them goes out.
struct Throttled {
    rx: broadcast::Receiver<HubEvent>,
    last_jobs: Option<Instant>,
    pending_jobs: Option<HubEvent>,
}

impl Throttled {
    fn new(rx: broadcast::Receiver<HubEvent>) -> Self {
        Self {
            rx,
            last_jobs: None,
            pending_jobs: None,
        }
    }

    async fn next(&mut self) -> Option<HubEvent> {
        loop {
            let wait = self
                .pending_jobs
                .as_ref()
                .and(self.last_jobs)
                .map(|t| JOBS_MIN_GAP.saturating_sub(t.elapsed()));
            let ev = match wait {
                Some(left) if left.is_zero() => return self.take_pending(),
                Some(left) => match tokio::time::timeout(left, self.rx.recv()).await {
                    Err(_) => return self.take_pending(),
                    Ok(r) => r,
                },
                None => self.rx.recv().await,
            };
            match ev {
                Ok(ev) if ev.kind == "jobs" => {
                    let due = self
                        .last_jobs
                        .map(|t| t.elapsed() >= JOBS_MIN_GAP)
                        .unwrap_or(true);
                    if due && self.pending_jobs.is_none() {
                        self.last_jobs = Some(Instant::now());
                        return Some(ev);
                    }
                    self.pending_jobs = Some(ev);
                }
                Ok(ev) => return Some(ev),
                // Lagged: the client missed some; a bare jobs + library hint
                // makes it refresh what it shows.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    return Some(HubEvent {
                        kind: "library",
                        data: json!({ "lagged": true }),
                    })
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }

    fn take_pending(&mut self) -> Option<HubEvent> {
        self.last_jobs = Some(Instant::now());
        self.pending_jobs.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscribers_get_events_and_jobs_are_coalesced() {
        // A private channel: the global bus also carries what other tests do.
        let (tx, rx) = broadcast::channel(CAPACITY);
        let send = |kind: &'static str, data: Value| {
            let _ = tx.send(HubEvent { kind, data });
        };
        let mut t = Throttled::new(rx);
        send("library", json!({ "indexEpoch": 7 }));
        let ev = t.next().await.unwrap();
        assert_eq!(ev.kind, "library");
        assert_eq!(ev.data["indexEpoch"], 7);

        // Five progress lines in a burst: the first at once, the last after the gap.
        for i in 0..5 {
            send("jobs", json!({ "n": i }));
        }
        let first = t.next().await.unwrap();
        assert_eq!(first.data["n"], 0);
        let started = Instant::now();
        let last = t.next().await.unwrap();
        assert_eq!(last.data["n"], 4);
        assert!(started.elapsed() >= JOBS_MIN_GAP - Duration::from_millis(50));
        // Other kinds are never held back.
        send("remoteAccess", json!({ "status": "running" }));
        assert_eq!(t.next().await.unwrap().kind, "remoteAccess");

        // The process-wide bus reaches a subscriber too.
        let mut sub = Throttled::new(subscribe());
        publish("downloads", json!({ "probe": "events-test" }));
        loop {
            let ev = sub.next().await.unwrap();
            if ev.kind == "downloads" && ev.data["probe"] == "events-test" {
                break;
            }
        }
    }
}
