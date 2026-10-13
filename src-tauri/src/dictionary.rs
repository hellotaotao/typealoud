// The user dictionary: one stored string of entries separated like the
// Dictionary page separates them (`src/views/main.js`, DICTIONARY_SEPARATORS).
//
// An entry is either a plain term, which cloud engines receive as a spelling
// reference in the transcription prompt, or a replacement rule `heard => wanted`
// (`->` and `→` also work), which rewrites the final text of every engine,
// local ones included. A rule's wanted side also joins the prompt; its heard
// side never does, since it is exactly the spelling the model should avoid.

use regex::Regex;

const RULE_ARROWS: [&str; 3] = ["=>", "->", "→"];

pub struct Replacement {
  pattern: Regex,
  wanted: String,
}

fn entries(text: &str) -> impl Iterator<Item = &str> {
  text
    .split(|c: char| matches!(c, ',' | '\n' | '，' | '、' | ';' | '；'))
    .map(str::trim)
    .filter(|entry| !entry.is_empty())
}

/// Split an entry into `(heard, wanted)` when it is a rule with both sides.
fn split_rule(entry: &str) -> Option<(&str, &str)> {
  RULE_ARROWS.iter().find_map(|arrow| {
    let (heard, wanted) = entry.split_once(arrow)?;
    let (heard, wanted) = (heard.trim(), wanted.trim());
    (!heard.is_empty() && !wanted.is_empty()).then_some((heard, wanted))
  })
}

/// The spellings the user wants: plain entries and the wanted side of rules.
pub fn terms(text: &str) -> Vec<&str> {
  entries(text).map(|entry| split_rule(entry).map_or(entry, |(_, wanted)| wanted)).collect()
}

/// The terms cloud engines get as a prompt, comma-separated.
pub fn prompt_terms(text: &str) -> String {
  terms(text).join(", ")
}

/// Compile the replacement rules, longest heard side first so a longer rule
/// wins over one that matches part of it.
pub fn replacements(text: &str) -> Vec<Replacement> {
  let mut rules: Vec<(&str, &str)> = entries(text).filter_map(split_rule).collect();
  rules.sort_by_key(|(heard, _)| std::cmp::Reverse(heard.chars().count()));
  rules
    .into_iter()
    .filter_map(|(heard, wanted)| {
      let pattern = Regex::new(&heard_pattern(heard)).ok()?;
      Some(Replacement { pattern, wanted: wanted.to_string() })
    })
    .collect()
}

/// Case-insensitive, and any run of whitespace in the heard side matches any
/// run in the text. An ASCII letter or digit at either end must sit on a word
/// boundary, so "vcell" never matches inside a longer word; CJK text has no
/// such boundaries and matches anywhere.
fn heard_pattern(heard: &str) -> String {
  let words: Vec<String> = heard.split_whitespace().map(regex::escape).collect();
  let edge = |c: Option<char>| if c.is_some_and(|c| c.is_ascii_alphanumeric()) { r"(?-u:\b)" } else { "" };
  format!("(?i){}{}{}", edge(heard.chars().next()), words.join(r"\s+"), edge(heard.chars().last()))
}

pub fn apply_replacements(text: &str, replacements: &[Replacement]) -> String {
  replacements.iter().fold(text.to_string(), |text, rule| {
    rule.pattern.replace_all(&text, regex::NoExpand(&rule.wanted)).into_owned()
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn apply(dictionary: &str, text: &str) -> String {
    apply_replacements(text, &replacements(dictionary))
  }

  #[test]
  fn plain_terms_and_rule_targets_form_the_prompt() {
    assert_eq!(prompt_terms("Claude,\nAzure，vcell => Vercel、Neo -> Neon"), "Claude, Azure, Vercel, Neon");
    assert_eq!(prompt_terms(""), "");
    assert_eq!(prompt_terms(" , ,"), "");
  }

  #[test]
  fn an_incomplete_rule_stays_a_plain_term() {
    assert_eq!(prompt_terms("=> Vercel, vcell =>"), "=> Vercel, vcell =>");
    assert!(replacements("=> Vercel, vcell =>").is_empty());
  }

  #[test]
  fn rules_replace_case_insensitively_on_word_boundaries() {
    let dictionary = "vcell => Vercel, x high → xhigh";
    assert_eq!(apply(dictionary, "去VCell上拿线上日志"), "去Vercel上拿线上日志");
    assert_eq!(apply(dictionary, "从x  high降到high"), "从xhigh降到high");
    assert_eq!(apply(dictionary, "avcells stay"), "avcells stay");
    assert_eq!(apply(dictionary, "x higher"), "x higher");
  }

  #[test]
  fn chinese_rules_match_inside_running_text() {
    assert_eq!(apply("签问 => 千问", "我在用签问模型"), "我在用千问模型");
  }

  #[test]
  fn the_longer_rule_wins_and_replacement_text_is_literal() {
    let dictionary = "Neo => Neon, Neo database => Neon Postgres, cost -> $1 each";
    assert_eq!(apply(dictionary, "Neo database and Neo"), "Neon Postgres and Neon");
    assert_eq!(apply(dictionary, "the cost"), "the $1 each");
  }

  #[test]
  fn regex_characters_in_the_heard_side_are_literal() {
    assert_eq!(apply("c++ => C++, a.b => AB", "c++ and axb and a.b"), "C++ and axb and AB");
  }
}
