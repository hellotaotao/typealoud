# Third-party notices

TypeAloud itself is licensed under PolyForm Noncommercial 1.0.0 (see `README.md`). The components
below keep their own licenses.

## Shipped inside the app

| Component | Version | License | Files |
|---|---|---|---|
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | 1.27.0 | MIT | `src/views/vendor/vad/ort.wasm.min.js`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` |
| [@ricky0123/vad-web](https://github.com/ricky0123/vad) | 0.0.30 | ISC | `src/views/vendor/vad/bundle.min.js` |
| [Silero VAD](https://github.com/snakers4/silero-vad) legacy model, as packaged by vad-web | — | MIT | `src/views/vendor/vad/silero_vad_legacy.onnx` |
| [Material Icons](https://github.com/google/material-design-icons) font | — | Apache-2.0 | `src/views/fonts/MaterialIcons-Regular.woff2` |
| [sysinfo](https://github.com/GuillaumeGomez/sysinfo) | 0.33.1 | MIT | Native hardware detection; `system` feature only, pinned in `src-tauri/Cargo.lock` |
| [arboard](https://github.com/1Password/arboard) | 3.6.1 | MIT OR Apache-2.0 | Windows-only, explicit Unicode clipboard copy; default/image features disabled |
| [clipboard-win](https://github.com/DoumanAsh/clipboard-win) / [error-code](https://github.com/DoumanAsh/error-code) | 5.4.1 / 3.4.0 | BSL-1.0 | Windows clipboard backend and error handling used by arboard |

`src/views/vendor/vad/PROVENANCE.md` records how the VAD files were obtained and how to update them.

The executable is built from the Rust crates pinned in `src-tauri/Cargo.lock`. Nearly all of them
are MIT and/or Apache-2.0. As of 1.15.1 the exceptions are the ICU4X crates (`icu_*`, `zerovec`
and related; Unicode-3.0), `rustls-webpki` and `untrusted` (ISC), `subtle`, `alloc-stdlib` and
`alloc-no-stdlib` (BSD-3-Clause), `zlib-rs` (Zlib), `webpki-roots` (CDLA-Permissive-2.0), and
`cssparser`, `cssparser-macros`, `selectors`, `dtoa-short` and `option-ext` (MPL-2.0). MPL-2.0
applies file by file; TypeAloud uses those crates unmodified, and their source is on crates.io.
The Windows clipboard dependencies `clipboard-win` and `error-code` use the Boost Software
License 1.0 (BSL-1.0). To
list every crate with its license:

```bash
cargo metadata --format-version 1 --manifest-path src-tauri/Cargo.toml \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).packages)console.log(p.license,p.name,p.version)})' \
  | sort
```

## Downloaded on demand

Nothing in this section is in the installer. TypeAloud downloads it from the upstream publisher when
the user sets up the engine that needs it.

### Qwen3-ASR (default local engine)

- **llama.cpp** `b9960` release archives from
  [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp/releases/tag/b9960), under the MIT
  License. On Windows, choosing GPU also downloads upstream's Vulkan archive.
- **Qwen3-ASR 0.6B and 1.7B**, as the GGUF conversions in `ggml-org/Qwen3-ASR-0.6B-GGUF` and
  `ggml-org/Qwen3-ASR-1.7B-GGUF` on Hugging Face. The original models,
  [Qwen/Qwen3-ASR-0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) and
  [Qwen/Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B), are Apache-2.0.

### Nemotron

TypeAloud does not ship the Nemotron runtime. When the user enables the engine it
downloads NVIDIA's own **NeMo-Speech.cpp v0.1.0** release archive (macOS arm64
Metal, or Windows x86_64 CPU) and verifies it against a pinned sha256. Those
archives carry the licenses of everything inside them under
`share/licenses/nemo-speech/`.

- **NeMo-Speech.cpp** v0.1.0 (commit `4f9676226f667d14608487df744f375db87127f8`)
  is distributed under Apache License 2.0.
  See <https://github.com/NVIDIA/NeMo-Speech.cpp/releases/tag/v0.1.0>.
- **SentencePiece**, **ggml**, **llama.cpp**, **cpp-httplib**, **miniaudio**,
  and (on Windows) **abseil**, **protobuf**, and **utf8-range** are linked into
  that release. Their licenses ship inside the archive.
- The Windows archive also carries Microsoft's redistributable MSVC and OpenMP
  runtimes (`msvcp140*.dll`, `vcruntime140*.dll`, `concrt140.dll`,
  `vcomp140.dll`), as redistributed by NVIDIA in that release.
- **Nemotron 3.5 ASR Streaming 0.6B** is downloaded on demand from NVIDIA's
  pinned Hugging Face revision and is licensed under OpenMDW-1.1. See
  <https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b>.

TypeAloud previously built its own macOS runtime from the same commit. That is
gone: the pinned commit *is* upstream's v0.1.0 tag, and upstream's archives are
already self-contained and relocatable, so the private build only re-derived
packaging work that upstream had done — the same conclusion recorded in
`vendor/llama.cpp/README.md` for the other local engine.
