//! Development-only archive of dictation audio, for offline tests of chunking
//! and decoding on the maintainer's real speech. Off unless config.json sets
//! `"debugSaveAudio": true`, and ignored in official builds whatever the config
//! says: the app's promise is that audio is decoded and discarded (PRIVACY.md).
//!
//! Each clip that reaches `transcribe_audio` is written as sent, before decoding,
//! to `debug-dictations/<launch>-s<session>-c<chunk>.<ext>`. The chunks of one
//! dictation concatenate back into the recording, and their boundaries are the
//! cuts the app made. Files older than `RETENTION` are pruned on every save.

use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

const DIR_NAME: &str = "debug-dictations";
const RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub fn enabled(config_flag: bool) -> bool {
  config_flag && env!("TYPEALOUD_BUILD_CHANNEL") != "official"
}

/// Session ids restart at every launch, so a launch stamp keeps names unique.
fn launch_stamp() -> &'static str {
  static STAMP: OnceLock<String> = OnceLock::new();
  STAMP.get_or_init(|| chrono::Local::now().format("%Y%m%d-%H%M%S").to_string())
}

fn extension_for(mime: &str) -> &'static str {
  match mime.split(';').next().unwrap_or("").trim() {
    "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
    "audio/mp4" | "audio/m4a" | "audio/x-m4a" => "m4a",
    "audio/ogg" => "ogg",
    _ => "webm",
  }
}

fn file_name(session_id: Option<u64>, chunk_index: Option<u32>, mime: &str) -> String {
  let session = session_id.map_or_else(|| "none".to_owned(), |id| format!("{id:04}"));
  let chunk = chunk_index.map_or_else(|| "whole".to_owned(), |index| format!("{index:02}"));
  format!("{}-s{session}-c{chunk}.{}", launch_stamp(), extension_for(mime))
}

fn prune(dir: &Path, now: SystemTime) {
  let Ok(entries) = fs::read_dir(dir) else { return };
  for entry in entries.flatten() {
    let expired = entry.metadata().ok()
      .and_then(|meta| meta.modified().ok())
      .and_then(|modified| now.duration_since(modified).ok())
      .is_some_and(|age| age > RETENTION);
    if expired {
      let _ = fs::remove_file(entry.path());
    }
  }
}

pub fn save_in(dir: &Path, session_id: Option<u64>, chunk_index: Option<u32>, bytes: &[u8], mime: &str)
  -> std::io::Result<()> {
  fs::create_dir_all(dir)?;
  prune(dir, SystemTime::now());
  fs::write(dir.join(file_name(session_id, chunk_index, mime)), bytes)
}

/// Best effort and off the IPC path: a failed write only costs the archive copy.
pub fn save(session_id: Option<u64>, chunk_index: Option<u32>, bytes: Vec<u8>, mime: String) {
  tauri::async_runtime::spawn_blocking(move || {
    let result = crate::settings::app_data_dir()
      .map_err(|error| std::io::Error::other(format!("{error:#}")))
      .and_then(|base| save_in(&base.join(DIR_NAME), session_id, chunk_index, &bytes, &mime));
    if let Err(error) = result {
      log::warn!("recording-archive: save failed: {error}");
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_group_chunks_of_one_dictation() {
    let first = file_name(Some(7), Some(0), "audio/wav");
    let second = file_name(Some(7), Some(1), "audio/wav");
    assert!(first.ends_with("-s0007-c00.wav"), "{first}");
    assert!(second.ends_with("-s0007-c01.wav"), "{second}");
    assert_eq!(first[..15], second[..15], "same launch stamp");
    assert!(file_name(None, None, "audio/webm;codecs=opus").ends_with("-snone-cwhole.webm"));
  }

  #[test]
  fn save_writes_the_clip_and_prunes_only_expired_files() {
    let dir = tempfile::tempdir().unwrap();
    let old = dir.path().join("old.wav");
    let fresh = dir.path().join("fresh.wav");
    fs::write(&old, b"old").unwrap();
    fs::write(&fresh, b"fresh").unwrap();
    let eight_days_ago = SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60);
    fs::File::options().write(true).open(&old).unwrap().set_modified(eight_days_ago).unwrap();

    save_in(dir.path(), Some(3), Some(2), b"RIFF", "audio/wav").unwrap();

    assert!(!old.exists(), "a file past retention is pruned");
    assert!(fresh.exists(), "a recent file is kept");
    let saved = dir.path().join(file_name(Some(3), Some(2), "audio/wav"));
    assert_eq!(fs::read(saved).unwrap(), b"RIFF");
  }

  #[test]
  fn requires_the_config_flag() {
    assert!(!enabled(false));
  }
}
