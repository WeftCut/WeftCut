//! Import diagnostics are observational: scoped events, monotonic durations,
//! no I/O or resource leases of their own. Main correlates media ids with the
//! importing request and writes these events to the existing LogBus.
use crate::events::EventSink;
use std::sync::Arc;
use std::time::Instant;

pub(crate) struct StageTimer {
    events: Arc<dyn EventSink>,
    stage: String,
    import_id: Option<String>,
    media_id: Option<String>,
    queued: Instant,
    running: Option<Instant>,
    cache: &'static str,
    admission: serde_json::Value,
    finished: bool,
}
impl StageTimer {
    pub(crate) fn new(
        events: Arc<dyn EventSink>,
        stage: impl Into<String>,
        import_id: Option<String>,
        media_id: Option<String>,
    ) -> Self {
        let timer = Self {
            events,
            stage: stage.into(),
            import_id,
            media_id,
            queued: Instant::now(),
            running: None,
            cache: "miss",
            admission: crate::resources::background_diagnostic_state(),
            finished: false,
        };
        timer.emit("queued", None);
        timer
    }
    pub(crate) fn start(&mut self) {
        self.running = Some(Instant::now());
        self.emit("running", None);
    }
    pub(crate) fn hit(&mut self) {
        self.cache = "hit";
        // Cache validation does work but never waits for admission. Do not
        // report its filesystem reads as resource queue time.
        self.running = Some(self.queued);
    }
    pub(crate) fn finish<T>(&mut self, result: &anyhow::Result<T>) {
        if self.running.is_none() && self.cache != "hit" && result.is_ok() {
            self.cache = "shared";
        }
        self.finished = true;
        match result {
            Ok(_) => self.emit("completed", None),
            Err(e) => self.emit(
                if e.to_string().contains("cancelled") {
                    "cancelled"
                } else {
                    "failed"
                },
                Some(format!("{e:#}")),
            ),
        }
    }
    pub(crate) fn cancelled(&mut self) {
        self.finished = true;
        self.emit("cancelled", None);
    }
    fn emit(&self, status: &str, error: Option<String>) {
        let now = Instant::now();
        let queue_ms = (self.running.unwrap_or(now) - self.queued).as_secs_f64() * 1000.0;
        let work_ms = self
            .running
            .map_or(0.0, |start| (now - start).as_secs_f64() * 1000.0);
        let payload = serde_json::json!({
            "import_id": self.import_id, "media_id": self.media_id, "stage": self.stage,
            "status": status, "queue_ms": queue_ms, "work_ms": work_ms,
            "total_ms": queue_ms + work_ms, "cache": self.cache, "error": error,
            "admission_at_enqueue": self.admission,
        });
        self.events.emit("import:diagnostic", payload);
    }
}
impl Drop for StageTimer {
    fn drop(&mut self) {
        if !self.finished {
            self.emit("cancelled", None);
        }
    }
}

pub(crate) fn plan(
    events: &Arc<dyn EventSink>,
    media_id: crate::state::MediaId,
    stages: &[&str],
    decision_pending: bool,
) {
    events.emit("import:diagnostic-plan", serde_json::json!({
        "media_id": media_id.to_string(), "stages": stages, "decision_pending": decision_pending,
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::VecEventSink;
    #[test]
    fn separates_wait_from_work_and_finishes_once() {
        let sink = Arc::new(VecEventSink::new());
        let mut timer = StageTimer::new(sink.clone(), "hash", Some("request".into()), None);
        timer.queued = Instant::now() - std::time::Duration::from_millis(100);
        timer.start();
        timer.finish(&Ok(()));
        drop(timer);
        let rows = sink.events.lock().unwrap();
        assert_eq!(rows.len(), 3);
        let row = &rows[2].1;
        assert_eq!(row["status"], "completed");
        assert_eq!(row["cache"], "miss");
        assert!(row["queue_ms"].as_f64().unwrap() >= 100.0);
        assert_eq!(row["import_id"], "request");
        assert!(
            (row["queue_ms"].as_f64().unwrap() + row["work_ms"].as_f64().unwrap()
                - row["total_ms"].as_f64().unwrap())
            .abs()
                < 0.001
        );
    }
    #[test]
    fn cache_shared_failure_and_drop_are_distinct() {
        let sink = Arc::new(VecEventSink::new());
        for mode in ["hit", "shared", "failed", "cancelled"] {
            let mut timer = StageTimer::new(sink.clone(), mode, None, Some("media".into()));
            match mode {
                "hit" => {
                    timer.hit();
                    timer.finish(&Ok(()));
                }
                "shared" => timer.finish(&Ok(())),
                "failed" => timer.finish(&Err::<(), _>(anyhow::anyhow!("disk unavailable"))),
                _ => (),
            }
        }
        let rows = sink.events.lock().unwrap();
        assert_eq!(rows[1].1["cache"], "hit");
        assert_eq!(rows[3].1["cache"], "shared");
        assert_eq!(rows[5].1["status"], "failed");
        assert_eq!(rows[7].1["status"], "cancelled");
    }
}
