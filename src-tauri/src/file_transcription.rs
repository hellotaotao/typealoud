//! Transcribing an audio or video file the user drops on the Files page.
//!
//! The file is decoded and resampled to 16 kHz mono PCM16 once, split at pauses
//! into segments of at most `MAX_SEGMENT_SECS`, and each segment goes to the
//! engine as its own WAV. Short segments keep every Qwen decode at ctx 2048 (so
//! one worker serves the whole file) and bound how long a dictation waits for
//! the single local inference slot: dictation never queues behind a whole file,
//! only behind the segment being decoded.
//!
//! Results live in `file-transcripts.json`, apart from History: a long file
//! would otherwise push dictations out of History's 200-row cap. Only the file
//! name is stored, never its path, and the audio itself is never kept.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

pub const SAMPLE_RATE: usize = 16_000;
const FRAME: usize = 320; // 20 ms at 16 kHz
const FRAMES_PER_SEC: usize = SAMPLE_RATE / FRAME;
const MAX_SEGMENT_SECS: usize = 40;
const MIN_SEGMENT_SECS: usize = 15;
// A silence this long ends a segment. Qwen settles on one language per
// decode: measured 2026-11-10, Chinese then a 2 s pause then English came back
// with the English dropped (7 of 8 decodes) or translated into Chinese, while
// the same speech without the pause, or a pause without the language change,
// transcribed fully. Cutting at long pauses keeps each decode to one stretch
// of speech.
const PAUSE_FRAMES: usize = FRAMES_PER_SEC; // 1 s
// ...but never before this much of the segment has gone by, so a short
// interjection is not decoded on its own.
const MIN_UTTERANCE_FRAMES: usize = 3 * FRAMES_PER_SEC;
// Cut points are chosen on energy averaged over ~300 ms, so a cut lands in a
// pause rather than in the gap between two syllables.
const SMOOTH_FRAMES: usize = 15;
// Speech-trimmed segments keep this much audio on each side.
const PAD_FRAMES: usize = 10;
// A segment needs at least this much audio above the speech threshold to be
// sent at all; silence only invites the model to invent text.
const MIN_SPEECH_FRAMES: usize = 5;
const MAX_DURATION_SECS: usize = 4 * 3600;
const HISTORY_CAP: usize = 100;
const STORE_FILE: &str = "file-transcripts.json";
pub const EVENT: &str = "file-transcript-updated";

/// Error codes shown to the user (translated in i18n.js under `files.error`).
pub const FILE_UNREADABLE: &str = "FILE_UNREADABLE";
pub const FILE_UNSUPPORTED: &str = "FILE_UNSUPPORTED";
pub const FILE_NO_AUDIO: &str = "FILE_NO_AUDIO";
pub const FILE_TOO_LONG: &str = "FILE_TOO_LONG";
pub const FILE_NO_SPEECH: &str = "FILE_NO_SPEECH";
pub const FILE_INTERRUPTED: &str = "FILE_INTERRUPTED";
pub const FILE_ENGINE_FAILED: &str = "FILE_ENGINE_FAILED";

/// Extensions offered in the file picker and accepted from a drop. The decoder
/// probes the content, so this is a filter for obvious non-media, not a promise.
pub const MEDIA_EXTENSIONS: &[&str] = &[
  "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "aif", "aiff", "caf", "mp4", "m4v", "mov",
  "mkv", "webm",
];

pub fn is_media_path(path: &Path) -> bool {
  path
    .extension()
    .and_then(|ext| ext.to_str())
    .is_some_and(|ext| MEDIA_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

// ---------------------------------------------------------------------------
// Decoding

/// Decode the first audio track of `path` to 16 kHz mono PCM16.
pub fn decode_to_16k(path: &Path, cancel: &CancellationToken) -> Result<Vec<i16>> {
  use symphonia::core::audio::SampleBuffer;
  use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
  use symphonia::core::errors::Error as DecodeError;
  use symphonia::core::formats::FormatOptions;
  use symphonia::core::io::MediaSourceStream;
  use symphonia::core::meta::MetadataOptions;
  use symphonia::core::probe::Hint;

  let file = std::fs::File::open(path).map_err(|_| anyhow!(FILE_UNREADABLE))?;
  let source = MediaSourceStream::new(Box::new(file), Default::default());
  let mut hint = Hint::new();
  if let Some(ext) = path.extension().and_then(|ext| ext.to_str()) {
    hint.with_extension(ext);
  }
  let probed = symphonia::default::get_probe()
    .format(&hint, source, &FormatOptions::default(), &MetadataOptions::default())
    .map_err(|_| anyhow!(FILE_UNSUPPORTED))?;
  let mut format = probed.format;
  let track = format
    .tracks()
    .iter()
    .find(|track| track.codec_params.codec != CODEC_TYPE_NULL && track.codec_params.sample_rate.is_some())
    .ok_or_else(|| anyhow!(FILE_NO_AUDIO))?;
  let track_id = track.id;
  let input_rate = track.codec_params.sample_rate.unwrap_or(SAMPLE_RATE as u32) as usize;
  let mut decoder = symphonia::default::get_codecs()
    .make(&track.codec_params, &DecoderOptions::default())
    .map_err(|_| anyhow!(FILE_UNSUPPORTED))?;

  let mut resampler = MonoResampler::new(input_rate)?;
  let mut output = Vec::new();
  let mut buffer: Option<SampleBuffer<f32>> = None;
  let mut mono = Vec::new();
  let mut frames_in = 0usize;
  let max_frames_in = input_rate * MAX_DURATION_SECS;
  loop {
    if cancel.is_cancelled() {
      bail!("TRANSCRIPTION_CANCELLED");
    }
    let packet = match format.next_packet() {
      Ok(packet) => packet,
      Err(DecodeError::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
      Err(DecodeError::ResetRequired) => break,
      Err(error) => {
        // A truncated tail still leaves everything before it usable.
        if output.is_empty() {
          return Err(anyhow!(FILE_UNREADABLE)).context(error.to_string());
        }
        log::warn!("file-transcription: stopped reading at a damaged packet: {error}");
        break;
      }
    };
    if packet.track_id() != track_id {
      continue;
    }
    let decoded = match decoder.decode(&packet) {
      Ok(decoded) => decoded,
      // One corrupt packet costs a few milliseconds of audio, not the file.
      Err(DecodeError::DecodeError(_)) | Err(DecodeError::IoError(_)) => continue,
      Err(_) => return Err(anyhow!(FILE_UNSUPPORTED)),
    };
    let spec = *decoded.spec();
    let channels = spec.channels.count().max(1);
    let needed = decoded.capacity() as u64;
    if buffer.as_ref().is_none_or(|buffer| (buffer.capacity() as u64) < needed * channels as u64) {
      buffer = Some(SampleBuffer::new(needed, spec));
    }
    let buffer = buffer.as_mut().expect("sample buffer was just created");
    buffer.copy_interleaved_ref(decoded);
    mono.clear();
    mono.extend(
      buffer
        .samples()
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32),
    );
    frames_in += mono.len();
    if frames_in > max_frames_in {
      bail!(FILE_TOO_LONG);
    }
    resampler.push(&mono, &mut output)?;
  }
  resampler.finish(&mut output)?;
  if output.is_empty() {
    bail!(FILE_NO_AUDIO);
  }
  Ok(output)
}

struct MonoResampler {
  inner: Option<rubato::FftFixedIn<f32>>,
  pending: Vec<f32>,
  // The FFT resampler delays its output; dropping that many leading samples
  // keeps segment timestamps aligned with the file.
  skip: usize,
  expected: usize,
  produced: usize,
  input_rate: usize,
}

impl MonoResampler {
  fn new(input_rate: usize) -> Result<Self> {
    if input_rate == 0 {
      bail!(FILE_UNSUPPORTED);
    }
    let inner = if input_rate == SAMPLE_RATE {
      None
    } else {
      Some(
        rubato::FftFixedIn::<f32>::new(input_rate, SAMPLE_RATE, 1024, 2, 1)
          .map_err(|error| anyhow!("resampler: {error}"))?,
      )
    };
    let skip = inner.as_ref().map_or(0, rubato::Resampler::output_delay);
    Ok(Self { inner, pending: Vec::new(), skip, expected: 0, produced: 0, input_rate })
  }

  fn push(&mut self, input: &[f32], output: &mut Vec<i16>) -> Result<()> {
    use rubato::Resampler;
    self.expected += input.len();
    let Some(inner) = self.inner.as_mut() else {
      output.extend(input.iter().map(|sample| to_i16(*sample)));
      return Ok(());
    };
    self.pending.extend_from_slice(input);
    let mut start = 0;
    while self.pending.len() - start >= inner.input_frames_next() {
      let take = inner.input_frames_next();
      let chunk = &self.pending[start..start + take];
      let resampled = inner.process(&[chunk], None).map_err(|error| anyhow!("resampler: {error}"))?;
      start += take;
      Self::emit(&mut self.skip, &mut self.produced, &resampled[0], output);
    }
    self.pending.drain(..start);
    Ok(())
  }

  fn finish(&mut self, output: &mut Vec<i16>) -> Result<()> {
    use rubato::Resampler;
    let Some(inner) = self.inner.as_mut() else { return Ok(()) };
    let wanted = self.expected * SAMPLE_RATE / self.input_rate;
    if !self.pending.is_empty() {
      let tail = std::mem::take(&mut self.pending);
      let resampled = inner
        .process_partial(Some(&[tail.as_slice()]), None)
        .map_err(|error| anyhow!("resampler: {error}"))?;
      Self::emit(&mut self.skip, &mut self.produced, &resampled[0], output);
    }
    // Flush the delay line until the output covers the whole input.
    while self.produced < wanted {
      let resampled = inner
        .process_partial::<&[f32]>(None, None)
        .map_err(|error| anyhow!("resampler: {error}"))?;
      if resampled[0].is_empty() {
        break;
      }
      Self::emit(&mut self.skip, &mut self.produced, &resampled[0], output);
    }
    let excess = self.produced.saturating_sub(wanted);
    output.truncate(output.len().saturating_sub(excess));
    Ok(())
  }

  fn emit(skip: &mut usize, produced: &mut usize, samples: &[f32], output: &mut Vec<i16>) {
    let dropped = (*skip).min(samples.len());
    *skip -= dropped;
    let kept = &samples[dropped..];
    *produced += kept.len();
    output.extend(kept.iter().map(|sample| to_i16(*sample)));
  }
}

fn to_i16(sample: f32) -> i16 {
  (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

// ---------------------------------------------------------------------------
// Segmenting

/// A stretch of the decoded audio to transcribe, in samples, with silence at
/// both ends already trimmed off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
  pub start: usize,
  pub end: usize,
}

impl Segment {
  pub fn start_secs(self) -> f64 {
    self.start as f64 / SAMPLE_RATE as f64
  }
  pub fn end_secs(self) -> f64 {
    self.end as f64 / SAMPLE_RATE as f64
  }
}

fn frame_levels(samples: &[i16]) -> Vec<f32> {
  samples
    .chunks(FRAME)
    .map(|frame| {
      let energy: f64 = frame.iter().map(|sample| (*sample as f64).powi(2)).sum();
      (energy / frame.len() as f64).sqrt() as f32
    })
    .collect()
}

/// Speech threshold: 10 dB above the file's noise floor (its 10th-percentile
/// frame level), never below -55 dBFS so near-digital silence never counts,
/// and never above -40 dBFS. The cap matters when there is little silence to
/// measure (nonstop speech, a music bed): anything that loud is sent to the
/// engine, because dropping real speech loses it for good while sending a
/// noisy stretch costs only a decode.
fn speech_threshold(levels: &[f32]) -> f32 {
  let floor = if levels.is_empty() {
    0.0
  } else {
    let mut sorted = levels.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    sorted[sorted.len() / 10]
  };
  let dbfs = |db: f32| i16::MAX as f32 * 10f32.powf(db / 20.0);
  (floor * 10f32.powf(10.0 / 20.0)).clamp(dbfs(-55.0), dbfs(-40.0))
}

pub fn plan_segments(samples: &[i16]) -> Vec<Segment> {
  let levels = frame_levels(samples);
  let threshold = speech_threshold(&levels);
  let smoothed: Vec<f32> = (0..levels.len())
    .map(|index| {
      let from = index.saturating_sub(SMOOTH_FRAMES / 2);
      let to = (index + SMOOTH_FRAMES / 2 + 1).min(levels.len());
      levels[from..to].iter().sum::<f32>() / (to - from) as f32
    })
    .collect();

  // Long pauses as (first silent frame, length).
  let mut pauses = Vec::new();
  let mut run_start = None;
  for (index, level) in levels.iter().enumerate() {
    match (*level <= threshold, run_start) {
      (true, None) => run_start = Some(index),
      (false, Some(start)) => {
        if index - start >= PAUSE_FRAMES {
          pauses.push((start, index - start));
        }
        run_start = None;
      }
      _ => {}
    }
  }

  let max_frames = MAX_SEGMENT_SECS * FRAMES_PER_SEC;
  let min_frames = MIN_SEGMENT_SECS * FRAMES_PER_SEC;
  let mut cuts = vec![0usize];
  let mut position = 0;
  loop {
    let pause_cut = pauses
      .iter()
      .find(|(start, _)| *start >= position + MIN_UTTERANCE_FRAMES && *start < position + max_frames)
      .map(|(start, length)| (start + length / 2).min(position + max_frames));
    let cut = match pause_cut {
      Some(cut) => cut,
      None if levels.len() - position > max_frames => ((position + min_frames)..(position + max_frames))
        .min_by(|a, b| smoothed[*a].total_cmp(&smoothed[*b]))
        .expect("segment window is never empty"),
      None => break,
    };
    cuts.push(cut);
    position = cut;
  }
  cuts.push(levels.len());
  cuts.dedup();

  cuts
    .windows(2)
    .filter_map(|pair| {
      let (from, to) = (pair[0], pair[1]);
      let speech: Vec<usize> = (from..to).filter(|index| levels[*index] > threshold).collect();
      if speech.len() < MIN_SPEECH_FRAMES {
        return None;
      }
      let first = speech[0].saturating_sub(PAD_FRAMES).max(from);
      let last = (speech[speech.len() - 1] + 1 + PAD_FRAMES).min(to);
      Some(Segment { start: first * FRAME, end: (last * FRAME).min(samples.len()) })
    })
    .collect()
}

pub fn wav_bytes(samples: &[i16]) -> Vec<u8> {
  let data_len = (samples.len() * 2) as u32;
  let mut wav = Vec::with_capacity(44 + samples.len() * 2);
  wav.extend_from_slice(b"RIFF");
  wav.extend_from_slice(&(36 + data_len).to_le_bytes());
  wav.extend_from_slice(b"WAVEfmt ");
  wav.extend_from_slice(&16u32.to_le_bytes());
  wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
  wav.extend_from_slice(&1u16.to_le_bytes()); // mono
  wav.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
  wav.extend_from_slice(&(SAMPLE_RATE as u32 * 2).to_le_bytes());
  wav.extend_from_slice(&2u16.to_le_bytes());
  wav.extend_from_slice(&16u16.to_le_bytes());
  wav.extend_from_slice(b"data");
  wav.extend_from_slice(&data_len.to_le_bytes());
  for sample in samples {
    wav.extend_from_slice(&sample.to_le_bytes());
  }
  wav
}

// ---------------------------------------------------------------------------
// Output formats

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
  pub start: f64,
  pub end: f64,
  pub text: String,
}

/// One paragraph per segment: segments end at pauses, so paragraphs follow
/// the speaker's own breaks.
pub fn plain_text(segments: &[TranscriptSegment]) -> String {
  segments
    .iter()
    .map(|segment| segment.text.trim())
    .filter(|text| !text.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n")
}

/// Split a segment's text into sentence-sized cues and share its time span
/// among them by character count. The model returns no word timings, so this
/// is as precise as the timestamps get.
fn cues(segment: &TranscriptSegment) -> Vec<(f64, f64, String)> {
  let mut sentences: Vec<String> = Vec::new();
  let mut current = String::new();
  let chars: Vec<char> = segment.text.trim().chars().collect();
  for (index, ch) in chars.iter().copied().enumerate() {
    current.push(ch);
    let next = chars.get(index + 1).copied();
    let ends = match ch {
      '。' | '！' | '？' | '\n' => true,
      // Latin punctuation ends a sentence only before a space, and a period
      // not inside an abbreviation such as "e.g." or a number such as "3.5".
      '!' | '?' => next.is_none_or(char::is_whitespace),
      '.' => {
        next.is_none_or(char::is_whitespace)
          && !current
            .trim_end_matches('.')
            .rsplit(char::is_whitespace)
            .next()
            .is_some_and(|word| word.contains('.') || word.chars().count() == 1)
      }
      _ => false,
    };
    // Very short sentences stay with the next one.
    if ends && current.trim().chars().count() >= 8 {
      sentences.push(current.trim().to_string());
      current.clear();
    }
  }
  let rest = current.trim();
  if !rest.is_empty() {
    match sentences.last_mut() {
      Some(last) if rest.chars().count() < 8 => {
        let joiner = if last.chars().last().is_some_and(is_cjk) { "" } else { " " };
        last.push_str(joiner);
        last.push_str(rest);
      }
      _ => sentences.push(rest.to_string()),
    }
  }
  let total: usize = sentences.iter().map(|sentence| sentence.chars().count()).sum();
  if total == 0 {
    return Vec::new();
  }
  let span = (segment.end - segment.start).max(0.0);
  let mut start = segment.start;
  let mut consumed = 0usize;
  sentences
    .into_iter()
    .map(|sentence| {
      consumed += sentence.chars().count();
      let end = segment.start + span * consumed as f64 / total as f64;
      let cue = (start, end, sentence);
      start = end;
      cue
    })
    .collect()
}

fn is_cjk(ch: char) -> bool {
  matches!(ch as u32, 0x3000..=0x303F | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xFF00..=0xFFEF)
}

fn srt_time(seconds: f64) -> String {
  let millis = (seconds.max(0.0) * 1000.0).round() as u64;
  format!(
    "{:02}:{:02}:{:02},{:03}",
    millis / 3_600_000,
    millis / 60_000 % 60,
    millis / 1000 % 60,
    millis % 1000
  )
}

pub fn srt(segments: &[TranscriptSegment]) -> String {
  segments
    .iter()
    .flat_map(cues)
    .enumerate()
    .map(|(index, (start, end, text))| {
      format!("{}\n{} --> {}\n{}\n", index + 1, srt_time(start), srt_time(end), text)
    })
    .collect::<Vec<_>>()
    .join("\n")
}

// ---------------------------------------------------------------------------
// Store

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
  Queued,
  Running,
  Done,
  Failed,
  Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTranscript {
  pub id: String,
  pub file_name: String,
  pub created_at: String,
  pub status: Status,
  #[serde(default)]
  pub error: Option<String>,
  /// "local", "openai" or "groq", fixed when the job starts.
  pub provider: String,
  pub model: String,
  #[serde(default)]
  pub duration_secs: f64,
  #[serde(default)]
  pub done_segments: usize,
  #[serde(default)]
  pub total_segments: usize,
  #[serde(default)]
  pub segments: Vec<TranscriptSegment>,
}

#[derive(Default, Serialize, Deserialize)]
struct StoreFile {
  items: Vec<FileTranscript>,
}

fn store() -> &'static Mutex<Option<Vec<FileTranscript>>> {
  static STORE: OnceLock<Mutex<Option<Vec<FileTranscript>>>> = OnceLock::new();
  STORE.get_or_init(|| Mutex::new(None))
}

fn store_path() -> Result<PathBuf> {
  Ok(crate::settings::app_data_dir()?.join(STORE_FILE))
}

fn load_items() -> Vec<FileTranscript> {
  let Ok(path) = store_path() else { return Vec::new() };
  let mut items = match std::fs::read_to_string(&path) {
    Ok(text) => serde_json::from_str::<StoreFile>(&text)
      .map(|file| file.items)
      .unwrap_or_else(|error| {
        log::warn!("file-transcription: unreadable store, starting empty: {error}");
        Vec::new()
      }),
    Err(_) => Vec::new(),
  };
  // A job that was queued or running when the app quit will never finish.
  for item in &mut items {
    if matches!(item.status, Status::Queued | Status::Running) {
      item.status = Status::Failed;
      item.error = Some(FILE_INTERRUPTED.into());
    }
  }
  items
}

fn with_items<T>(change: impl FnOnce(&mut Vec<FileTranscript>) -> T, persist: bool) -> T {
  let mut guard = store().lock().unwrap();
  let items = guard.get_or_insert_with(load_items);
  let result = change(items);
  if persist {
    let file = StoreFile { items: items.clone() };
    match (store_path(), serde_json::to_string(&file)) {
      (Ok(path), Ok(json)) => {
        if let Err(error) = crate::settings::atomic_write(&path, &json) {
          log::warn!("file-transcription: could not save transcripts: {error:#}");
        }
      }
      (Err(error), _) => log::warn!("file-transcription: no data directory: {error:#}"),
      (_, Err(error)) => log::warn!("file-transcription: could not encode transcripts: {error}"),
    }
  }
  result
}

pub fn list() -> Vec<FileTranscript> {
  with_items(|items| items.clone(), false)
}

pub fn get(id: &str) -> Option<FileTranscript> {
  with_items(|items| items.iter().find(|item| item.id == id).cloned(), false)
}

fn update(app: &AppHandle, id: &str, change: impl FnOnce(&mut FileTranscript)) {
  let updated = with_items(
    |items| {
      let item = items.iter_mut().find(|item| item.id == id)?;
      change(item);
      Some(item.clone())
    },
    true,
  );
  if let Some(item) = updated {
    let _ = app.emit(EVENT, &item);
  }
}

/// Delete a finished transcript, or cancel and delete one still in progress.
pub fn delete(app: &AppHandle, id: &str) -> bool {
  if let Some(token) = cancels().lock().unwrap().remove(id) {
    token.cancel();
  }
  let removed = with_items(
    |items| {
      let before = items.len();
      items.retain(|item| item.id != id);
      before != items.len()
    },
    true,
  );
  if removed {
    let _ = app.emit(EVENT, serde_json::json!({ "id": id, "deleted": true }));
  }
  removed
}

pub fn cancel(id: &str) -> bool {
  match cancels().lock().unwrap().get(id) {
    Some(token) => {
      token.cancel();
      true
    }
    None => false,
  }
}

// ---------------------------------------------------------------------------
// Jobs

fn cancels() -> &'static Mutex<HashMap<String, CancellationToken>> {
  static CANCELS: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
  CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Files run one at a time, in the order they were added.
static JOB_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// What a job needs from the engine layer: transcribe one 16 kHz mono WAV.
/// The engine and its settings are fixed when the job is created.
pub trait SegmentEngine: Send + Sync + 'static {
  fn provider(&self) -> &str;
  fn model(&self) -> &str;
  fn transcribe(
    &self,
    wav: Vec<u8>,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send + '_>>;
  /// Turn one segment's raw output into final text.
  fn finalize(&self, raw: &str) -> String;
  /// Called once when the job ends, however it ends.
  fn finish(&self) {}
}

/// Queue `path` for transcription and return the new transcript's id.
pub fn enqueue(app: AppHandle, path: PathBuf, engine: Box<dyn SegmentEngine>) -> String {
  let id = format!("file-{}", uuid::Uuid::new_v4());
  let file_name = path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_default();
  let item = FileTranscript {
    id: id.clone(),
    file_name,
    created_at: chrono::Utc::now().to_rfc3339(),
    status: Status::Queued,
    error: None,
    provider: engine.provider().to_owned(),
    model: engine.model().to_owned(),
    duration_secs: 0.0,
    done_segments: 0,
    total_segments: 0,
    segments: Vec::new(),
  };
  with_items(
    |items| {
      items.insert(0, item.clone());
      // Drop the oldest finished transcripts beyond the cap; never one in progress.
      while items.len() > HISTORY_CAP {
        match items.iter().rposition(|item| !matches!(item.status, Status::Queued | Status::Running)) {
          Some(index) => {
            items.remove(index);
          }
          None => break,
        }
      }
    },
    true,
  );
  let _ = app.emit(EVENT, &item);

  let token = CancellationToken::new();
  cancels().lock().unwrap().insert(id.clone(), token.clone());
  let job_id = id.clone();
  tauri::async_runtime::spawn(async move {
    let _turn = JOB_LOCK.lock().await;
    let result = run(&app, &job_id, &path, engine.as_ref(), &token).await;
    engine.finish();
    cancels().lock().unwrap().remove(&job_id);
    match result {
      Ok(()) => update(&app, &job_id, |item| item.status = Status::Done),
      Err(error) if token.is_cancelled() || error.to_string() == "TRANSCRIPTION_CANCELLED" => {
        update(&app, &job_id, |item| item.status = Status::Cancelled)
      }
      Err(error) => {
        log::warn!("file-transcription: job failed: {error:#}");
        let code = error_code(&error);
        update(&app, &job_id, |item| {
          item.status = Status::Failed;
          item.error = Some(code);
        });
      }
    }
  });
  id
}

fn error_code(error: &anyhow::Error) -> String {
  let message = error.to_string();
  let known = [
    FILE_UNREADABLE,
    FILE_UNSUPPORTED,
    FILE_NO_AUDIO,
    FILE_TOO_LONG,
    FILE_NO_SPEECH,
    "LOCAL_MODEL_MISSING",
    "API key not configured",
  ];
  known
    .iter()
    .find(|code| message.starts_with(*code))
    .map(|code| code.to_string())
    .unwrap_or_else(|| FILE_ENGINE_FAILED.into())
}

async fn run(
  app: &AppHandle,
  id: &str,
  path: &Path,
  engine: &dyn SegmentEngine,
  token: &CancellationToken,
) -> Result<()> {
  if token.is_cancelled() {
    bail!("TRANSCRIPTION_CANCELLED");
  }
  update(app, id, |item| item.status = Status::Running);

  let decode_path = path.to_path_buf();
  let decode_token = token.clone();
  let samples = tokio::task::spawn_blocking(move || decode_to_16k(&decode_path, &decode_token))
    .await
    .map_err(|error| anyhow!("decoder task failed: {error}"))??;
  let segments = plan_segments(&samples);
  let duration = samples.len() as f64 / SAMPLE_RATE as f64;
  log::info!(
    "file-transcription: decoded {:.0}s of audio into {} segments",
    duration,
    segments.len()
  );
  update(app, id, |item| {
    item.duration_secs = duration;
    item.total_segments = segments.len();
  });
  if segments.is_empty() {
    bail!(FILE_NO_SPEECH);
  }

  for (index, segment) in segments.iter().enumerate() {
    let wav = wav_bytes(&samples[segment.start..segment.end]);
    let raw = transcribe_with_retry(engine, wav, token).await?;
    let text = engine.finalize(&raw);
    update(app, id, |item| {
      item.done_segments = index + 1;
      if !text.trim().is_empty() {
        item.segments.push(TranscriptSegment {
          start: segment.start_secs(),
          end: segment.end_secs(),
          text,
        });
      }
    });
  }
  Ok(())
}

/// One retry per segment: a transient engine or network failure should not
/// cost an hour-long file.
async fn transcribe_with_retry(
  engine: &dyn SegmentEngine,
  wav: Vec<u8>,
  token: &CancellationToken,
) -> Result<String> {
  let mut last_error = None;
  for attempt in 0..2 {
    let result = tokio::select! {
      _ = token.cancelled() => bail!("TRANSCRIPTION_CANCELLED"),
      result = engine.transcribe(wav.clone()) => result,
    };
    match result {
      Ok(text) => return Ok(text),
      Err(error) => {
        let message = error.to_string();
        if message.starts_with("LOCAL_MODEL_MISSING") || message.starts_with("API key not configured") {
          return Err(error);
        }
        log::warn!("file-transcription: segment attempt {} failed: {error:#}", attempt + 1);
        last_error = Some(error);
      }
    }
  }
  Err(last_error.unwrap_or_else(|| anyhow!(FILE_ENGINE_FAILED)))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn tone(seconds: f32, amplitude: f32) -> Vec<i16> {
    let count = (seconds * SAMPLE_RATE as f32) as usize;
    (0..count)
      .map(|index| {
        let phase = index as f32 * 220.0 * std::f32::consts::TAU / SAMPLE_RATE as f32;
        (phase.sin() * amplitude * i16::MAX as f32) as i16
      })
      .collect()
  }

  fn silence(seconds: f32) -> Vec<i16> {
    vec![0; (seconds * SAMPLE_RATE as f32) as usize]
  }

  #[test]
  fn short_file_is_one_trimmed_segment() {
    let mut audio = silence(2.0);
    audio.extend(tone(5.0, 0.3));
    audio.extend(silence(3.0));
    let segments = plan_segments(&audio);
    assert_eq!(segments.len(), 1);
    // Trimmed to the tone plus 200 ms of padding on each side.
    assert!((segments[0].start_secs() - 1.8).abs() < 0.05, "{:?}", segments[0]);
    assert!((segments[0].end_secs() - 7.2).abs() < 0.05, "{:?}", segments[0]);
  }

  #[test]
  fn long_speech_is_cut_in_the_pause() {
    let mut audio = Vec::new();
    for _ in 0..4 {
      audio.extend(tone(24.0, 0.3));
      audio.extend(silence(1.0));
    }
    let segments = plan_segments(&audio);
    assert!(segments.len() >= 4, "{segments:?}");
    for segment in &segments {
      assert!(segment.end_secs() - segment.start_secs() <= MAX_SEGMENT_SECS as f64 + 0.01);
    }
    // Every cut lands inside one of the one-second pauses.
    for pair in segments.windows(2) {
      let gap_start = pair[0].end_secs() - 0.2;
      let within = (1..4).any(|n| {
        let pause = n as f64 * 25.0 - 1.0;
        gap_start >= pause - 0.3 && gap_start <= pause + 1.0
      });
      assert!(within, "cut at {gap_start} is not in a pause: {segments:?}");
    }
  }

  #[test]
  fn a_long_pause_ends_the_segment() {
    let mut audio = tone(6.0, 0.3);
    audio.extend(silence(1.5));
    audio.extend(tone(6.0, 0.3));
    audio.extend(silence(0.4));
    audio.extend(tone(6.0, 0.3));
    let segments = plan_segments(&audio);
    // Split at the 1.5 s pause, not at the 0.4 s one.
    assert_eq!(segments.len(), 2, "{segments:?}");
    assert!((segments[0].end_secs() - 6.2).abs() < 0.05, "{segments:?}");
    assert!((segments[1].start_secs() - 7.3).abs() < 0.05, "{segments:?}");
  }

  #[test]
  fn a_pause_right_after_a_short_interjection_does_not_split() {
    let mut audio = tone(1.0, 0.3);
    audio.extend(silence(1.5));
    audio.extend(tone(6.0, 0.3));
    assert_eq!(plan_segments(&audio).len(), 1);
  }

  #[test]
  fn silent_file_has_no_segments() {
    assert!(plan_segments(&silence(60.0)).is_empty());
  }

  #[test]
  fn continuous_speech_never_exceeds_the_segment_cap() {
    let audio = tone(200.0, 0.3);
    let segments = plan_segments(&audio);
    assert!(segments.iter().all(|s| s.end - s.start <= MAX_SEGMENT_SECS * SAMPLE_RATE));
    assert_eq!(segments.first().unwrap().start, 0);
    assert_eq!(segments.last().unwrap().end, audio.len());
  }

  #[test]
  fn wav_header_matches_the_local_engine_contract() {
    let wav = wav_bytes(&[1, -1, 2]);
    assert_eq!(wav.len(), 44 + 6);
    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
    assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
  }

  #[test]
  fn resampler_keeps_duration_and_timing() {
    let input_rate = 44_100;
    let seconds = 3usize;
    // One second of silence, then a tone: the onset must stay at 1.0 s.
    let mut input = vec![0.0f32; input_rate];
    input.extend((0..input_rate * (seconds - 1)).map(|index| {
      (index as f32 * 440.0 * std::f32::consts::TAU / input_rate as f32).sin() * 0.5
    }));
    let mut resampler = MonoResampler::new(input_rate).unwrap();
    let mut output = Vec::new();
    for chunk in input.chunks(1000) {
      resampler.push(chunk, &mut output).unwrap();
    }
    resampler.finish(&mut output).unwrap();
    assert_eq!(output.len(), seconds * SAMPLE_RATE);
    let onset = output.iter().position(|sample| sample.abs() > 1000).unwrap();
    assert!((onset as i64 - SAMPLE_RATE as i64).abs() < 160, "onset at sample {onset}");
  }

  #[test]
  fn decodes_a_wav_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("clip.wav");
    std::fs::write(&path, wav_bytes(&tone(2.0, 0.3))).unwrap();
    let samples = decode_to_16k(&path, &CancellationToken::new()).unwrap();
    assert_eq!(samples.len(), 2 * SAMPLE_RATE);
  }

  #[test]
  fn rejects_a_file_that_is_not_media() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.mp3");
    std::fs::write(&path, b"this is plain text, not audio").unwrap();
    let error = decode_to_16k(&path, &CancellationToken::new()).unwrap_err();
    assert_eq!(error.to_string(), FILE_UNSUPPORTED);
  }

  #[test]
  fn plain_text_puts_each_segment_in_its_own_paragraph() {
    let segments = vec![
      TranscriptSegment { start: 0.0, end: 5.0, text: "第一段。".into() },
      TranscriptSegment { start: 6.0, end: 9.0, text: " Second part. ".into() },
    ];
    assert_eq!(plain_text(&segments), "第一段。\n\nSecond part.");
  }

  #[test]
  fn srt_splits_sentences_and_shares_the_span() {
    let segments = vec![TranscriptSegment {
      start: 61.0,
      end: 71.0,
      text: "今天我们讨论发布计划。然后看一下下周的安排。".into(),
    }];
    let output = srt(&segments);
    assert_eq!(
      output,
      "1\n00:01:01,000 --> 00:01:06,000\n今天我们讨论发布计划。\n\n2\n00:01:06,000 --> 00:01:11,000\n然后看一下下周的安排。\n"
    );
  }

  #[test]
  fn srt_keeps_abbreviations_and_short_tails_together() {
    let segment = TranscriptSegment { start: 0.0, end: 4.0, text: "Use e.g. this one. Ok.".into() };
    let cues = cues(&segment);
    assert_eq!(cues.len(), 1, "{cues:?}");
    assert_eq!(cues[0].2, "Use e.g. this one. Ok.");
  }

  /// Decode, segment and transcribe a real file with the installed local Qwen
  /// model. Run with: TYPEALOUD_FILE=/path/to/file cargo test real_file -- --ignored --nocapture
  #[tokio::test]
  #[ignore]
  async fn real_file_through_local_qwen() {
    let path = PathBuf::from(std::env::var("TYPEALOUD_FILE").expect("set TYPEALOUD_FILE"));
    let started = std::time::Instant::now();
    let samples = decode_to_16k(&path, &CancellationToken::new()).unwrap();
    let segments = plan_segments(&samples);
    println!(
      "decoded {:.1}s in {:?}, {} segments",
      samples.len() as f64 / SAMPLE_RATE as f64,
      started.elapsed(),
      segments.len()
    );
    let session = crate::local_asr::next_file_session_id();
    let mut output = Vec::new();
    for segment in &segments {
      let wav = wav_bytes(&samples[segment.start..segment.end]);
      let segment_started = std::time::Instant::now();
      let raw = crate::local_asr::transcribe_wav_for(
        crate::local_asr::QWEN_MODEL_ID, None, Some(session), None, &wav,
      )
      .await
      .unwrap();
      println!(
        "[{:>7.1} - {:>7.1}] ({:.1}s) {}",
        segment.start_secs(),
        segment.end_secs(),
        segment_started.elapsed().as_secs_f64(),
        raw
      );
      output.push(TranscriptSegment { start: segment.start_secs(), end: segment.end_secs(), text: raw });
    }
    crate::local_asr::finish_resident_session(session);
    println!("total {:?}\n---- SRT ----\n{}", started.elapsed(), srt(&output));
  }

  #[test]
  fn media_paths_are_recognised_by_extension() {
    assert!(is_media_path(Path::new("/tmp/Meeting.M4A")));
    assert!(is_media_path(Path::new("call.mp4")));
    assert!(!is_media_path(Path::new("notes.txt")));
    assert!(!is_media_path(Path::new("noextension")));
  }
}
