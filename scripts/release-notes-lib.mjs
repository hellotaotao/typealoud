// Pure functions for CI release-notes generation. No I/O here — the CLI
// (generate-release-notes.mjs) does git + network; this file stays unit-testable.

// Parses `git log --format=%x1e%H%x1f%s%x1f%b` output.
// \u001e = record separator, \u001f = field separator — chars that cannot
// appear in commit messages, unlike any printable delimiter.
export function parseGitLog(raw) {
  return raw
    .split("\u001e")
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, subject = "", body = ""] = rec.split("\u001f");
      return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
    });
}

export function isNoiseCommit(subject) {
  return /^chore\(release\):/.test(subject) || /^Merge (branch|pull request)/.test(subject);
}

export function capPatch(patch, maxLines = 400) {
  const lines = patch.split("\n");
  if (lines.length <= maxLines) return patch;
  return (
    lines.slice(0, maxLines).join("\n") +
    `\n[patch truncated: ${lines.length - maxLines} more lines]`
  );
}

// Tiered budget: try messages+stats+patches, then messages+stats, then
// messages only. Commit messages always survive (hard-truncated only as a
// last resort, which real history never hits).
export function assembleMaterial(commits, maxTotalChars = 60000) {
  const render = ({ stats, patches }) =>
    commits
      .map((c) => {
        let block = `### ${c.sha.slice(0, 7)} ${c.subject}\n${c.body}`.trimEnd();
        if (stats && c.stat?.trim()) block += `\n\n[stat]\n${c.stat.trim()}`;
        if (patches && c.patch?.trim()) block += `\n\n[patch]\n${c.patch.trim()}`;
        return block;
      })
      .join("\n\n");

  for (const tier of [
    { stats: true, patches: true },
    { stats: true, patches: false },
    { stats: false, patches: false },
  ]) {
    const out = render(tier);
    if (out.length <= maxTotalChars) return out;
  }
  return render({ stats: false, patches: false }).slice(0, maxTotalChars) + "\n[truncated]";
}

export function buildPrompt({ tag, prevTag, material }) {
  const system = `You write GitHub release notes for TypeAloud, a hold-a-hotkey voice-dictation desktop app (macOS, Windows and Linux; it records speech, transcribes it on the device or through an optional cloud service, and types the text into the focused app).

You are given every commit between the previous release tag and the current one: full commit messages (the primary source — their bodies explain intent), plus file-change stats and truncated diffs where they fit.

Write the release notes as an honest, user-facing record of what changed:

- Cover only changes a user of the app can perceive: new features, fixes, behavior or UX changes, performance. Describe what changed and why it matters to the user, not the implementation.
- Omit internal-only commits entirely: CI, docs, tests, refactors, code style, version bumps. If a commit mixes both, keep only the user-visible part.
- Never invent or embellish — every claim must be supported by the commits. If genuinely nothing user-visible changed, say so in one line.
- Structure: Markdown sections in English first — use "## What's new", "## Improvements", "## Fixes" as content dictates, omitting empty sections; bullet points, concise. Then a "## 中文" section containing a faithful Chinese translation of the same content.
- End with exactly this block (verbatim, including the heading):
## Download / 下载

Pick the one installer for your platform:
- **macOS** — the \`.dmg\`
- **Windows** — the \`_x64-setup.exe\` (or \`.msi\`)
- **Linux** — the \`.AppImage\` (portable), \`.deb\` (Debian/Ubuntu), or \`.rpm\` (Fedora/RHEL)

The remaining files (\`*.sig\`, \`latest.json\`, \`*.app.tar.gz\`) are used by the built-in auto-updater — you don't need to download them.

（各平台任选一个安装：macOS 下 \`.dmg\`，Windows 下 \`_x64-setup.exe\` 或 \`.msi\`，Linux 下 \`.AppImage\`/\`.deb\`/\`.rpm\`。带 \`.sig\`、\`latest.json\`、\`*.app.tar.gz\` 的是自动更新用的，无需下载。）

Output the raw Markdown only — no code fences around the whole document, no preamble, no commentary.`;

  const user = `Current release tag: ${tag}
Previous release tag: ${prevTag}

Commits in this release (newest first):

${material}`;

  return { system, user };
}

// Validates a Messages API response and returns the notes text.
export function extractText(res) {
  if (res.stop_reason === "refusal") {
    throw new Error(`model refused the request (stop_details: ${JSON.stringify(res.stop_details ?? null)})`);
  }
  if (res.stop_reason === "max_tokens") {
    throw new Error("output truncated at max_tokens — raise the limit");
  }
  const text = (res.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) throw new Error("no text content in API response");
  return text.trim();
}
