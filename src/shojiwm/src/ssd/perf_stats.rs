//! Aggregated performance stats for the decoration pipeline.
//!
//! Two independent collectors, each enabled by its own env var and flushed at ~1 Hz:
//!
//! - `SHOJI_IPC_STATS_DEBUG=1` — counts Rust↔Node IPC roundtrips broken down by kind
//!   (`evaluate` / `evaluate_preview` / `evaluate_cached` / `pointer_move_async`),
//!   reporting wall / write / read times, bytes in/out, and per-kind max wall time.
//!
//! - `SHOJI_REFRESH_FRAME_STATS_DEBUG=1` — for each `refresh_window_decorations_for_output`
//!   invocation counts how each window was handled (skipped / managed-only / cached-eval /
//!   full-eval / rebuild / relayout) and how many had a rect change vs the cached snapshot.
//!
//! Both collectors are fully no-op when their env var is unset (single OnceLock bool read).

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tracing::info;

fn ipc_stats_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os("SHOJI_IPC_STATS_DEBUG")
            .is_some_and(|value| value != "0" && !value.is_empty())
    })
}

fn refresh_frame_stats_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os("SHOJI_REFRESH_FRAME_STATS_DEBUG")
            .is_some_and(|value| value != "0" && !value.is_empty())
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpcCallKind {
    Evaluate,
    EvaluatePreview,
    EvaluateCached,
    PointerMoveAsync,
}

#[derive(Default, Clone, Copy)]
struct IpcKindStats {
    count: u64,
    wall_us_total: u64,
    write_us_total: u64,
    read_us_total: u64,
    wall_us_max: u64,
    req_bytes_total: u64,
    resp_bytes_total: u64,
}

#[derive(Default)]
struct IpcStats {
    last_log: Option<Instant>,
    evaluate: IpcKindStats,
    evaluate_preview: IpcKindStats,
    evaluate_cached: IpcKindStats,
    pointer_move_async: IpcKindStats,
}

fn ipc_stats_slot() -> &'static Mutex<IpcStats> {
    static SLOT: OnceLock<Mutex<IpcStats>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(IpcStats::default()))
}

pub struct IpcCallTimer {
    started_at: Instant,
    write_at: Option<Instant>,
    read_at: Option<Instant>,
    kind: IpcCallKind,
    req_bytes: u64,
    resp_bytes: u64,
}

impl IpcCallTimer {
    /// Cheap to construct even when stats are disabled — only an Instant::now().
    pub fn start(kind: IpcCallKind, req_bytes: usize) -> Self {
        Self {
            started_at: Instant::now(),
            write_at: None,
            read_at: None,
            kind,
            req_bytes: req_bytes as u64,
            resp_bytes: 0,
        }
    }

    /// Record completion of the write half (request flushed to the runtime).
    pub fn mark_written(&mut self) {
        if !ipc_stats_enabled() {
            return;
        }
        self.write_at = Some(Instant::now());
    }

    /// Record completion of the read half (response fully received).
    pub fn mark_read(&mut self, resp_bytes: usize) {
        if !ipc_stats_enabled() {
            return;
        }
        self.read_at = Some(Instant::now());
        self.resp_bytes = resp_bytes as u64;
    }

    /// Commit the sample to the aggregator. Safe to call regardless of whether the
    /// read/write marks were recorded — missing marks just attribute zero time to that
    /// half (e.g. when the read failed before completing).
    pub fn finish(self) {
        if !ipc_stats_enabled() {
            return;
        }
        let finished_at = Instant::now();
        let wall_us = finished_at
            .saturating_duration_since(self.started_at)
            .as_micros() as u64;
        let write_us = self
            .write_at
            .map(|t| t.saturating_duration_since(self.started_at).as_micros() as u64)
            .unwrap_or(0);
        let read_us = match (self.write_at, self.read_at) {
            (Some(w), Some(r)) => r.saturating_duration_since(w).as_micros() as u64,
            _ => 0,
        };

        let Ok(mut stats) = ipc_stats_slot().lock() else {
            return;
        };
        let slot = match self.kind {
            IpcCallKind::Evaluate => &mut stats.evaluate,
            IpcCallKind::EvaluatePreview => &mut stats.evaluate_preview,
            IpcCallKind::EvaluateCached => &mut stats.evaluate_cached,
            IpcCallKind::PointerMoveAsync => &mut stats.pointer_move_async,
        };
        slot.count = slot.count.saturating_add(1);
        slot.wall_us_total = slot.wall_us_total.saturating_add(wall_us);
        slot.write_us_total = slot.write_us_total.saturating_add(write_us);
        slot.read_us_total = slot.read_us_total.saturating_add(read_us);
        slot.wall_us_max = slot.wall_us_max.max(wall_us);
        slot.req_bytes_total = slot.req_bytes_total.saturating_add(self.req_bytes);
        slot.resp_bytes_total = slot.resp_bytes_total.saturating_add(self.resp_bytes);

        maybe_flush_ipc_stats(&mut stats, finished_at);
    }
}

fn maybe_flush_ipc_stats(stats: &mut IpcStats, now: Instant) {
    let last_log = *stats.last_log.get_or_insert(now);
    if now.duration_since(last_log) < Duration::from_secs(1) {
        return;
    }
    emit_ipc_stats(stats);
    *stats = IpcStats {
        last_log: Some(now),
        ..IpcStats::default()
    };
}

fn emit_ipc_stats(stats: &IpcStats) {
    fn row(name: &str, slot: &IpcKindStats) {
        if slot.count == 0 {
            return;
        }
        let avg_wall_us = slot.wall_us_total / slot.count;
        let avg_write_us = slot.write_us_total / slot.count;
        let avg_read_us = slot.read_us_total / slot.count;
        let avg_req_bytes = slot.req_bytes_total / slot.count;
        let avg_resp_bytes = slot.resp_bytes_total / slot.count;
        info!(
            kind = name,
            count = slot.count,
            wall_us_total = slot.wall_us_total,
            wall_us_avg = avg_wall_us,
            wall_us_max = slot.wall_us_max,
            write_us_avg = avg_write_us,
            read_us_avg = avg_read_us,
            req_bytes_total = slot.req_bytes_total,
            req_bytes_avg = avg_req_bytes,
            resp_bytes_total = slot.resp_bytes_total,
            resp_bytes_avg = avg_resp_bytes,
            "ipc stats"
        );
    }
    row("evaluate", &stats.evaluate);
    row("evaluate_preview", &stats.evaluate_preview);
    row("evaluate_cached", &stats.evaluate_cached);
    row("pointer_move_async", &stats.pointer_move_async);
}

#[derive(Default)]
struct RefreshFrameStats {
    last_log: Option<Instant>,
    refresh_calls: u64,
    refresh_wall_us_total: u64,
    refresh_wall_us_max: u64,
    windows_seen_total: u64,
    windows_skipped_total: u64,
    windows_managed_only_total: u64,
    windows_runtime_dirty_cached_total: u64,
    windows_runtime_dirty_full_total: u64,
    windows_full_rebuild_total: u64,
    windows_relayout_total: u64,
    windows_position_translate_total: u64,
    windows_ipc_skipped_total: u64,
    // Diagnostic counters: for each window that was runtime_dirty (i.e., a candidate
    // for IPC skip), count which precondition rejected the fast path. These help
    // pinpoint why the skip path isn't firing as often as expected.
    windows_skip_reject_disabled_total: u64,
    windows_skip_reject_state_changed_total: u64,
    windows_skip_reject_force_flags_total: u64,
    windows_skip_reject_not_managed_only_total: u64,
    windows_skip_reject_no_pushed_state_total: u64,
    windows_rect_changed_total: u64,
    windows_size_changed_total: u64,
    /// Snapshot of `runtime_managed_only_window_states.len()` observed at the start
    /// of each refresh, summed over the second. Divide by refresh_calls for avg.
    pushed_states_len_seen_total: u64,
}

fn refresh_frame_stats_slot() -> &'static Mutex<RefreshFrameStats> {
    static SLOT: OnceLock<Mutex<RefreshFrameStats>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(RefreshFrameStats::default()))
}

#[derive(Default)]
pub struct RefreshFrameRecorder {
    started_at: Option<Instant>,
    windows_seen: u64,
    windows_skipped: u64,
    windows_managed_only: u64,
    windows_runtime_dirty_cached: u64,
    windows_runtime_dirty_full: u64,
    windows_full_rebuild: u64,
    windows_relayout: u64,
    windows_position_translate: u64,
    windows_ipc_skipped: u64,
    windows_skip_reject_disabled: u64,
    windows_skip_reject_state_changed: u64,
    windows_skip_reject_force_flags: u64,
    windows_skip_reject_not_managed_only: u64,
    windows_skip_reject_no_pushed_state: u64,
    windows_rect_changed: u64,
    windows_size_changed: u64,
    pushed_states_len_seen: u64,
}

impl RefreshFrameRecorder {
    pub fn start() -> Self {
        if !refresh_frame_stats_enabled() {
            return Self::default();
        }
        Self {
            started_at: Some(Instant::now()),
            ..Self::default()
        }
    }

    #[inline]
    pub fn enabled(&self) -> bool {
        self.started_at.is_some()
    }

    #[inline]
    pub fn record_window_seen(&mut self) {
        if !self.enabled() {
            return;
        }
        self.windows_seen += 1;
    }

    #[inline]
    pub fn record_window_skipped(&mut self) {
        if !self.enabled() {
            return;
        }
        self.windows_skipped += 1;
    }

    #[inline]
    pub fn record_managed_only(&mut self) {
        if !self.enabled() {
            return;
        }
        self.windows_managed_only += 1;
    }

    #[inline]
    pub fn record_runtime_dirty_cached(&mut self) {
        if !self.enabled() {
            return;
        }
        self.windows_runtime_dirty_cached += 1;
    }

    #[inline]
    pub fn record_runtime_dirty_full(&mut self) {
        if !self.enabled() {
            return;
        }
        self.windows_runtime_dirty_full += 1;
    }

    #[inline]
    pub fn record_full_rebuild(&mut self) {
        if !self.enabled() {
            return;
        }
        self.windows_full_rebuild += 1;
    }

    #[inline]
    pub fn record_relayout(&mut self) {
        if !self.enabled() {
            return;
        }
        self.windows_relayout += 1;
    }

    #[inline]
    pub fn record_position_translate(&mut self) {
        if !self.enabled() {
            return;
        }
        self.windows_position_translate += 1;
    }

    /// Records that this window took the IPC-skip fast path (TS-pushed managed-only
    /// state applied directly, no `evaluate_cached` roundtrip). The window is also
    /// counted as `managed_only` separately so the totals add up to seen counts.
    #[inline]
    pub fn record_ipc_skipped(&mut self) {
        if !self.enabled() {
            return;
        }
        self.windows_ipc_skipped += 1;
    }

    /// Records why a runtime-dirty window was *not* eligible for IPC skip. Call at
    /// most one of these per window per refresh — they encode mutually exclusive
    /// rejection reasons checked in the order they appear in `skip_eligible`.
    #[inline]
    pub fn record_skip_reject(&mut self, reason: SkipRejectReason) {
        if !self.enabled() {
            return;
        }
        match reason {
            SkipRejectReason::Disabled => self.windows_skip_reject_disabled += 1,
            SkipRejectReason::StateChanged => self.windows_skip_reject_state_changed += 1,
            SkipRejectReason::ForceFlags => self.windows_skip_reject_force_flags += 1,
            SkipRejectReason::NotManagedOnly => self.windows_skip_reject_not_managed_only += 1,
            SkipRejectReason::NoPushedState => self.windows_skip_reject_no_pushed_state += 1,
        }
    }

    /// Observe how many TS-pushed managed-only states are sitting in the buffer
    /// when this refresh begins. Helps tell apart "TS isn't pushing" vs "TS is
    /// pushing but condition rejects".
    #[inline]
    pub fn observe_pushed_states_len(&mut self, len: usize) {
        if !self.enabled() {
            return;
        }
        self.pushed_states_len_seen = self.pushed_states_len_seen.saturating_add(len as u64);
    }

    /// Tracks whether the snapshot rect (origin and/or size) differed from the cached one.
    /// Caller computes the booleans because we don't want to re-derive them here.
    #[inline]
    pub fn record_rect_diff(&mut self, position_changed: bool, size_changed: bool) {
        if !self.enabled() {
            return;
        }
        if position_changed || size_changed {
            self.windows_rect_changed += 1;
        }
        if size_changed {
            self.windows_size_changed += 1;
        }
    }

    pub fn finish(self) {
        let Some(started_at) = self.started_at else {
            return;
        };
        let now = Instant::now();
        let wall_us = now.saturating_duration_since(started_at).as_micros() as u64;
        let Ok(mut stats) = refresh_frame_stats_slot().lock() else {
            return;
        };
        stats.refresh_calls = stats.refresh_calls.saturating_add(1);
        stats.refresh_wall_us_total = stats.refresh_wall_us_total.saturating_add(wall_us);
        stats.refresh_wall_us_max = stats.refresh_wall_us_max.max(wall_us);
        stats.windows_seen_total = stats.windows_seen_total.saturating_add(self.windows_seen);
        stats.windows_skipped_total = stats
            .windows_skipped_total
            .saturating_add(self.windows_skipped);
        stats.windows_managed_only_total = stats
            .windows_managed_only_total
            .saturating_add(self.windows_managed_only);
        stats.windows_runtime_dirty_cached_total = stats
            .windows_runtime_dirty_cached_total
            .saturating_add(self.windows_runtime_dirty_cached);
        stats.windows_runtime_dirty_full_total = stats
            .windows_runtime_dirty_full_total
            .saturating_add(self.windows_runtime_dirty_full);
        stats.windows_full_rebuild_total = stats
            .windows_full_rebuild_total
            .saturating_add(self.windows_full_rebuild);
        stats.windows_relayout_total = stats
            .windows_relayout_total
            .saturating_add(self.windows_relayout);
        stats.windows_position_translate_total = stats
            .windows_position_translate_total
            .saturating_add(self.windows_position_translate);
        stats.windows_ipc_skipped_total = stats
            .windows_ipc_skipped_total
            .saturating_add(self.windows_ipc_skipped);
        stats.windows_skip_reject_disabled_total = stats
            .windows_skip_reject_disabled_total
            .saturating_add(self.windows_skip_reject_disabled);
        stats.windows_skip_reject_state_changed_total = stats
            .windows_skip_reject_state_changed_total
            .saturating_add(self.windows_skip_reject_state_changed);
        stats.windows_skip_reject_force_flags_total = stats
            .windows_skip_reject_force_flags_total
            .saturating_add(self.windows_skip_reject_force_flags);
        stats.windows_skip_reject_not_managed_only_total = stats
            .windows_skip_reject_not_managed_only_total
            .saturating_add(self.windows_skip_reject_not_managed_only);
        stats.windows_skip_reject_no_pushed_state_total = stats
            .windows_skip_reject_no_pushed_state_total
            .saturating_add(self.windows_skip_reject_no_pushed_state);
        stats.pushed_states_len_seen_total = stats
            .pushed_states_len_seen_total
            .saturating_add(self.pushed_states_len_seen);
        stats.windows_rect_changed_total = stats
            .windows_rect_changed_total
            .saturating_add(self.windows_rect_changed);
        stats.windows_size_changed_total = stats
            .windows_size_changed_total
            .saturating_add(self.windows_size_changed);

        maybe_flush_refresh_frame_stats(&mut stats, now);
    }
}

/// Reason a candidate window failed the IPC-skip eligibility check. Each variant
/// corresponds to one of the booleans inside `skip_eligible`. Reported at most
/// once per window per refresh, in the order the eligibility check evaluates.
#[derive(Debug, Clone, Copy)]
pub enum SkipRejectReason {
    Disabled,
    StateChanged,
    ForceFlags,
    NotManagedOnly,
    NoPushedState,
}

/// Origin of a `mark_runtime_dirty_windows` call. Used to attribute *which* code
/// path is stripping the managed-only marker (by calling with an empty
/// `dirty_managed_window_ids` while the window already had the marker), which is
/// the leading cause of the remaining `NotManagedOnly` skip rejections.
#[derive(Debug, Clone, Copy)]
pub enum DirtyOrigin {
    SchedulerTick,
    PointerMoveAsync,
    InvokeKeyBinding,
    InvokeHandler,
    WindowMove,
    WindowResize,
    WindowStateRequest,
    XdgMetadata,
    Other,
}

impl DirtyOrigin {
    fn as_str(self) -> &'static str {
        match self {
            DirtyOrigin::SchedulerTick => "scheduler_tick",
            DirtyOrigin::PointerMoveAsync => "pointer_move_async",
            DirtyOrigin::InvokeKeyBinding => "invoke_key_binding",
            DirtyOrigin::InvokeHandler => "invoke_handler",
            DirtyOrigin::WindowMove => "window_move",
            DirtyOrigin::WindowResize => "window_resize",
            DirtyOrigin::WindowStateRequest => "window_state_request",
            DirtyOrigin::XdgMetadata => "xdg_metadata",
            DirtyOrigin::Other => "other",
        }
    }

    const ALL: [DirtyOrigin; 9] = [
        DirtyOrigin::SchedulerTick,
        DirtyOrigin::PointerMoveAsync,
        DirtyOrigin::InvokeKeyBinding,
        DirtyOrigin::InvokeHandler,
        DirtyOrigin::WindowMove,
        DirtyOrigin::WindowResize,
        DirtyOrigin::WindowStateRequest,
        DirtyOrigin::XdgMetadata,
        DirtyOrigin::Other,
    ];

    fn index(self) -> usize {
        match self {
            DirtyOrigin::SchedulerTick => 0,
            DirtyOrigin::PointerMoveAsync => 1,
            DirtyOrigin::InvokeKeyBinding => 2,
            DirtyOrigin::InvokeHandler => 3,
            DirtyOrigin::WindowMove => 4,
            DirtyOrigin::WindowResize => 5,
            DirtyOrigin::WindowStateRequest => 6,
            DirtyOrigin::XdgMetadata => 7,
            DirtyOrigin::Other => 8,
        }
    }
}

fn dirty_origin_stats_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os("SHOJI_DIRTY_ORIGIN_STATS_DEBUG")
            .is_some_and(|value| value != "0" && !value.is_empty())
    })
}

#[derive(Default)]
struct DirtyOriginStats {
    last_log: Option<Instant>,
    /// For each origin, count of `mark_runtime_dirty_windows` calls.
    calls: [u64; 9],
    /// For each origin, count of windows marked dirty (all variants).
    windows_marked: [u64; 9],
    /// For each origin, count of windows that gained the managed-only marker
    /// (= the call included them in `dirty_managed_window_ids`).
    managed_only_added: [u64; 9],
    /// For each origin, count of windows whose previous managed-only marker
    /// was *removed* by this call (= the call's `dirty_managed_window_ids` did
    /// NOT contain them, but they were already in `runtime_managed_only_window_ids`).
    /// THIS IS THE PRIMARY DIAGNOSTIC — high values point at the culprit path.
    managed_only_stripped: [u64; 9],
}

fn dirty_origin_stats_slot() -> &'static Mutex<DirtyOriginStats> {
    static SLOT: OnceLock<Mutex<DirtyOriginStats>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(DirtyOriginStats::default()))
}

/// Record a single window's outcome from a `mark_runtime_dirty_windows` call.
/// `was_managed_only_before` = whether the window was in
/// `runtime_managed_only_window_ids` *before* this call. `now_managed_only`
/// = whether the call included it in `dirty_managed_window_ids`.
pub fn record_dirty_mark(
    origin: DirtyOrigin,
    was_managed_only_before: bool,
    now_managed_only: bool,
) {
    if !dirty_origin_stats_enabled() {
        return;
    }
    let Ok(mut stats) = dirty_origin_stats_slot().lock() else {
        return;
    };
    let idx = origin.index();
    stats.windows_marked[idx] = stats.windows_marked[idx].saturating_add(1);
    if now_managed_only {
        stats.managed_only_added[idx] = stats.managed_only_added[idx].saturating_add(1);
    } else if was_managed_only_before {
        stats.managed_only_stripped[idx] = stats.managed_only_stripped[idx].saturating_add(1);
    }
    maybe_flush_dirty_origin_stats(&mut stats, Instant::now());
}

/// Record a call boundary (one `mark_runtime_dirty_windows` invocation) per
/// origin. Per-window outcomes are reported separately via `record_dirty_mark`.
pub fn record_dirty_call(origin: DirtyOrigin) {
    if !dirty_origin_stats_enabled() {
        return;
    }
    let Ok(mut stats) = dirty_origin_stats_slot().lock() else {
        return;
    };
    stats.calls[origin.index()] = stats.calls[origin.index()].saturating_add(1);
}

fn maybe_flush_dirty_origin_stats(stats: &mut DirtyOriginStats, now: Instant) {
    let last_log = *stats.last_log.get_or_insert(now);
    if now.duration_since(last_log) < Duration::from_secs(1) {
        return;
    }
    emit_dirty_origin_stats(stats);
    *stats = DirtyOriginStats {
        last_log: Some(now),
        ..DirtyOriginStats::default()
    };
}

fn emit_dirty_origin_stats(stats: &DirtyOriginStats) {
    for origin in DirtyOrigin::ALL {
        let i = origin.index();
        if stats.calls[i] == 0 && stats.windows_marked[i] == 0 {
            continue;
        }
        info!(
            origin = origin.as_str(),
            calls = stats.calls[i],
            windows_marked = stats.windows_marked[i],
            managed_only_added = stats.managed_only_added[i],
            managed_only_stripped = stats.managed_only_stripped[i],
            "dirty origin stats"
        );
    }
}

fn maybe_flush_refresh_frame_stats(stats: &mut RefreshFrameStats, now: Instant) {
    let last_log = *stats.last_log.get_or_insert(now);
    if now.duration_since(last_log) < Duration::from_secs(1) {
        return;
    }
    emit_refresh_frame_stats(stats);
    *stats = RefreshFrameStats {
        last_log: Some(now),
        ..RefreshFrameStats::default()
    };
}

fn emit_refresh_frame_stats(stats: &RefreshFrameStats) {
    if stats.refresh_calls == 0 {
        return;
    }
    let avg_wall_us = stats.refresh_wall_us_total / stats.refresh_calls;
    let windows_per_refresh = if stats.refresh_calls > 0 {
        stats.windows_seen_total as f64 / stats.refresh_calls as f64
    } else {
        0.0
    };
    info!(
        refresh_calls = stats.refresh_calls,
        refresh_wall_us_avg = avg_wall_us,
        refresh_wall_us_max = stats.refresh_wall_us_max,
        windows_seen_total = stats.windows_seen_total,
        windows_per_refresh_avg = windows_per_refresh,
        windows_skipped_total = stats.windows_skipped_total,
        windows_managed_only_total = stats.windows_managed_only_total,
        windows_runtime_dirty_cached_total = stats.windows_runtime_dirty_cached_total,
        windows_runtime_dirty_full_total = stats.windows_runtime_dirty_full_total,
        windows_full_rebuild_total = stats.windows_full_rebuild_total,
        windows_relayout_total = stats.windows_relayout_total,
        windows_position_translate_total = stats.windows_position_translate_total,
        windows_ipc_skipped_total = stats.windows_ipc_skipped_total,
        windows_skip_reject_disabled_total = stats.windows_skip_reject_disabled_total,
        windows_skip_reject_state_changed_total = stats.windows_skip_reject_state_changed_total,
        windows_skip_reject_force_flags_total = stats.windows_skip_reject_force_flags_total,
        windows_skip_reject_not_managed_only_total =
            stats.windows_skip_reject_not_managed_only_total,
        windows_skip_reject_no_pushed_state_total = stats.windows_skip_reject_no_pushed_state_total,
        pushed_states_len_seen_total = stats.pushed_states_len_seen_total,
        windows_rect_changed_total = stats.windows_rect_changed_total,
        windows_size_changed_total = stats.windows_size_changed_total,
        "refresh frame stats"
    );
}
