//! Recent-errors ring buffer (parity `server/errorBuffer.mjs`).
//!
//! A `tracing` layer captures every WARN/ERROR event so the admin panel can show
//! what went wrong without asking the user to read the console.

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

const CAPACITY: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEntry {
    pub ts: String,
    pub level: String,
    pub target: String,
    pub message: String,
}

fn buffer() -> &'static Mutex<Vec<ErrorEntry>> {
    static BUF: OnceLock<Mutex<Vec<ErrorEntry>>> = OnceLock::new();
    BUF.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn push(level: &str, target: &str, message: impl Into<String>) {
    let entry = ErrorEntry {
        ts: chrono::Utc::now().to_rfc3339(),
        level: level.to_string(),
        target: target.to_string(),
        message: message.into(),
    };
    if let Ok(mut buf) = buffer().lock() {
        buf.push(entry);
        if buf.len() > CAPACITY {
            let overflow = buf.len() - CAPACITY;
            buf.drain(0..overflow);
        }
    }
}

/// Newest first.
pub fn recent(limit: usize) -> Vec<ErrorEntry> {
    let Ok(buf) = buffer().lock() else {
        return Vec::new();
    };
    buf.iter().rev().take(limit.max(1)).cloned().collect()
}

pub fn count() -> usize {
    buffer().lock().map(|b| b.len()).unwrap_or(0)
}

pub fn clear() {
    if let Ok(mut buf) = buffer().lock() {
        buf.clear();
    }
}

#[derive(Default)]
struct MessageVisitor {
    message: String,
    extras: Vec<String>,
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let rendered = format!("{value:?}");
        if field.name() == "message" {
            self.message = rendered.trim_matches('"').to_string();
        } else {
            self.extras.push(format!("{}={}", field.name(), rendered));
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.extras.push(format!("{}={}", field.name(), value));
        }
    }
}

/// Tracing layer that mirrors WARN/ERROR events into the ring buffer.
pub struct ErrorBufferLayer;

impl<S: Subscriber> Layer<S> for ErrorBufferLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let level = *event.metadata().level();
        if level > Level::WARN {
            return;
        }
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let mut message = visitor.message;
        if !visitor.extras.is_empty() {
            if !message.is_empty() {
                message.push_str(" — ");
            }
            message.push_str(&visitor.extras.join(" "));
        }
        if message.is_empty() {
            return;
        }
        push(level.as_str(), event.metadata().target(), message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_keeps_newest_entries() {
        clear();
        for i in 0..(CAPACITY + 10) {
            push("ERROR", "test", format!("boom {i}"));
        }
        assert_eq!(count(), CAPACITY);
        let recent = recent(3);
        assert_eq!(recent.len(), 3);
        assert!(recent[0].message.ends_with(&(CAPACITY + 9).to_string()));
        clear();
    }
}
