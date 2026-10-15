use crate::settings::DEFAULT_RECORD_SHORTCUT;
use rdev::Key;
use serde::Serialize;
#[cfg(target_os = "macos")]
use std::ffi::c_void;
use std::sync::mpsc::{self, Receiver, Sender};
#[cfg(target_os = "macos")]
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(not(target_os = "windows"))]
use tauri::LogicalPosition;

// Recording starts the instant the modifier combo is down — there is no startup
// gate. A press shorter than this is treated as a mis-trigger and discarded
// (see handle_event Release / NonModifierPress). Anchored on the key-down time,
// so it's unaffected by the frontend's getUserMedia cold-start.
pub const CANCEL_THRESHOLD: Duration = Duration::from_millis(500);
// After the combo is released we still wait briefly before stopping, so a small
// stagger between the two modifier keys lifting doesn't clip the audio tail.
pub const STOP_DEBOUNCE: Duration = Duration::from_millis(250);
// A press shorter than CANCEL_THRESHOLD is a tap. After a tap we wait this long
// for a second press before deciding: a second press locks the recording
// (hands-free), otherwise the tap is dispatched on its own (Action::Tap).
// Which one a quick re-press means is told apart by the first hold: at or over
// CANCEL_THRESHOLD it was speech and STOP_DEBOUNCE applies instead.
pub const DOUBLE_TAP_WINDOW: Duration = Duration::from_millis(350);
// A locked recording stops (and is transcribed) on its own after this long, so
// a forgotten lock cannot keep the microphone open. Sized for the cloud upload
// cap: 25 MiB of 16 kHz PCM16 WAV is about 13.6 minutes.
pub const LOCKED_MAX: Duration = Duration::from_secs(12 * 60);
const SLOW_NATIVE_STARTUP: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingStartEvent {
  dispatched_at_unix_ms: u64,
  native_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingLockEvent {
  lock_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shortcut {
  pub ctrl: bool,
  pub shift: bool,
  pub alt: bool,
  pub meta: bool,
}

impl Shortcut {
  pub fn parse(value: &str) -> Option<Self> {
    let mut shortcut = Shortcut {
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    };
    let mut count = 0;

    for token in value.split('+') {
      match token.trim().to_ascii_lowercase().as_str() {
        "ctrl" | "control" => {
          if !shortcut.ctrl {
            count += 1;
          }
          shortcut.ctrl = true;
        }
        "shift" => {
          if !shortcut.shift {
            count += 1;
          }
          shortcut.shift = true;
        }
        "alt" | "option" => {
          if !shortcut.alt {
            count += 1;
          }
          shortcut.alt = true;
        }
        "meta" | "command" | "cmd" | "super" | "win" | "windows" => {
          if !shortcut.meta {
            count += 1;
          }
          shortcut.meta = true;
        }
        "" => {}
        _ => return None,
      }
    }

    if count >= 2 {
      Some(shortcut)
    } else {
      None
    }
  }

}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ModifierState {
  pub ctrl: bool,
  pub shift: bool,
  pub alt: bool,
  pub meta: bool,
}

impl ModifierState {
  pub fn press(&mut self, key: Key) -> bool {
    match key {
      Key::ControlLeft | Key::ControlRight => {
        self.ctrl = true;
        true
      }
      Key::ShiftLeft | Key::ShiftRight => {
        self.shift = true;
        true
      }
      Key::Alt | Key::AltGr => {
        self.alt = true;
        true
      }
      Key::MetaLeft | Key::MetaRight => {
        self.meta = true;
        true
      }
      _ => false,
    }
  }

  pub fn release(&mut self, key: Key) -> bool {
    match key {
      Key::ControlLeft | Key::ControlRight => {
        self.ctrl = false;
        true
      }
      Key::ShiftLeft | Key::ShiftRight => {
        self.shift = false;
        true
      }
      Key::Alt | Key::AltGr => {
        self.alt = false;
        true
      }
      Key::MetaLeft | Key::MetaRight => {
        self.meta = false;
        true
      }
      _ => false,
    }
  }

  pub fn matches(&self, shortcut: &Shortcut) -> bool {
    self.ctrl == shortcut.ctrl
      && self.shift == shortcut.shift
      && self.alt == shortcut.alt
      && self.meta == shortcut.meta
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
  Start,
  Stop,
  Cancel,
  /// A clean short press that no second press followed. The frontend discards
  /// the recording it started and, while a failure card is showing, inserts
  /// that card's text instead.
  Tap,
  /// A double tap: the recording keeps going without the keys held.
  Lock(u64),
}

#[derive(Debug, Clone, Copy)]
pub enum KeyEvent {
  Press(Key),
  Release(Key),
  NonModifierPress,
}

#[derive(Debug)]
pub enum HotkeyMsg {
  /// A key event and, where the platform reports it, the PID of the process
  /// that posted it (0 for hardware input on macOS).
  KeyEvent(KeyEvent, Option<i64>),
  UpdateShortcut(String),
  /// The frontend ended a locked recording on its own (startup failure,
  /// interrupted capture), so the next press must start, not stop.
  ReleaseLock(u64),
}

#[derive(Clone)]
pub struct HotkeyHandle {
  tx: Sender<HotkeyMsg>,
}

impl HotkeyHandle {
  pub fn update_shortcut(&self, shortcut: String) {
    let _ = self.tx.send(HotkeyMsg::UpdateShortcut(shortcut));
  }

  pub fn release_lock(&self, lock_id: u64) {
    let _ = self.tx.send(HotkeyMsg::ReleaseLock(lock_id));
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LockPhase {
  /// The press that locked is still down. Held past CANCEL_THRESHOLD it turns
  /// out to be an ordinary hold, and its release stops as usual.
  LockingPress { since: Instant },
  /// Keys are up; the next time the combo forms, the recording stops.
  Armed,
}

#[derive(Debug, Clone, Copy)]
struct Lock {
  id: u64,
  phase: LockPhase,
  expires_at: Instant,
}

#[derive(Debug)]
pub struct HotkeyState {
  modifiers: ModifierState,
  record_shortcut: Shortcut,
  is_recording: bool,
  record_started_at: Option<Instant>,
  stop_deadline: Option<Instant>,
  /// Set after a tap while a second press may still turn it into a lock.
  tap_deadline: Option<Instant>,
  /// Every key of the combo has come up since the tap, so the next formation
  /// is a second press rather than one key bouncing back.
  tap_keys_up: bool,
  lock: Option<Lock>,
  last_lock_id: u64,
  pending: Vec<Action>,
}

impl HotkeyState {
  pub fn new(record_shortcut: Shortcut) -> Self {
    Self {
      modifiers: ModifierState::default(),
      record_shortcut,
      is_recording: false,
      record_started_at: None,
      stop_deadline: None,
      tap_deadline: None,
      tap_keys_up: false,
      lock: None,
      last_lock_id: 0,
      pending: Vec::new(),
    }
  }

  fn combo_held(&self) -> bool {
    self.modifiers.matches(&self.record_shortcut)
  }

  fn combo_keys_up(&self) -> bool {
    let (keys, held) = (&self.record_shortcut, &self.modifiers);
    !(keys.ctrl && held.ctrl || keys.shift && held.shift || keys.alt && held.alt || keys.meta && held.meta)
  }

  pub fn handle_event(&mut self, event: KeyEvent, now: Instant) {
    match event {
      KeyEvent::NonModifierPress => self.handle_non_modifier_press(now),
      KeyEvent::Press(key) => {
        if key == Key::Escape {
          if self.is_recording {
            self.cancel_recording();
          }
          self.stop_deadline = None;
          return;
        }

        let is_modifier = self.modifiers.press(key);
        if !is_modifier {
          self.handle_non_modifier_press(now);
          return;
        }

        if let Some(lock) = self.lock {
          // The locking press itself cannot form the combo again; any later
          // formation is the press that ends the recording.
          if lock.phase == LockPhase::Armed && self.combo_held() {
            self.finish_recording(Action::Stop);
          }
          return;
        }

        if self.tap_deadline.is_some() && self.combo_held() {
          self.tap_deadline = None;
          if !self.tap_keys_up {
            // One key bounced back before the combo was fully up: the first
            // press is still going, as a hold.
            return;
          }
          self.last_lock_id += 1;
          self.lock = Some(Lock {
            id: self.last_lock_id,
            phase: LockPhase::LockingPress { since: now },
            expires_at: now + LOCKED_MAX,
          });
          self.pending.push(Action::Lock(self.last_lock_id));
          return;
        }

        if self.is_recording && self.combo_held() {
          // Combo re-formed (e.g. a modifier re-pressed) — keep recording.
          self.stop_deadline = None;
          return;
        }

        // Combo just completed: start recording immediately — no startup gate.
        // Mis-triggers are handled after the fact (short release / combo key).
        if !self.is_recording && self.combo_held() {
          self.is_recording = true;
          self.record_started_at = Some(now);
          self.stop_deadline = None;
          self.pending.push(Action::Start);
        }
      }
      KeyEvent::Release(key) => {
        let is_modifier = self.modifiers.release(key);
        if !is_modifier {
          return;
        }

        if self.combo_held() {
          // Still a valid combo (an unrelated modifier lifted) — keep recording.
          self.stop_deadline = None;
        } else if let Some(lock) = self.lock {
          if let LockPhase::LockingPress { since } = lock.phase {
            if now.saturating_duration_since(since) >= CANCEL_THRESHOLD {
              // Tap, then press-and-hold: an ordinary dictation after all.
              self.lock = None;
              self.stop_deadline = Some(now + STOP_DEBOUNCE);
            } else if self.combo_keys_up() {
              self.lock = Some(Lock { phase: LockPhase::Armed, ..lock });
            }
          }
        } else if self.tap_deadline.is_some() {
          self.tap_keys_up = self.combo_keys_up();
        } else if self.is_recording && self.stop_deadline.is_none() && self.tap_deadline.is_none() {
          // Combo broken. Too short → a tap: wait for a possible second press.
          // Otherwise stop after STOP_DEBOUNCE so a stagger between the keys
          // lifting doesn't clip the tail. Held time is measured from key-down,
          // independent of the frontend's mic cold-start.
          let held = self
            .record_started_at
            .map(|started| now.saturating_duration_since(started))
            .unwrap_or_default();
          if held < CANCEL_THRESHOLD {
            self.tap_deadline = Some(now + DOUBLE_TAP_WINDOW);
            self.tap_keys_up = self.combo_keys_up();
          } else {
            self.stop_deadline = Some(now + STOP_DEBOUNCE);
          }
        }
      }
    }
  }

  fn handle_non_modifier_press(&mut self, now: Instant) {
    // A locked recording runs while the user may type elsewhere; only Escape
    // or the combo ends it.
    if self.lock.is_some() {
      return;
    }
    // A non-modifier pressed right after the combo (e.g. Ctrl+Shift+Arrow)
    // means the user wanted a shortcut, not to record — discard the
    // just-started recording. Only during probation or while a tap awaits its
    // second press, so an accidental keypress deep into a real recording
    // doesn't nuke it, and a tap followed by typing is not a Tap.
    if self.is_recording && (self.in_probation(now) || self.tap_deadline.is_some()) {
      self.cancel_recording();
    }
  }

  /// The frontend ended the locked recording itself. Only the lock it names is
  /// released: a late message must not end a newer lock.
  pub fn release_lock(&mut self, lock_id: u64) {
    if self.lock.is_some_and(|lock| lock.id == lock_id) {
      self.reset_recording();
    }
  }

  fn in_probation(&self, now: Instant) -> bool {
    self
      .record_started_at
      .map(|started| now.saturating_duration_since(started) < CANCEL_THRESHOLD)
      .unwrap_or(false)
  }

  fn cancel_recording(&mut self) {
    self.finish_recording(Action::Cancel);
  }

  fn finish_recording(&mut self, action: Action) {
    self.reset_recording();
    self.pending.push(action);
  }

  fn reset_recording(&mut self) {
    self.is_recording = false;
    self.record_started_at = None;
    self.stop_deadline = None;
    self.tap_deadline = None;
    self.tap_keys_up = false;
    self.lock = None;
  }

  pub fn handle_tick(&mut self, now: Instant) {
    if let Some(deadline) = self.stop_deadline {
      if now >= deadline {
        self.stop_deadline = None;
        if self.is_recording && !self.combo_held() {
          self.finish_recording(Action::Stop);
        }
      }
    }
    if self.tap_deadline.is_some_and(|deadline| now >= deadline) {
      self.finish_recording(Action::Tap);
    }
    if self.lock.is_some_and(|lock| now >= lock.expires_at) {
      log::info!("hotkey: locked recording reached its time limit");
      self.finish_recording(Action::Stop);
    }
  }

  pub fn next_deadline(&self) -> Option<Instant> {
    [self.stop_deadline, self.tap_deadline, self.lock.map(|lock| lock.expires_at)]
      .into_iter()
      .flatten()
      .min()
  }

  pub fn drain_actions(&mut self) -> Vec<Action> {
    std::mem::take(&mut self.pending)
  }
}

pub fn start_listener(app: &AppHandle, initial_shortcut: String) -> HotkeyHandle {
  let (tx, rx) = mpsc::channel::<HotkeyMsg>();
  let handle = HotkeyHandle { tx: tx.clone() };
  spawn_os_listener(handle.clone());

  let app_handle = app.clone();
  thread::Builder::new()
    .name("hotkey-state".into())
    .spawn(move || run_state_thread(app_handle, rx, initial_shortcut))
    .expect("failed to spawn hotkey state thread");

  handle
}

pub fn restart_os_listener(handle: HotkeyHandle) {
  spawn_os_listener(handle);
}

#[cfg(target_os = "macos")]
fn spawn_os_listener(handle: HotkeyHandle) {
  if !crate::platform::accessibility_granted(false) {
    log::info!("skipping macOS hotkey listener startup until Accessibility permission is granted");
    return;
  }

  thread::Builder::new()
    .name("hotkey-eventtap".into())
    .spawn(move || {
      if let Err(error) = run_macos_event_tap(handle.tx.clone()) {
        log::error!("global hotkey listener exited: {error}");
      }
    })
    .expect("failed to spawn hotkey listener thread");
}

#[cfg(not(target_os = "macos"))]
fn spawn_os_listener(handle: HotkeyHandle) {
  thread::Builder::new()
    .name("hotkey-rdev".into())
    .spawn(move || {
      if let Err(error) = rdev::listen(move |event| {
        let key_event = match event.event_type {
          rdev::EventType::KeyPress(key) => Some(KeyEvent::Press(key)),
          rdev::EventType::KeyRelease(key) => Some(KeyEvent::Release(key)),
          _ => None,
        };

        if let Some(key_event) = key_event {
          let _ = handle.tx.send(HotkeyMsg::KeyEvent(key_event, None));
        }
      }) {
        log::error!("global hotkey listener exited: {error:?}");
      }
    })
    .expect("failed to spawn hotkey listener thread");
}

#[cfg(target_os = "macos")]
struct MacEventTapContext {
  tx: Sender<HotkeyMsg>,
  modifiers: Mutex<ModifierState>,
}

#[cfg(target_os = "macos")]
fn run_macos_event_tap(tx: Sender<HotkeyMsg>) -> Result<(), String> {
  let context = Box::into_raw(Box::new(MacEventTapContext {
    tx,
    modifiers: Mutex::new(ModifierState::default()),
  }));

  let event_mask = (1_u64 << KCG_EVENT_KEY_DOWN) | (1_u64 << KCG_EVENT_FLAGS_CHANGED);
  let tap = unsafe {
    CGEventTapCreate(
      KCG_SESSION_EVENT_TAP,
      KCG_HEAD_INSERT_EVENT_TAP,
      KCG_EVENT_TAP_OPTION_LISTEN_ONLY,
      event_mask,
      macos_event_tap_callback,
      context.cast(),
    )
  };

  if tap.is_null() {
    unsafe {
      let _ = Box::from_raw(context);
    }
    return Err("failed to create macOS event tap; verify Accessibility permission".into());
  }

  let source = unsafe { CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0) };
  if source.is_null() {
    unsafe {
      let _ = Box::from_raw(context);
    }
    return Err("failed to create macOS run loop source for hotkeys".into());
  }

  unsafe {
    let run_loop = CFRunLoopGetCurrent();
    CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
    CFRunLoopRun();
  }

  Ok(())
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn macos_event_tap_callback(
  _proxy: CGEventTapProxy,
  event_type: CGEventType,
  event: CGEventRef,
  user_info: *mut c_void,
) -> CGEventRef {
  if user_info.is_null() {
    return event;
  }

  let context = &*(user_info as *const MacEventTapContext);

  match event_type {
    KCG_EVENT_FLAGS_CHANGED => {
      let next = modifier_state_from_flags(CGEventGetFlags(event));
      let pid = Some(CGEventGetIntegerValueField(event, KCG_EVENT_SOURCE_UNIX_PROCESS_ID));
      if let Ok(mut current) = context.modifiers.lock() {
        emit_modifier_transition(&context.tx, current.ctrl, next.ctrl, Key::ControlLeft, pid);
        emit_modifier_transition(&context.tx, current.shift, next.shift, Key::ShiftLeft, pid);
        emit_modifier_transition(&context.tx, current.alt, next.alt, Key::Alt, pid);
        emit_modifier_transition(&context.tx, current.meta, next.meta, Key::MetaLeft, pid);
        *current = next;
      }
    }
    KCG_EVENT_KEY_DOWN => {
      let key_code = CGEventGetIntegerValueField(event, KCG_KEYBOARD_EVENT_KEYCODE);
      let key_event = if key_code == KVK_ESCAPE {
        KeyEvent::Press(Key::Escape)
      } else {
        KeyEvent::NonModifierPress
      };
      let _ = context.tx.send(HotkeyMsg::KeyEvent(key_event, None));
    }
    _ => {}
  }

  event
}

#[cfg(target_os = "macos")]
fn emit_modifier_transition(tx: &Sender<HotkeyMsg>, previous: bool, next: bool, key: Key, pid: Option<i64>) {
  let key_event = match (previous, next) {
    (false, true) => Some(KeyEvent::Press(key)),
    (true, false) => Some(KeyEvent::Release(key)),
    _ => None,
  };

  if let Some(key_event) = key_event {
    let _ = tx.send(HotkeyMsg::KeyEvent(key_event, pid));
  }
}

#[cfg(target_os = "macos")]
fn modifier_state_from_flags(flags: u64) -> ModifierState {
  ModifierState {
    ctrl: flags & KCG_EVENT_FLAG_MASK_CONTROL != 0,
    shift: flags & KCG_EVENT_FLAG_MASK_SHIFT != 0,
    alt: flags & KCG_EVENT_FLAG_MASK_ALTERNATE != 0,
    meta: flags & KCG_EVENT_FLAG_MASK_COMMAND != 0,
  }
}

#[cfg(target_os = "macos")]
type CGEventTapProxy = *mut c_void;
#[cfg(target_os = "macos")]
type CGEventType = u32;
#[cfg(target_os = "macos")]
type CGEventRef = *mut c_void;
#[cfg(target_os = "macos")]
type CFMachPortRef = *mut c_void;
#[cfg(target_os = "macos")]
type CFRunLoopRef = *mut c_void;
#[cfg(target_os = "macos")]
type CFRunLoopSourceRef = *mut c_void;

#[cfg(target_os = "macos")]
const KCG_SESSION_EVENT_TAP: u32 = 1;
#[cfg(target_os = "macos")]
const KCG_HEAD_INSERT_EVENT_TAP: u32 = 0;
#[cfg(target_os = "macos")]
const KCG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
#[cfg(target_os = "macos")]
const KCG_EVENT_KEY_DOWN: u32 = 10;
#[cfg(target_os = "macos")]
const KCG_EVENT_FLAGS_CHANGED: u32 = 12;
#[cfg(target_os = "macos")]
const KCG_KEYBOARD_EVENT_KEYCODE: i32 = 9;
#[cfg(target_os = "macos")]
const KCG_EVENT_FLAG_MASK_SHIFT: u64 = 1 << 17;
#[cfg(target_os = "macos")]
const KCG_EVENT_FLAG_MASK_CONTROL: u64 = 1 << 18;
#[cfg(target_os = "macos")]
const KCG_EVENT_FLAG_MASK_ALTERNATE: u64 = 1 << 19;
#[cfg(target_os = "macos")]
const KCG_EVENT_FLAG_MASK_COMMAND: u64 = 1 << 20;
#[cfg(target_os = "macos")]
const KVK_ESCAPE: i64 = 53;
#[cfg(target_os = "macos")]
const KCG_EVENT_SOURCE_UNIX_PROCESS_ID: i32 = 41;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
  static kCFRunLoopDefaultMode: *const c_void;

  fn CGEventTapCreate(
    tap: u32,
    place: u32,
    options: u32,
    events_of_interest: u64,
    callback: unsafe extern "C" fn(
      proxy: CGEventTapProxy,
      event_type: CGEventType,
      event: CGEventRef,
      user_info: *mut c_void,
    ) -> CGEventRef,
    user_info: *mut c_void,
  ) -> CFMachPortRef;
  fn CFMachPortCreateRunLoopSource(
    allocator: *const c_void,
    port: CFMachPortRef,
    order: isize,
  ) -> CFRunLoopSourceRef;
  fn CFRunLoopGetCurrent() -> CFRunLoopRef;
  fn CFRunLoopAddSource(run_loop: CFRunLoopRef, source: CFRunLoopSourceRef, mode: *const c_void);
  fn CFRunLoopRun();
  fn CGEventGetFlags(event: CGEventRef) -> u64;
  fn CGEventGetIntegerValueField(event: CGEventRef, field: i32) -> i64;
}

fn run_state_thread(app: AppHandle, rx: Receiver<HotkeyMsg>, initial_shortcut: String) {
  let record_shortcut = Shortcut::parse(&initial_shortcut)
    .or_else(|| Shortcut::parse(DEFAULT_RECORD_SHORTCUT))
    .expect("default record shortcut must parse");
  let mut state = HotkeyState::new(record_shortcut);
  let mut trace = HoldTrace::default();

  loop {
    let timeout = state
      .next_deadline()
      .map(|deadline| deadline.saturating_duration_since(Instant::now()));
    let message = match timeout {
      Some(duration) => rx.recv_timeout(duration),
      None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
    };
    let now = Instant::now();

    match message {
      Ok(HotkeyMsg::KeyEvent(KeyEvent::Press(Key::Escape), _)) if !state.is_recording && is_input_prompt_visible(&app) => {
        dispatch_action(&app, Action::Cancel);
      }
      Ok(HotkeyMsg::KeyEvent(event, source_pid)) => {
        let was_held = state.combo_held();
        state.handle_event(event, now);
        if let Some(line) = trace.observe_key(&state, was_held, event, source_pid, now) {
          log::info!(target: "typealoud_lifecycle", "{line}");
        }
      }
      Ok(HotkeyMsg::UpdateShortcut(shortcut)) => {
        if let Some(parsed) = Shortcut::parse(&shortcut) {
          state.record_shortcut = parsed;
        }
      }
      Ok(HotkeyMsg::ReleaseLock(lock_id)) => state.release_lock(lock_id),
      Err(mpsc::RecvTimeoutError::Timeout) => {}
      Err(mpsc::RecvTimeoutError::Disconnected) => return,
    }

    state.handle_tick(now);
    for action in state.drain_actions() {
      if let Some(line) = trace.observe_action(action, now) {
        log::info!(target: "typealoud_lifecycle", "{line}");
      }
      dispatch_action(&app, action);
    }
  }
}

// A re-press this soon after a stop is logged: a keyboard that re-reports the
// held keys after a dropout shows up as a stop followed by a quick new start.
const REPRESS_TRACE_WINDOW: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy)]
struct ComboBreak {
  at: Instant,
  key: Key,
  source_pid: Option<i64>,
}

/// Diagnostics only, never behavior: records how each held recording ended so
/// the log can tell a real release from one the user did not make (a wireless
/// keyboard losing its link reports every key up; another process can post a
/// synthetic modifier change). Lines go to the lifecycle target, which release
/// builds keep.
#[derive(Debug, Default)]
struct HoldTrace {
  started_at: Option<Instant>,
  broken: Option<ComboBreak>,
  last_stop_at: Option<Instant>,
  locked: bool,
}

impl HoldTrace {
  fn observe_key(
    &mut self,
    state: &HotkeyState,
    was_held: bool,
    event: KeyEvent,
    source_pid: Option<i64>,
    now: Instant,
  ) -> Option<String> {
    // A locked recording is meant to run with the keys up.
    if !state.is_recording || state.lock.is_some() {
      return None;
    }
    let held = state.combo_held();
    match event {
      // Also when an extra modifier had already spoiled the exact match: the
      // combo key lifting after it is still what schedules the stop.
      KeyEvent::Release(key) if !held && self.broken.is_none() && key_label(key) != "other" => {
        self.broken = Some(ComboBreak { at: now, key, source_pid });
        None
      }
      KeyEvent::Press(key) if !was_held && held => {
        // Re-formed inside STOP_DEBOUNCE, so the recording kept going.
        let broken = self.broken.take()?;
        Some(format!(
          "hotkey combo-restored gap_ms={} release_key={} release_pid={} press_key={} press_pid={}",
          now.saturating_duration_since(broken.at).as_millis(),
          key_label(broken.key),
          pid_label(broken.source_pid),
          key_label(key),
          pid_label(source_pid),
        ))
      }
      _ => None,
    }
  }

  fn observe_action(&mut self, action: Action, now: Instant) -> Option<String> {
    match action {
      Action::Start => {
        self.started_at = Some(now);
        self.broken = None;
        self.locked = false;
        let since_stop = now.saturating_duration_since(self.last_stop_at.take()?);
        (since_stop < REPRESS_TRACE_WINDOW)
          .then(|| format!("hotkey repress since_stop_ms={}", since_stop.as_millis()))
      }
      Action::Stop => {
        let held_ms = self
          .started_at
          .take()
          .map_or(-1, |started| now.saturating_duration_since(started).as_millis() as i64);
        self.last_stop_at = Some(now);
        let locked = std::mem::take(&mut self.locked);
        let line = match self.broken.take() {
          Some(broken) => format!(
            "hotkey stop held_ms={held_ms} release_key={} release_pid={} debounce_ms={}",
            key_label(broken.key),
            pid_label(broken.source_pid),
            now.saturating_duration_since(broken.at).as_millis(),
          ),
          // A locked recording, ended by a press or its time limit.
          None if locked => format!("hotkey stop held_ms={held_ms} mode=locked"),
          None => format!("hotkey stop held_ms={held_ms} release_key=unobserved"),
        };
        Some(line)
      }
      Action::Lock(lock_id) => {
        self.locked = true;
        self.broken = None;
        Some(format!("hotkey lock id={lock_id}"))
      }
      Action::Cancel | Action::Tap => {
        self.started_at = None;
        self.broken = None;
        self.locked = false;
        None
      }
    }
  }
}

fn key_label(key: Key) -> &'static str {
  match key {
    Key::ControlLeft | Key::ControlRight => "ctrl",
    Key::ShiftLeft | Key::ShiftRight => "shift",
    Key::Alt | Key::AltGr => "alt",
    Key::MetaLeft | Key::MetaRight => "meta",
    _ => "other",
  }
}

fn pid_label(pid: Option<i64>) -> String {
  pid.map_or_else(|| "unknown".into(), |pid| pid.to_string())
}

fn is_input_prompt_visible(app: &AppHandle) -> bool {
  app
    .get_webview_window("input-prompt")
    .and_then(|window| window.is_visible().ok())
    .unwrap_or(false)
}

fn dispatch_action(app: &AppHandle, action: Action) {
  match action {
    Action::Start => {
      let startup_started = Instant::now();
      log::info!("hotkey:dispatch start");
      // No worker step here, and so no worker_ms below: Qwen worker ownership
      // begins in the frontend once this recording has a session id, and native
      // hotkey dispatch must not extend a previous session.
      let position_started = Instant::now();
      let mut show_elapsed = Duration::ZERO;
      if let Some(window) = app.get_webview_window("input-prompt") {
        if let Some(target) = position_input_prompt(&window) {
          wait_for_position(&window, target);
        }
        let show_started = Instant::now();
        let _ = window.show();
        show_elapsed = show_started.elapsed();
      }
      let position_elapsed = position_started.elapsed().saturating_sub(show_elapsed);
      let native_elapsed = startup_started.elapsed();
      let payload = RecordingStartEvent {
        dispatched_at_unix_ms: SystemTime::now()
          .duration_since(UNIX_EPOCH)
          .unwrap_or_default()
          .as_millis()
          .try_into()
          .unwrap_or(u64::MAX),
        native_ms: native_elapsed.as_millis().try_into().unwrap_or(u64::MAX),
      };
      let emit_started = Instant::now();
      let _ = app.emit("start-recording", payload);
      let emit_elapsed = emit_started.elapsed();
      let total_elapsed = startup_started.elapsed();
      if total_elapsed >= SLOW_NATIVE_STARTUP {
        log::warn!(
          "hotkey:startup-slow position_ms={} show_ms={} emit_ms={} total_ms={}",
          position_elapsed.as_millis(),
          show_elapsed.as_millis(),
          emit_elapsed.as_millis(),
          total_elapsed.as_millis()
        );
      } else {
        log::info!(
          "hotkey:startup-ready position_ms={} show_ms={} emit_ms={} total_ms={}",
          position_elapsed.as_millis(),
          show_elapsed.as_millis(),
          emit_elapsed.as_millis(),
          total_elapsed.as_millis()
        );
      }
    }
    Action::Stop => {
      log::info!("hotkey:dispatch stop");
      let _ = app.emit("stop-recording", ());
    }
    Action::Cancel => {
      log::info!("hotkey:dispatch cancel");
      let _ = app.emit("cancel-recording", ());
    }
    Action::Tap => {
      log::info!("hotkey:dispatch tap");
      let _ = app.emit("tap-recording", ());
    }
    Action::Lock(lock_id) => {
      log::info!("hotkey:dispatch lock id={lock_id}");
      let _ = app.emit("lock-recording", RecordingLockEvent { lock_id });
    }
  }
}

/// Gap between the prompt's bottom edge and the bottom of the screen, in
/// logical points — so it looks the same distance up on a 1x external display
/// and a 2x Retina one. (It used to be 100 *physical* pixels, which rendered as
/// half the gap on Retina.)
const PROMPT_BOTTOM_MARGIN: f64 = 100.0;

/// Fallback prompt size, used only if the window can't report its own — matches
/// the `input-prompt` dimensions in `tauri.conf.json`.
const PROMPT_FALLBACK_SIZE: (f64, f64) = (460.0, 244.0);

/// Upper bound on how long `wait_for_position` will hold the prompt back. Well
/// past the measured 0.4–4.9ms so it never trips in practice, but small enough
/// that a wedged move can't visibly delay the recording UI.
const POSITION_SETTLE_TIMEOUT: Duration = Duration::from_millis(60);

/// Puts the prompt bottom-center on the screen the user is actually working on.
///
/// ## Everything here is in logical points, deliberately
///
/// tao's macOS coordinate spaces disagree with each other, and mixing them
/// silently picks the wrong screen on any Retina + external-display setup:
///
/// * `monitor_from_point(x, y)` compares against `CGDisplayBounds` — **logical
///   points**, top-left origin.
/// * `Monitor::position()` / `size()` return **physical pixels** (logical x that
///   monitor's scale factor).
/// * `cursor_position()` returns logical points pre-multiplied by the
///   **primary** monitor's scale factor, whichever screen the pointer is on.
/// * `set_position` with a `PhysicalPosition` re-divides by the *window's*
///   current scale factor — which is still the old screen's while we're moving
///   it. A `LogicalPosition` passes through untouched, so we use that.
///
/// So: normalize every input to logical points, and set a logical position.
///
/// Windows is different (tao 0.34.8): `cursor_position()` and
/// `monitor_from_point` are both plain physical pixels, and a `LogicalPosition`
/// is converted with the window's *current* scale factor, so it lands in the
/// wrong place when the target screen has another one. There the origin is
/// scaled by the target monitor's own factor and set as a physical position.
/// That math is shared with macOS: the "logical" rect below is the monitor's
/// physical rect divided by its scale, so multiplying back by that same scale
/// is exact.
fn position_input_prompt(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
  let monitor = target_monitor(window)?;
  let monitor_scale = monitor.scale_factor();
  let screen = logical_rect(
    (monitor.position().x, monitor.position().y),
    (monitor.size().width, monitor.size().height),
    monitor_scale,
  )?;

  // The window's own size is physical at *its* current scale factor, which is
  // not necessarily the target monitor's.
  let window_scale = window.scale_factor().unwrap_or(monitor_scale);
  let prompt = window
    .outer_size()
    .ok()
    .filter(|_| window_scale > 0.0)
    .map(|size| {
      (
        size.width as f64 / window_scale,
        size.height as f64 / window_scale,
      )
    })
    .unwrap_or(PROMPT_FALLBACK_SIZE);

  move_prompt(window, prompt_origin(screen, prompt), monitor_scale)
}

/// Returns the logical target for `wait_for_position` to settle on.
#[cfg(not(target_os = "windows"))]
fn move_prompt(window: &tauri::WebviewWindow, origin: (f64, f64), _monitor_scale: f64) -> Option<(f64, f64)> {
  let _ = window.set_position(LogicalPosition::new(origin.0, origin.1));
  Some(origin)
}

/// Returns nothing to wait for: tao's Windows move is a synchronous
/// `SetWindowPos` on the main thread, queued ahead of the `show()` that follows.
#[cfg(target_os = "windows")]
fn move_prompt(window: &tauri::WebviewWindow, origin: (f64, f64), monitor_scale: f64) -> Option<(f64, f64)> {
  let (x, y) = physical_origin(origin, monitor_scale);
  let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
  None
}

/// A monitor-local logical origin back in that monitor's physical pixels.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn physical_origin(origin: (f64, f64), monitor_scale: f64) -> (i32, i32) {
  ((origin.0 * monitor_scale).round() as i32, (origin.1 * monitor_scale).round() as i32)
}

/// Blocks until the window has actually moved to `target`, so `show()` can't
/// flash it on the screen it is leaving.
///
/// macOS applies the move asynchronously — tao's `set_outer_position` ends in
/// `set_frame_top_left_point_async`, a `dispatch_async` onto the main queue —
/// so an immediate `show()` races it. Measured on a 3-screen desk: without this
/// the prompt appeared at the *previous* screen's coordinates and jumped, on
/// roughly 2 of 9 screen changes. Waiting is nearly free because the move
/// usually lands first: 0.4–4.9ms, 0–1 polls, and 0 polls whenever the prompt
/// is already on the right screen (the common case).
fn wait_for_position(window: &tauri::WebviewWindow, target: (f64, f64)) {
  let deadline = Instant::now() + POSITION_SETTLE_TIMEOUT;
  loop {
    // Treat "can't read the position" as settled — never hold the prompt back
    // over a failed query.
    let landed = window
      .outer_position()
      .ok()
      .zip(window.scale_factor().ok())
      .map(|(position, scale)| {
        (position.x as f64 / scale - target.0).abs() < 1.0
          && (position.y as f64 / scale - target.1).abs() < 1.0
      })
      .unwrap_or(true);
    if landed || Instant::now() >= deadline {
      return;
    }
    thread::sleep(Duration::from_millis(2));
  }
}

/// A rectangle in logical points, top-left origin — the space `CGDisplayBounds`
/// and `monitor_from_point` share.
#[derive(Debug, Clone, Copy, PartialEq)]
struct LogicalRect {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
}

/// `Monitor` reports physical pixels; divide through by its scale factor to get
/// back to logical points. On a 2x display that turns e.g. position (6880, 0) /
/// size 5120x2880 back into (3440, 0) / 2560x1440.
fn logical_rect(position: (i32, i32), size: (u32, u32), scale: f64) -> Option<LogicalRect> {
  if scale <= 0.0 {
    return None;
  }
  Some(LogicalRect {
    x: position.0 as f64 / scale,
    y: position.1 as f64 / scale,
    width: size.0 as f64 / scale,
    height: size.1 as f64 / scale,
  })
}

/// Bottom-center origin for a `prompt`-sized window on `screen`, all logical.
fn prompt_origin(screen: LogicalRect, prompt: (f64, f64)) -> (f64, f64) {
  (
    screen.x + (screen.width - prompt.0) / 2.0,
    screen.y + screen.height - prompt.1 - PROMPT_BOTTOM_MARGIN,
  )
}

/// Which screen the prompt belongs on, best answer first:
///
/// 1. the focused app's window — where the transcription is about to be
///    inserted, so it's the screen the user is looking at;
/// 2. the mouse pointer — a good proxy, and it always answers;
/// 3. the primary monitor — the old unconditional behavior, now only a last
///    resort.
fn target_monitor(window: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
  if let Some((x, y)) = crate::platform::focused_window_center() {
    if let Ok(Some(monitor)) = window.monitor_from_point(x, y) {
      log::info!("input-prompt: screen from focused window at ({x:.0}, {y:.0})");
      return Some(monitor);
    }
  }

  if let Some((x, y)) = cursor_point(window) {
    if let Ok(Some(monitor)) = window.monitor_from_point(x, y) {
      log::info!("input-prompt: screen from cursor at ({x:.0}, {y:.0})");
      return Some(monitor);
    }
  }

  log::warn!("input-prompt: no focused window or cursor screen — using the primary monitor");
  window.primary_monitor().ok().flatten()
}

/// `cursor_position()` hands back logical points already multiplied by the
/// *primary* monitor's scale factor, so undo that to get the plain logical
/// point `monitor_from_point` expects.
#[cfg(not(target_os = "windows"))]
fn cursor_point(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
  let cursor = window.cursor_position().ok()?;
  let primary_scale = window
    .primary_monitor()
    .ok()
    .flatten()
    .map(|monitor| monitor.scale_factor())
    .filter(|scale| *scale > 0.0)
    .unwrap_or(1.0);
  Some((cursor.x / primary_scale, cursor.y / primary_scale))
}

/// On Windows the cursor is already in physical pixels (`GetCursorPos`), the
/// same space `monitor_from_point` (`MonitorFromPoint`) takes.
#[cfg(target_os = "windows")]
fn cursor_point(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
  let cursor = window.cursor_position().ok()?;
  Some((cursor.x, cursor.y))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn fresh_state() -> HotkeyState {
    HotkeyState::new(Shortcut::parse(DEFAULT_RECORD_SHORTCUT).unwrap())
  }

  #[test]
  fn recording_start_event_uses_camel_case_wire_fields() {
    let event = RecordingStartEvent {
      dispatched_at_unix_ms: 1_000,
      native_ms: 80,
    };
    let wire = serde_json::to_value(event).unwrap();

    assert_eq!(wire["dispatchedAtUnixMs"], 1_000);
    assert_eq!(wire["nativeMs"], 80);
  }

  // The three displays below are a real, measured setup (mixed 1x/2x), captured
  // from CGDisplayBounds + NSScreen.backingScaleFactor:
  //
  //   DELL S3423DWC  bounds (0, 0) 3440x1440     scale 1  [main]
  //   DELL P2418D    bounds (3440, 0) 2560x1440  scale 2
  //   LS27R75        bounds (-2560, 0) 2560x1440 scale 2
  //
  // `Monitor` hands those back as *physical* pixels, which is what the inputs
  // here are. Getting the scale division wrong is silent and catastrophic: the
  // 2x screens would place the prompt at x≈9210 / x≈-4350, i.e. nowhere.
  // Mirrors PROMPT_FALLBACK_SIZE / the input-prompt window in tauri.conf.json;
  // only the height feeds the y assertions below (x is width-driven).
  const PROMPT_SIZE: (f64, f64) = (460.0, 244.0);

  // Windows, mixed DPI: primary 1920x1080 at 100%, a 4K screen at 150% to its
  // right. Setting the prompt's origin as a LogicalPosition while the window
  // still sits on the other screen converts it with the wrong factor; for the
  // primary target that put the prompt's top at y=1104, below a 1080-tall
  // screen. The physical origin is the same bottom-center point in the target
  // monitor's own pixels.
  #[test]
  fn windows_origin_is_scaled_by_the_target_monitor() {
    let four_k = logical_rect((1920, 0), (3840, 2160), 1.5).unwrap();
    let origin = prompt_origin(four_k, PROMPT_SIZE);
    assert_eq!(physical_origin(origin, 1.5), (1920 + (3840 - 690) / 2, 2160 - 366 - 150));

    let primary = logical_rect((0, 0), (1920, 1080), 1.0).unwrap();
    let origin = prompt_origin(primary, PROMPT_SIZE);
    assert_eq!(physical_origin(origin, 1.0), (730, 736));
    assert!(physical_origin(origin, 1.0).1 + 244 <= 1080);
  }

  #[test]
  fn one_x_screen_is_unchanged_by_the_scale_division() {
    let screen = logical_rect((0, 0), (3440, 1440), 1.0).unwrap();
    assert_eq!(
      screen,
      LogicalRect {
        x: 0.0,
        y: 0.0,
        width: 3440.0,
        height: 1440.0
      }
    );
    assert_eq!(prompt_origin(screen, PROMPT_SIZE), (1490.0, 1096.0));
  }

  #[test]
  fn two_x_screen_right_of_main_normalizes_to_logical_points() {
    // Physical position is the logical 3440 pre-multiplied by the scale factor.
    let screen = logical_rect((6880, 0), (5120, 2880), 2.0).unwrap();
    assert_eq!(
      screen,
      LogicalRect {
        x: 3440.0,
        y: 0.0,
        width: 2560.0,
        height: 1440.0
      }
    );
    assert_eq!(prompt_origin(screen, PROMPT_SIZE), (4490.0, 1096.0));
  }

  #[test]
  fn two_x_screen_left_of_main_keeps_its_negative_origin() {
    let screen = logical_rect((-5120, 0), (5120, 2880), 2.0).unwrap();
    assert_eq!(
      screen,
      LogicalRect {
        x: -2560.0,
        y: 0.0,
        width: 2560.0,
        height: 1440.0
      }
    );
    assert_eq!(prompt_origin(screen, PROMPT_SIZE), (-1510.0, 1096.0));
  }

  #[test]
  fn the_bottom_margin_is_the_same_logical_gap_on_every_screen() {
    // Same visual gap regardless of DPI — the old code used physical pixels, so
    // the 2x screens got half the gap.
    for (position, size, scale) in [
      ((0, 0), (3440u32, 1440u32), 1.0),
      ((6880, 0), (5120, 2880), 2.0),
    ] {
      let screen = logical_rect(position, size, scale).unwrap();
      let (_, y) = prompt_origin(screen, PROMPT_SIZE);
      let gap = screen.y + screen.height - (y + PROMPT_SIZE.1);
      assert_eq!(gap, PROMPT_BOTTOM_MARGIN);
    }
  }

  #[test]
  fn a_bogus_scale_factor_is_rejected_rather_than_dividing_by_zero() {
    assert!(logical_rect((0, 0), (3440, 1440), 0.0).is_none());
    assert!(logical_rect((0, 0), (3440, 1440), -1.0).is_none());
  }

  #[test]
  fn parse_shortcut_labels() {
    let shortcut = Shortcut::parse(" ctrl + shift ").unwrap();
    assert!(shortcut.ctrl);
    assert!(shortcut.shift);
    assert!(!shortcut.alt);
    assert!(!shortcut.meta);
    assert!(Shortcut::parse("Ctrl").is_none());
  }

  #[test]
  fn modifier_state_matches_exact_shortcut() {
    let shortcut = Shortcut::parse("Ctrl+Shift").unwrap();
    let mut modifiers = ModifierState::default();
    modifiers.press(Key::ControlLeft);
    modifiers.press(Key::ShiftLeft);
    assert!(modifiers.matches(&shortcut));
    modifiers.press(Key::Alt);
    assert!(!modifiers.matches(&shortcut));
  }

  #[test]
  fn start_emits_immediately_on_combo() {
    let mut state = fresh_state();
    let start = Instant::now();
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start);
    // No debounce/tick: recording starts the instant the combo is down.
    assert_eq!(state.drain_actions(), vec![Action::Start]);
  }

  #[test]
  fn long_press_release_emits_stop() {
    let mut state = fresh_state();
    let start = Instant::now();
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start);
    let _ = state.drain_actions();
    let release_at = start + CANCEL_THRESHOLD + Duration::from_millis(100);
    state.handle_event(KeyEvent::Release(Key::ShiftLeft), release_at);
    state.handle_tick(release_at + STOP_DEBOUNCE + Duration::from_millis(1));
    assert_eq!(state.drain_actions(), vec![Action::Stop]);
  }

  fn ms(value: u64) -> Duration {
    Duration::from_millis(value)
  }

  fn press_combo(state: &mut HotkeyState, at: Instant) {
    state.handle_event(KeyEvent::Press(Key::ControlLeft), at);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), at);
  }

  fn release_combo(state: &mut HotkeyState, at: Instant) {
    state.handle_event(KeyEvent::Release(Key::ShiftLeft), at);
    state.handle_event(KeyEvent::Release(Key::ControlLeft), at);
  }

  /// Start, a 100 ms tap, then a second press 150 ms later: locked.
  fn locked_state(start: Instant) -> HotkeyState {
    let mut state = fresh_state();
    press_combo(&mut state, start);
    release_combo(&mut state, start + ms(100));
    press_combo(&mut state, start + ms(250));
    release_combo(&mut state, start + ms(330));
    assert_eq!(state.drain_actions(), vec![Action::Start, Action::Lock(1)]);
    state
  }

  #[test]
  fn short_press_becomes_a_tap_once_no_second_press_follows() {
    let mut state = fresh_state();
    let start = Instant::now();
    press_combo(&mut state, start);
    let _ = state.drain_actions();
    // Released well under the threshold → never transcribed, but not decided
    // until the double-tap window has passed.
    release_combo(&mut state, start + ms(100));
    assert_eq!(state.next_deadline(), Some(start + ms(100) + DOUBLE_TAP_WINDOW));
    state.handle_tick(start + ms(100) + DOUBLE_TAP_WINDOW - ms(1));
    assert_eq!(state.drain_actions(), vec![]);
    state.handle_tick(start + ms(100) + DOUBLE_TAP_WINDOW);
    assert_eq!(state.drain_actions(), vec![Action::Tap]);
    assert_eq!(state.next_deadline(), None);
  }

  #[test]
  fn a_key_typed_after_a_tap_cancels_instead_of_tapping() {
    let mut state = fresh_state();
    let start = Instant::now();
    press_combo(&mut state, start);
    release_combo(&mut state, start + ms(100));
    // Past probation, but still inside the double-tap window.
    state.handle_event(KeyEvent::NonModifierPress, start + ms(420));
    state.handle_tick(start + ms(1000));
    assert_eq!(state.drain_actions(), vec![Action::Start, Action::Cancel]);
  }

  #[test]
  fn double_tap_locks_and_the_next_press_stops() {
    let start = Instant::now();
    let mut state = locked_state(start);
    // Neither the release of the locking press nor time stops a lock.
    state.handle_tick(start + ms(5000));
    assert_eq!(state.drain_actions(), vec![]);
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start + ms(6000));
    assert_eq!(state.drain_actions(), vec![]);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start + ms(6010));
    assert_eq!(state.drain_actions(), vec![Action::Stop]);
    // The stop press's own release and the next press behave as from idle.
    release_combo(&mut state, start + ms(6100));
    assert_eq!(state.drain_actions(), vec![]);
    press_combo(&mut state, start + ms(7000));
    assert_eq!(state.drain_actions(), vec![Action::Start]);
  }

  #[test]
  fn each_lock_gets_a_new_id() {
    let start = Instant::now();
    let mut state = locked_state(start);
    press_combo(&mut state, start + ms(1000));
    release_combo(&mut state, start + ms(1050));
    press_combo(&mut state, start + ms(2000));
    release_combo(&mut state, start + ms(2100));
    press_combo(&mut state, start + ms(2250));
    assert_eq!(state.drain_actions(), vec![Action::Stop, Action::Start, Action::Lock(2)]);
  }

  #[test]
  fn a_locked_recording_ignores_typing_but_not_escape() {
    let start = Instant::now();
    let mut state = locked_state(start);
    state.handle_event(KeyEvent::NonModifierPress, start + ms(400));
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start + ms(500));
    state.handle_event(KeyEvent::Release(Key::ControlLeft), start + ms(550));
    assert_eq!(state.drain_actions(), vec![]);
    state.handle_event(KeyEvent::Press(Key::Escape), start + ms(900));
    assert_eq!(state.drain_actions(), vec![Action::Cancel]);
  }

  #[test]
  fn a_stagger_inside_the_locking_press_does_not_stop_it() {
    let mut state = fresh_state();
    let start = Instant::now();
    press_combo(&mut state, start);
    release_combo(&mut state, start + ms(100));
    press_combo(&mut state, start + ms(250));
    // Shift bounces while Ctrl is still down.
    state.handle_event(KeyEvent::Release(Key::ShiftLeft), start + ms(280));
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start + ms(290));
    release_combo(&mut state, start + ms(330));
    assert_eq!(state.drain_actions(), vec![Action::Start, Action::Lock(1)]);
  }

  #[test]
  fn a_key_bouncing_back_after_a_tap_is_not_a_second_press() {
    let mut state = fresh_state();
    let start = Instant::now();
    press_combo(&mut state, start);
    // Shift comes up and goes down again while Ctrl never lifts.
    state.handle_event(KeyEvent::Release(Key::ShiftLeft), start + ms(100));
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start + ms(150));
    state.handle_tick(start + ms(700));
    assert_eq!(state.drain_actions(), vec![Action::Start], "no lock and no tap: still recording");
    let release_at = start + ms(3000);
    release_combo(&mut state, release_at);
    state.handle_tick(release_at + STOP_DEBOUNCE);
    assert_eq!(state.drain_actions(), vec![Action::Stop]);
  }

  #[test]
  fn a_locked_recording_stops_itself_at_the_time_limit() {
    let start = Instant::now();
    let mut state = locked_state(start);
    let limit = start + ms(250) + LOCKED_MAX;
    assert_eq!(state.next_deadline(), Some(limit));
    state.handle_tick(limit - ms(1));
    assert_eq!(state.drain_actions(), vec![]);
    state.handle_tick(limit);
    assert_eq!(state.drain_actions(), vec![Action::Stop]);
    press_combo(&mut state, limit + ms(1000));
    assert_eq!(state.drain_actions(), vec![Action::Start]);
  }

  #[test]
  fn tap_then_hold_is_an_ordinary_dictation() {
    let mut state = fresh_state();
    let start = Instant::now();
    press_combo(&mut state, start);
    release_combo(&mut state, start + ms(100));
    press_combo(&mut state, start + ms(250));
    // Held well past the threshold: the user is talking, so release stops.
    let release_at = start + ms(250) + CANCEL_THRESHOLD + ms(2000);
    release_combo(&mut state, release_at);
    state.handle_tick(release_at + STOP_DEBOUNCE);
    assert_eq!(state.drain_actions(), vec![Action::Start, Action::Lock(1), Action::Stop]);
  }

  #[test]
  fn a_quick_repress_after_speaking_keeps_recording_without_locking() {
    let mut state = fresh_state();
    let start = Instant::now();
    press_combo(&mut state, start);
    let release_at = start + CANCEL_THRESHOLD + ms(1000);
    release_combo(&mut state, release_at);
    // Re-pressed inside STOP_DEBOUNCE: the existing slip tolerance, no lock.
    press_combo(&mut state, release_at + ms(100));
    state.handle_tick(release_at + ms(400));
    assert_eq!(state.drain_actions(), vec![Action::Start]);
    release_combo(&mut state, release_at + ms(3000));
    state.handle_tick(release_at + ms(3000) + STOP_DEBOUNCE);
    assert_eq!(state.drain_actions(), vec![Action::Stop]);
  }

  #[test]
  fn the_frontend_can_release_only_the_lock_it_owns() {
    let start = Instant::now();
    let mut state = locked_state(start);
    state.release_lock(7);
    press_combo(&mut state, start + ms(1000));
    assert_eq!(state.drain_actions(), vec![Action::Stop], "a stale id must not end the lock");

    let mut state = locked_state(start);
    state.release_lock(1);
    assert_eq!(state.drain_actions(), vec![]);
    assert_eq!(state.next_deadline(), None);
    press_combo(&mut state, start + ms(1000));
    assert_eq!(state.drain_actions(), vec![Action::Start], "after release the next press starts");
  }

  #[test]
  fn lock_event_uses_camel_case_wire_fields() {
    let value = serde_json::to_value(RecordingLockEvent { lock_id: 3 }).unwrap();
    assert_eq!(value, serde_json::json!({ "lockId": 3 }));
  }

  #[test]
  fn combo_key_during_probation_cancels() {
    let mut state = fresh_state();
    let start = Instant::now();
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start);
    let _ = state.drain_actions();
    // Ctrl+Shift+<key> → user meant a shortcut; discard the recording.
    state.handle_event(KeyEvent::NonModifierPress, start + Duration::from_millis(20));
    assert_eq!(state.drain_actions(), vec![Action::Cancel]);
  }

  #[test]
  fn escape_cancels_recording() {
    let mut state = fresh_state();
    let start = Instant::now();
    state.handle_event(KeyEvent::Press(Key::ControlLeft), start);
    state.handle_event(KeyEvent::Press(Key::ShiftLeft), start);
    let _ = state.drain_actions();
    state.handle_event(KeyEvent::Press(Key::Escape), start + Duration::from_millis(400));
    assert_eq!(state.drain_actions(), vec![Action::Cancel]);
  }

  /// Feeds one key event through the state machine and the trace, like the
  /// state thread does, and returns the trace lines it produced.
  fn traced(
    state: &mut HotkeyState,
    trace: &mut HoldTrace,
    event: KeyEvent,
    pid: i64,
    at: Instant,
  ) -> Vec<String> {
    let was_held = state.combo_held();
    state.handle_event(event, at);
    let mut lines: Vec<String> = trace.observe_key(state, was_held, event, Some(pid), at).into_iter().collect();
    state.handle_tick(at);
    for action in state.drain_actions() {
      lines.extend(trace.observe_action(action, at));
    }
    lines
  }

  #[test]
  fn trace_names_the_key_and_process_that_ended_a_hold() {
    let (mut state, mut trace) = (fresh_state(), HoldTrace::default());
    let start = Instant::now();
    traced(&mut state, &mut trace, KeyEvent::Press(Key::ControlLeft), 0, start);
    traced(&mut state, &mut trace, KeyEvent::Press(Key::ShiftLeft), 0, start);
    let release = start + ms(40_000);
    assert!(traced(&mut state, &mut trace, KeyEvent::Release(Key::ShiftLeft), 0, release).is_empty());
    state.handle_tick(release + STOP_DEBOUNCE);
    let lines: Vec<String> =
      state.drain_actions().into_iter().filter_map(|action| trace.observe_action(action, release + STOP_DEBOUNCE)).collect();
    assert_eq!(lines, vec!["hotkey stop held_ms=40250 release_key=shift release_pid=0 debounce_ms=250"]);

    // A new press shortly after is the keyboard or the user pressing again.
    let again = release + ms(1500);
    let lines = traced(&mut state, &mut trace, KeyEvent::Press(Key::ShiftLeft), 0, again);
    assert_eq!(lines, vec!["hotkey repress since_stop_ms=1250"]);
  }

  #[test]
  fn trace_reports_a_dropout_the_debounce_absorbed() {
    let (mut state, mut trace) = (fresh_state(), HoldTrace::default());
    let start = Instant::now();
    press_combo(&mut state, start);
    let _ = state.drain_actions();
    trace.observe_action(Action::Start, start);
    let drop = start + ms(20_000);
    traced(&mut state, &mut trace, KeyEvent::Release(Key::ControlLeft), 812, drop);
    let lines = traced(&mut state, &mut trace, KeyEvent::Press(Key::ControlLeft), 0, drop + ms(90));
    assert_eq!(
      lines,
      vec!["hotkey combo-restored gap_ms=90 release_key=ctrl release_pid=812 press_key=ctrl press_pid=0"]
    );
    assert!(state.is_recording);
  }

  #[test]
  fn trace_names_the_combo_key_lifted_after_an_extra_modifier() {
    let (mut state, mut trace) = (fresh_state(), HoldTrace::default());
    let start = Instant::now();
    traced(&mut state, &mut trace, KeyEvent::Press(Key::ControlLeft), 0, start);
    traced(&mut state, &mut trace, KeyEvent::Press(Key::ShiftLeft), 0, start);
    traced(&mut state, &mut trace, KeyEvent::Press(Key::MetaLeft), 0, start + ms(3000));
    traced(&mut state, &mut trace, KeyEvent::Release(Key::ControlLeft), 0, start + ms(4000));
    let lines = traced(&mut state, &mut trace, KeyEvent::Release(Key::MetaLeft), 0, start + ms(4300));
    assert_eq!(lines, vec!["hotkey stop held_ms=4300 release_key=ctrl release_pid=0 debounce_ms=300"]);
  }

  #[test]
  fn trace_labels_a_locked_recording_stop() {
    let (mut state, mut trace) = (fresh_state(), HoldTrace::default());
    let start = Instant::now();
    press_combo(&mut state, start);
    release_combo(&mut state, start + ms(100));
    press_combo(&mut state, start + ms(250));
    release_combo(&mut state, start + ms(330));
    let lines: Vec<String> =
      state.drain_actions().into_iter().filter_map(|action| trace.observe_action(action, start)).collect();
    assert_eq!(lines, vec!["hotkey lock id=1"]);
    press_combo(&mut state, start + ms(9000));
    let lines: Vec<String> =
      state.drain_actions().into_iter().filter_map(|action| trace.observe_action(action, start + ms(9000))).collect();
    assert_eq!(lines, vec!["hotkey stop held_ms=9000 mode=locked"]);
  }

  #[test]
  fn trace_ignores_the_keys_lifting_during_a_locked_recording() {
    let (mut state, mut trace) = (locked_state(Instant::now()), HoldTrace::default());
    let later = Instant::now() + ms(5000);
    assert!(traced(&mut state, &mut trace, KeyEvent::Release(Key::ShiftLeft), 0, later).is_empty());
    assert!(trace.broken.is_none());
  }
}
