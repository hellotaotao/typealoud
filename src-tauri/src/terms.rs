// Spelling correction against a list of known terms: the built-in list in
// `data/builtin-terms.txt` plus the plain entries of the user dictionary.
//
// Local engines take no prompt, so a dictionary entry used to do nothing for
// them, and one name comes out differently every time ("Nematron", "namatron",
// "NeMotron"). Instead of one `heard => wanted` rule per misspelling, a heard
// form is rewritten when it is the term apart from case and spacing, or within
// a letter or two of it.
//
// The matcher is deliberately conservative. A missed correction can still be
// fixed later (by a rule, or by a language-model pass); a wrong one destroys
// what the user said. So whenever the heard form reads as ordinary English, it
// is left alone:
//   - "cursor", "linear", "rust" keep their case: the word exists.
//   - "linked in", "tail wind" are not joined: the engine spells LinkedIn
//     correctly when it hears the brand, so two plain words mean two words.
//     "Eleven Labs" is joined, because the engine capitalized both as a name.
//   - "Cloud" never becomes "Claude": a real word is never a misspelling.
//   - Anything that looks like an identifier, a path or a URL is skipped.
//
// The English word list is the lowercase entries of Webster's Second (`web2`);
// see THIRD_PARTY_NOTICES.md. Its capitalized entries are left out, so "claude"
// still gets its capital. It is large on purpose: an over-inclusive list only
// makes the matcher more reluctant.

use std::collections::HashMap;

const ENGLISH_WORDS: &str = include_str!("data/english-words.txt");
const BUILTIN_TERMS: &str = include_str!("data/builtin-terms.txt");

/// Everyday words a 1934 dictionary lacks. Only words that could sit within a
/// letter or two of a term matter, but the list costs nothing.
const MODERN_WORDS: [&str; 40] = [
  "app", "apps", "async", "backend", "blog", "codec", "config", "dataset", "email", "emoji",
  "frontend", "http", "internet", "laptop", "login", "metadata", "offline", "online", "plugin", "podcast",
  "repo", "runtime", "screenshot", "signup", "smartphone", "startup", "sync", "timestamp", "toolkit", "upload",
  "download", "username", "webhook", "website", "wifi", "workflow", "changelog", "codebase", "homebrewed", "popup",
];

/// A window never spans more than this many heard words.
const MAX_WINDOW: usize = 3;
/// Shorter terms match exactly or not at all: "codec" is one letter from "Codex".
const FUZZY_MIN_LEN: usize = 6;
/// From this length on, two letters may differ instead of one.
const FUZZY_LONG_LEN: usize = 8;

struct Term {
  text: String,
  /// Lowercase ASCII letters and digits only.
  norm: String,
  parts: usize,
}

pub struct Terms {
  list: Vec<Term>,
  by_norm: HashMap<String, usize>,
}

impl Terms {
  /// `user_terms` come first, so a user's spelling wins over a built-in one.
  pub fn new(user_terms: &[&str]) -> Self {
    let builtin = BUILTIN_TERMS.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#'));
    let mut terms = Terms { list: Vec::new(), by_norm: HashMap::new() };
    for text in user_terms.iter().copied().chain(builtin) {
      // A term with CJK or other non-ASCII text has no Latin form to compare.
      if !text.is_ascii() {
        continue;
      }
      let norm = normalize(text);
      let parts = tokens(text).len();
      if norm.len() < 2 || parts == 0 || parts > MAX_WINDOW || terms.by_norm.contains_key(&norm) {
        continue;
      }
      terms.by_norm.insert(norm.clone(), terms.list.len());
      terms.list.push(Term { text: text.to_string(), norm, parts });
    }
    terms
  }

  pub fn correct(&self, text: &str) -> String {
    let tokens = tokens(text);
    let mut out = String::with_capacity(text.len());
    let (mut index, mut copied) = (0, 0);
    while index < tokens.len() {
      let hit = (1..=MAX_WINDOW.min(tokens.len() - index))
        .rev()
        .find_map(|n| self.decide(text, &tokens[index..index + n]).map(|decision| (n, decision)));
      match hit {
        Some((n, Decision::Replace(term))) => {
          out.push_str(&text[copied..tokens[index].0]);
          out.push_str(&self.list[term].text);
          copied = tokens[index + n - 1].1;
          index += n;
        }
        Some((n, Decision::Keep)) => index += n,
        None => index += 1,
      }
    }
    out.push_str(&text[copied..]);
    out
  }

  fn decide(&self, text: &str, window: &[(usize, usize)]) -> Option<Decision> {
    let (start, end) = (window[0].0, window[window.len() - 1].1);
    if !window.windows(2).all(|pair| matches!(&text[pair[0].1..pair[1].0], " " | "-" | "."))
      || glued_before(text, start)
      || glued_after(text, end)
    {
      return None;
    }
    let raw = &text[start..end];
    let heard = normalize(raw);
    let pieces: Vec<&str> = window.iter().map(|(from, to)| &text[*from..*to]).collect();

    if let Some(&index) = self.by_norm.get(&heard) {
      let term = &self.list[index];
      if raw == term.text {
        return Some(Decision::Keep);
      }
      let confident = if pieces.len() == 1 && term.parts == 1 {
        // Only the case differs: never capitalize an ordinary word.
        !is_word(raw)
      } else {
        // The word boundaries differ. Joining or re-casing plain words needs a
        // sign that they are a name: a piece that is no word, letters spelled
        // one by one, or the engine capitalizing every piece.
        pieces.iter().any(|piece| piece.len() >= 2 && !is_word(piece))
          || pieces.iter().filter(|piece| piece.len() == 1).count() >= 2
          || pieces.iter().all(|piece| piece.as_bytes()[0].is_ascii_uppercase())
      };
      return confident.then_some(Decision::Replace(index));
    }

    // "Dockers" and "postgress" are a term with something appended, which is
    // an inflection at least as often as a slip.
    let extends_a_term = |term: &Term| term.norm.len() >= FUZZY_MIN_LEN && heard.starts_with(&term.norm);
    if pieces.iter().all(|piece| is_word(piece)) || self.list.iter().any(extends_a_term) {
      return None;
    }
    let mut best: Option<(usize, usize)> = None;
    let mut tied = false;
    for (index, term) in self.list.iter().enumerate() {
      let acronym = !term.text.bytes().any(|byte| byte.is_ascii_lowercase());
      if term.norm.len() < FUZZY_MIN_LEN
        || acronym
        || term.parts != pieces.len()
        || term.norm.as_bytes()[0] != heard.as_bytes()[0]
        || has_digit(&heard) != has_digit(&term.norm)
      {
        continue;
      }
      let cap = if term.norm.len() < FUZZY_LONG_LEN { 1 } else { 2 };
      let Some(distance) = edit_distance(heard.as_bytes(), term.norm.as_bytes(), cap) else { continue };
      match best {
        Some((smallest, _)) if distance > smallest => {}
        Some((smallest, _)) if distance == smallest => tied = true,
        _ => {
          best = Some((distance, index));
          tied = false;
        }
      }
    }
    // Two terms equally close: guessing one would be a coin toss.
    best.filter(|_| !tied).map(|(_, index)| Decision::Replace(index))
  }
}

enum Decision {
  /// Already the term as written: consume it so no part is matched again.
  Keep,
  Replace(usize),
}

fn normalize(text: &str) -> String {
  text.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect()
}

fn has_digit(text: &str) -> bool {
  text.bytes().any(|byte| byte.is_ascii_digit())
}

/// Byte ranges of the runs of ASCII letters and digits that start with a letter.
fn tokens(text: &str) -> Vec<(usize, usize)> {
  let bytes = text.as_bytes();
  let mut found = Vec::new();
  let mut index = 0;
  while index < bytes.len() {
    if !bytes[index].is_ascii_alphanumeric() {
      index += 1;
      continue;
    }
    let start = index;
    while index < bytes.len() && bytes[index].is_ascii_alphanumeric() {
      index += 1;
    }
    if bytes[start].is_ascii_alphabetic() {
      found.push((start, index));
    }
  }
  found
}

/// A possessive, or the tail of an identifier, a path, a hyphenated compound
/// or a file name ("window's entry", "qwen_model", "tauri-cli", "x.json").
fn glued_before(text: &str, start: usize) -> bool {
  let before = &text[..start];
  let Some(last) = before.chars().next_back() else { return false };
  match last {
    '_' | '/' | '@' | '\'' | '’' | '`' | '\\' | '.' | '=' | '"' => true,
    '-' | ':' => before[..before.len() - 1].chars().next_back().is_some_and(|c| c.is_ascii_alphanumeric()),
    _ => false,
  }
}

/// The head of an identifier, a path, a URL scheme or a file name.
fn glued_after(text: &str, end: usize) -> bool {
  let mut after = text[end..].chars();
  match (after.next(), after.next()) {
    (Some('_' | '/' | '@' | '\\'), _) => true,
    (Some(':'), Some('/')) => true,
    (Some('.' | '-'), Some(next)) => next.is_ascii_alphanumeric(),
    _ => false,
  }
}

fn is_word(token: &str) -> bool {
  let word = token.to_ascii_lowercase();
  if word.len() == 1 || MODERN_WORDS.contains(&word.as_str()) || in_word_list(&word) {
    return true;
  }
  ["s", "es", "ed", "d", "ing", "ly"].iter().any(|suffix| {
    word.strip_suffix(suffix).is_some_and(|stem| {
      stem.len() >= 2 && (in_word_list(stem) || (*suffix == "ing" && in_word_list(&format!("{stem}e"))))
    })
  })
}

/// Binary search over the embedded list: byte-sorted lowercase words, one per
/// line. Searching the text in place avoids building a quarter-million-entry
/// set for a lookup that runs a few dozen times per dictation.
fn in_word_list(word: &str) -> bool {
  let bytes = ENGLISH_WORDS.as_bytes();
  let (mut low, mut high) = (0, bytes.len());
  while low < high {
    let middle = low + (high - low) / 2;
    let start = bytes[..middle].iter().rposition(|byte| *byte == b'\n').map_or(0, |at| at + 1);
    let end = start + bytes[start..].iter().position(|byte| *byte == b'\n').unwrap_or(bytes.len() - start);
    match bytes[start..end].cmp(word.as_bytes()) {
      std::cmp::Ordering::Equal => return true,
      std::cmp::Ordering::Less => low = end + 1,
      std::cmp::Ordering::Greater => high = start,
    }
  }
  false
}

/// Edits (insert, delete, substitute, swap neighbours) to turn `a` into `b`,
/// or `None` when more than `cap`.
fn edit_distance(a: &[u8], b: &[u8], cap: usize) -> Option<usize> {
  if a.len().abs_diff(b.len()) > cap {
    return None;
  }
  let mut before_previous: Vec<usize> = Vec::new();
  let mut previous: Vec<usize> = (0..=b.len()).collect();
  for i in 1..=a.len() {
    let mut current = vec![i; b.len() + 1];
    for j in 1..=b.len() {
      let substitution = previous[j - 1] + usize::from(a[i - 1] != b[j - 1]);
      current[j] = substitution.min(previous[j] + 1).min(current[j - 1] + 1);
      if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
        current[j] = current[j].min(before_previous[j - 2] + 1);
      }
    }
    before_previous = std::mem::replace(&mut previous, current);
  }
  Some(previous[b.len()]).filter(|distance| *distance <= cap)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn correct(text: &str) -> String {
    Terms::new(&[]).correct(text)
  }

  #[test]
  fn the_word_list_is_sorted_and_searchable() {
    for word in ["aa", "cloud", "cursor", "linked", "zymurgy"] {
      assert!(in_word_list(word), "{word}");
    }
    for word in ["", "a", "nematron", "openai", "claude", "zzzz"] {
      assert!(!in_word_list(word), "{word}");
    }
    assert!(is_word("Skills") && is_word("trades") && is_word("coding") && is_word("codec"));
    assert!(!is_word("Nematron") && !is_word("versel"));
  }

  // Every row here was produced by a local engine in real History.
  #[test]
  fn misspellings_from_real_history_are_corrected() {
    for (heard, wanted) in [
      ("使用Nematron的说话人分离模型", "使用Nemotron的说话人分离模型"),
      ("实时的流式namatron要", "实时的流式Nemotron要"),
      ("据我所知，NeMotron流式转写", "据我所知，Nemotron流式转写"),
      ("能够用的这个Sharp ONNX只有", "能够用的这个sherpa-onnx只有"),
      ("不知道Eleven Labs在这方面", "不知道ElevenLabs在这方面"),
    ] {
      assert_eq!(correct(heard), wanted);
    }
  }

  #[test]
  fn case_and_spacing_are_restored_when_a_piece_is_no_word() {
    for (heard, wanted) in [
      ("open a i", "OpenAI"),
      ("openai and GITHUB", "OpenAI and GitHub"),
      ("chat gpt", "ChatGPT"),
      ("vs code", "VS Code"),
      ("X Code", "Xcode"),
      ("next js", "Next.js"),
      ("node.JS", "Node.js"),
      ("claude code", "Claude Code"),
      ("gemini and tauri", "Gemini and Tauri"),
      ("Type Script", "TypeScript"),
      ("lm studio", "LM Studio"),
    ] {
      assert_eq!(correct(heard), wanted, "{heard:?}");
    }
  }

  #[test]
  fn near_misses_are_corrected() {
    for (heard, wanted) in [
      ("versel", "Vercel"),
      ("olama", "Ollama"),
      ("claud", "Claude"),
      ("antropic", "Anthropic"),
      ("copilet", "Copilot"),
      ("superbase", "Supabase"),
      ("Kubernetis", "Kubernetes"),
    ] {
      assert_eq!(correct(heard), wanted, "{heard:?}");
    }
  }

  #[test]
  fn ordinary_english_is_left_alone() {
    for text in [
      // A real word is never a misspelling, and never gets a brand's capitals.
      "Cloud", "cloud session", "the cursor moved", "linear scaling", "rust and swift", "a notion",
      "whisper", "docker", "slack off",
      // Plain words are not joined into a brand.
      "I linked in the doc", "a tail wind", "type script", "x code", "hugging face", "eleven labs",
      "git hub", "post hog",
      // Too short, an acronym, or one letter from another word.
      "codec", "http", "HTTP", "figgma", "apis",
      // The term inflected.
      "Dockers", "homebrewed", "postgress", "Supabases",
      // Already right.
      "Claude Code, OpenAI, sherpa-onnx, Node.js, llama.cpp, LinkedIn",
    ] {
      assert_eq!(correct(text), text, "{text:?}");
    }
  }

  #[test]
  fn identifiers_paths_and_urls_are_left_alone() {
    for text in [
      "tauri.conf.json", "qwen_model", "`openai`", "https://github.com/openai", "huggingface.co/nvidia",
      "tauri-cli", "win-vulkan-x64", "python3 -m http.server", "window's entry script", "Intel i5",
      "sherpa-onnx in-process", "build:linux", "TYPEALOUD_POSTHOG_KEY", "nemotron_asr.rs", "a@openai",
      "`.onnx`", "provider=openai", "\"openai\"",
    ] {
      assert_eq!(correct(text), text, "{text:?}");
    }
  }

  #[test]
  fn punctuation_around_a_term_does_not_block_it() {
    assert_eq!(correct("用versel。"), "用Vercel。");
    assert_eq!(correct("We use versel. Then openai: fine"), "We use Vercel. Then OpenAI: fine");
    assert_eq!(correct("(nematron)"), "(Nemotron)");
  }

  #[test]
  fn user_terms_join_the_list_and_win_over_built_in_ones() {
    let terms = Terms::new(&["Avanade", "Eleven Labs", "千问", "Wispr"]);
    assert_eq!(terms.correct("avanade and Avanad"), "Avanade and Avanade");
    // The user's spelling replaces the built-in "ElevenLabs".
    assert_eq!(terms.correct("Eleven Labs and ElevenLabs"), "Eleven Labs and Eleven Labs");
    // "Wispr" is too short to match loosely, and "wisp" is a word.
    assert_eq!(terms.correct("Wisp and Wispa"), "Wisp and Wispa");
  }

  #[test]
  fn two_equally_close_terms_are_not_guessed() {
    let terms = Terms::new(&["Zentrix", "Zentrax"]);
    assert_eq!(terms.correct("Zentrux"), "Zentrux");
    assert_eq!(terms.correct("zentrix"), "Zentrix");
  }

  // Manual check against a real corpus, one transcription per line:
  //   TYPEALOUD_TERMS_CORPUS=/path/to/lines.txt cargo test terms::tests::report -- --ignored --nocapture
  #[test]
  #[ignore]
  fn report_changes_on_a_local_corpus() {
    let path = std::env::var("TYPEALOUD_TERMS_CORPUS").expect("TYPEALOUD_TERMS_CORPUS");
    let terms = Terms::new(&[]);
    let mut changed = 0;
    for line in std::fs::read_to_string(path).expect("corpus").lines() {
      let fixed = terms.correct(line);
      if fixed != line {
        changed += 1;
        println!("- {line}\n+ {fixed}");
      }
    }
    println!("{changed} lines changed");
  }
}
