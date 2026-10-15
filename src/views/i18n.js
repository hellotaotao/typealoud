(() => {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-i18n-ran", "1");
  }

  const translations = {
    en: {
      sidebar: {
        home: "Home",
        dictionary: "Dictionary",
        history: "History",
        settings: "Settings",
        help: "Help",
      },
      home: {
        ready: "Ready to dictate",
        setupNeeded: "Finish setup to start",
        readyHint: "Hold the shortcut in any app and start speaking",
        setupHint: "Add what's missing below, then you're ready",
        dictate: "Dictate",
        readyBadge: "Ready",
        setupBadge: "Setup",
        recentTitle: "Recent",
        viewAll: "View all",
        noActivity: "No recent activity",
        engineLabel: "Engine",
        engineLocalQwen: "Qwen",
        engineLocalQwenLarge: "Qwen 1.7B",
        engineCaptionLocalQwenLarge: "Qwen 1.7B transcribes on this computer; recordings aren't uploaded. Slower than 0.6B, usually more accurate",
        engineMore: "More",
        engineQwenSize: "Qwen size",
        engineAllSettings: "All engine settings…",
        engineLocalNemotron: "Nemotron",
        engineRecommended: "Recommended",
        engineExperimental: "Experimental",
        engineChecking: "Checking\u2026",
        engineReadyLocal: "Local",
        engineReadyCloud: "Cloud",
        engineDownloading: "Downloading\u2026",
        engineDownloadProgress: "Downloading \u00b7 {percent}%",
        engineNeedsDownload: "Needs download",
        engineNeedsSetup: "Needs setup",
        engineCaptionLocalQwen: "Qwen transcribes on this computer; recordings aren't uploaded",
        engineCaptionLocalNemotron: "Nemotron runs locally and types as you speak",
        engineCaptionGroq: "Cloud transcription with your Groq API key",
        engineCaptionOpenai: "Cloud transcription with your OpenAI API key",
      },
      readiness: {
        apiKey: "API key",
        microphone: "Microphone",
        accessibility: "Accessibility",
        addApiKey: "Add API key",
        localModel: "Local model",
        engine: "Transcription engine",
        axGuide: {
          title: "Allow TypeAloud to use Accessibility",
          lead: "macOS asks for this permission so TypeAloud can do exactly two things:",
          useInsert: "Type your dictated text into whatever app you're using",
          useHotkey: "Notice the hold-to-dictate shortcut while you're in any app",
          privacy:
            "This permission is only used to respond to the shortcut and type text. TypeAloud never logs your keystrokes or watches other apps.",
          open: "Open Accessibility Settings",
          waiting: "Waiting for permission…",
          waitingHint:
            "In System Settings, turn on the switch next to TypeAloud — this screen continues automatically once it's on.",
          retryHint:
            "Permission not detected yet. Turn on TypeAloud in the Accessibility list, or try again.",
          revealApp: "Reveal TypeAloud in Finder",
          revealHint: "Can't find TypeAloud in the list? Drag it in from Finder — same as clicking +.",
        },
      },
      onboarding: {
        start: "Get started",
        next: "Next",
        back: "Back",
        skip: "Skip for now",
        skipStep: "Skip this step for now",
        finish: "Done",
        resume: "Continue setup guide",
        welcome: {
          title: "Speak. It types.",
          lead: "In any app, hold the shortcut and talk — release, and the words appear at your cursor.",
          holdTitle: "Hold {keys}",
          holdDesc: "in any text field",
          speakTitle: "Speak",
          speakDesc: "then just let go",
          insertTitle: "Text appears",
          insertDesc: "typed at your cursor",
        },
        privacy: {
          title: "Local dictation. Your voice stays here.",
          lead: "With a local model, speech becomes text on this computer — without uploading audio.",
          noAccount: "No sign-up needed for local dictation",
          offline: "Download the model once, then dictate offline",
          line2: "History is stored only on this computer",
          usageTitle: "Share anonymous usage counts",
          usageDesc:
            "Once a day: how many dictations and characters, which engine, app and system version. Never audio, text or anything that identifies you. You can turn this off in Settings any time.",
        },
        mic: {
          title: "Let TypeAloud hear you",
          lead: "It records only while you hold the shortcut — release, and it stops.",
          enable: "Enable microphone",
          enableHint: "Your system will ask for microphone access — allow it to continue.",
          granted: "Microphone ready",
          denied:
            "Microphone access was denied. Turn on TypeAloud under System Settings → Privacy & Security → Microphone — this page continues automatically.",
          unknown: "Not yet tested with a recording",
          openSettings: "Open Microphone Settings",
        },
        ax: {
          title: "Let it type for you",
          granted: "Accessibility ready",
        },
        key: {
          title: "Connect your transcription service",
          lead: "Cloud transcription uses your own API key; any charges are billed by Groq or OpenAI directly.",
          leadCloudDefault: "This computer has limited memory or CPU cores. OpenAI is the default; local Qwen is still available.",
          cloudDefault: "Default on this computer to avoid slow local transcription.",
          localDescription: "Transcribes on this computer. No account needed.",
          localKind: "Local model",
          cloudKind: "Cloud service",
          cloudNotice: "Dictation audio is sent to {provider} for transcription, using your own API key.",
          localSlow: "Local transcription may be very slow on this computer.",
          more: "More options ▸",
          moreHide: "Hide more options ▾",
          cloudSetup: "Click to select and configure your API key.",
          keyLabel: "{provider} API key",
          downloadProgress: "Downloading {percent}%",
          downloadMissing: "Not downloaded",
          downloadReady: "Ready",
          downloadFailed: "Download failed — open to retry",
          otherDownloading: "Another model is downloading. Finish or cancel it in Settings first.",
          titleLocalFirst: "Choose your transcription engine",
          leadLocalFirst:
            "Choose free, offline dictation on this computer, or use OpenAI with your own API key.",
          localNemotronName: "Local · Nemotron 3.5 ASR",
          localQwenName: "Local · Qwen3-ASR",
          localRecommendedTag: "Recommended · free · offline",
          localOfflineTag: "Free · offline",
          localAbsent: "One-time {total} download — click to select and download.",
          localResume: "Download interrupted — click to continue.",
          localDownloading: "Downloading… {done} / {total}. You can keep going and finish setup later.",
          localReady: "Downloaded and ready — click to use the local engine.",
          localSelected: "Selected — dictation runs on this computer.",
          localError: "Download failed: {reason} Click to retry.",
          cloudToggle: "Or connect a cloud service (Groq / OpenAI) ▸",
          cloudToggleHide: "Hide cloud options ▾",
          groqDesc: "Use your own Groq API key. Your Groq account sets the usage limits.",
          openaiDesc: "Uses your own OpenAI API key. Pay as you go.",
          placeholderGroq: "Paste your Groq API key (gsk_…)",
          placeholderOpenai: "Paste your OpenAI API key (sk-…)",
          save: "Save",
          saved: "Saved ✓",
          getKeyGroq: "No key yet? Create one free at console.groq.com (about a minute).",
          getKeyOpenai: "No key yet? Create one at platform.openai.com.",
          configured: "This provider already has a key — you can go straight on.",
          error: "Couldn't save: {message}",
        },
        try: {
          engineReady: "Engine ready",
          micUnchecked: "Microphone not yet tested",
          historyHint: "Text didn't show up here? Find it in History to view or copy.",
          historyFallback: "The result was saved to History, but no text appeared here. Open History to view or copy it.",
          success: "Text received! You can use this shortcut in other apps too.",
          title: "Ready! Say your first sentence",
          lead: "It works the same way in every app from now on.",
          placeholder: "Put the cursor here, hold {keys} and say: nice weather today",
          hint: "Hold {keys} and speak → release → the text lands here",
        },
        tryPending: {
          title: "Almost there",
          lead: "Finish the items below and you're set — or head into the app; Home will show what's still missing.",
        },
      },
      update: {
        checkShort: "Check for updates",
        checkingShort: "Checking…",
        downloadingShort: "Downloading {version}",
        restartShort: "Restart to update",
        readyTitle: "{version} is downloaded — restart to use it",
        cardTitle: "{version} is ready",
        cardHint: "It won't restart on its own — click when it suits you.",
        whatsNew: "What's new",
        restart: "Restart to update",
      },
      history: {
        title: "History",
        subtitle: "Your recent transcriptions",
        search: "Search",
        clearAll: "Clear all",
        confirmClear: "Click again to confirm",
        empty: "No history yet",
        noResults: "No matches",
        today: "Today",
        yesterday: "Yesterday",
      },
      dictionary: {
        title: "Dictionary",
        subtitle: "Names, brands and terms you want transcribed correctly.",
        wordsTitle: "Words",
        wordsDesc: "Words that come out nearly right are corrected to the spelling you enter here.",
        placeholder: "Add a word, press Enter",
        replaceTitle: "Automatic replacements",
        replaceDesc: "A word keeps coming out wrong? Enter how it comes out and what it should be, and TypeAloud fixes it from then on. Works with every engine.",
        replaceHeard: "Comes out as, e.g. cloud code",
        replaceWanted: "Should be, e.g. Claude Code",
        replaceAdd: "Add",
        replaceRemove: "Remove {heard} → {wanted}",
        remove: "Remove {entry}",
        saved: "Saved",
        count: "{count} entries",
        countOne: "1 entry",
        aboutTitle: "How the dictionary is used",
        aboutWhat: "Type a word and press Enter, or paste a list separated by commas. Changes save automatically.",
        aboutHow: "When you use a cloud engine, these words go to the model as a reference. They are more likely to come out right, but not every time.",
        localNote: "The local engine can't be given these words in advance. TypeAloud corrects a word afterwards when it comes out a letter or two off, or with different capitals or spacing. If it comes out as ordinary words instead, add an automatic replacement.",
        punctuationTitle: "Automatic punctuation for Chinese",
        punctuationDesc: "When Whisper transcribes Chinese, TypeAloud sends the example below to the model to help it add punctuation. The example is fixed and contains none of your data; GPT models and other languages don't use it.",
        saveError: "Error saving dictionary: {message}",
      },
      activity: {
        retryErrors: {
          historyRead: "Could not read History. Please try again.",
          entryMissing: "This history entry no longer exists.",
          notPending: "This entry can no longer be re-transcribed.",
          audioMissing: "The recording for this entry is no longer available.",
          audioRead: "Could not read the recording. Please try again.",
          settingsRead: "Could not read Settings. Please try again.",
          resultSave: "Could not save the retry result. Please try again.",
          audioFormat: "The local engine cannot read this recording’s format. Switch to a cloud engine in Settings to re-transcribe it.",
          noSpeech: "No speech detected",
          captureIncomplete: "Recording incomplete. The part that was recorded is saved and can be re-transcribed.",
        },
        copyTitle: "Copy text",
        deleteTitle: "Delete",
        playTitle: "Play recording (debug)",
        pendingAudio: "Transcription stalled — tap to retry",
        pendingHint: "The recording is kept — click to retry.",
        retranscribeTitle: "Re-transcribe",
        retranscribeFailed: "Re-transcribe failed — try again",
        retranscribeFailedReason: "Re-transcribe failed: {reason}",
      },
      settings: {
        title: "Settings - TypeAloud",
        pageTitle: "Settings",
        pageSubtitle: "Settings save automatically.",
        tabsAria: "Settings sections",
        modelSingleHint: "Cloud transcription · billed by audio duration.",
        modelMultipleHint: "Prices in USD. Groq bills at least 10 seconds per request.",
        modelOpenaiPrice: "US$0.0045/min · US$0.27/audio hour",
        modelOpenaiDetail: "High accuracy, many languages.",
        modelTurboPrice: "US$0.04/audio hour",
        modelTurboDetail: "Faster and cheaper.",
        modelV3Price: "US$0.111/audio hour · 2.8× the cost",
        modelV3Detail: "Slower. Makes fewer errors in Groq's published tests; actual results depend on your recordings.",
        advanced: "Advanced settings",
        section: {
          dictation: "Dictation Settings",
          app: "App Settings",
        },
        recordingShortcut: {
          title: "Recording shortcut",
          description:
            "Hold this shortcut to talk; release to finish.",
          selectTitle: "Select recording shortcut",
        },
        accessibility: {
          title: "Accessibility Permission",
          description: "Required for global hotkeys and automatic text insertion.",
          granted: "✅ Accessibility permission granted",
          notRequired: "✅ Not required on this platform",
          denied: "❌ Accessibility permission not granted",
          rechecking: "Rechecking...",
        },
        microphone: {
          title: "Microphone Permission",
          description: "TypeAloud needs the microphone to record.",
        },
        permission: {
          checking: "Checking...",
          granted: "✅ Granted",
          notDetermined: "Microphone access has not been requested yet",
          denied: "❌ Denied — please enable in System Settings",
          restricted: "❌ Restricted by system policy",
          error: "❌ Error checking permission",
        },
        checkPermission: "Check Permission",
        uiLanguage: {
          title: "Interface language",
          description: "Choose the language used in the app UI.",
          selectTitle: "Select interface language",
          auto: "System",
          english: "English",
          chinese: "中文",
        },
        theme: {
          title: "Theme",
          description: "Light, dark, or follow your system.",
          selectTitle: "Select interface theme",
          option: {
            auto: "System",
            midnight: "Dark",
            elegant: "Light",
          },
        },
        transcriptionLanguage: {
          title: "Dictation language",
          description: "The language you speak, or auto-detect.",
          auto: "Auto-detect",
          selectTitle: "Select dictation language",
          localNote:
            "Qwen detects the language automatically and does not use this setting.",
          groupCommon: "Common",
          groupAll: "All languages",
        },
        removeFillerWords: {
          title: "Remove filler words",
          description: "Drop hesitation sounds such as 嗯 and 呃. Interjections such as 啊 and 呀 stay.",
        },
        mergeSpelledLetters: {
          title: "Merge spelled-out letters",
          description: "Join letters spelled one at a time, for example A P I → API.",
        },
        autoLaunch: {
          title: "Start with system",
          description: "Automatically start TypeAloud when your computer starts up.",
          aria: "Start with system",
        },
        startMinimized: {
          title: "Start minimized",
          description:
            "Every launch keeps the main window hidden and runs TypeAloud in the background; the shortcut still works.",
          aria: "Start minimized",
        },
        updates: {
          title: "Software updates",
          description: "New versions download in the background; you choose when to restart.",
          check: "Check for updates",
          restart: "Restart to update",
          checking: "Checking…",
          downloading: "Downloading v{version}…",
          ready: "v{version} ready — restart to update",
          upToDate: "v{version} — up to date",
          error: "Couldn't check for updates. Try again later.",
          storeManaged: "v{version} — updated through Microsoft Store",
        },
        usageStats: {
          title: "Anonymous usage statistics",
          description:
            "Once a day, send how many dictations and characters, which engine, app and system version. Never audio or text. Turning this off also deletes the counts not yet sent.",
          previewTitle: "View what is sent",
          previewDescription: "The exact content of the next upload, including today's running count.",
          previewAria: "Usage statistics preview",
          previewOff: "Statistics are off. Nothing is recorded or sent.",
          previewEmpty: "Nothing recorded yet.",
          previewLoaded: "{count} rows · {size}. Today's row is sent tomorrow.",
        },
        diagnostics: {
          title: "Diagnostic logs",
          description: "View and copy the local log used to investigate performance problems.",
          refresh: "Refresh",
          copy: "Copy all",
          contentAria: "Diagnostic log content",
          loading: "Loading log…",
          empty: "No diagnostic log is available yet.",
          loaded: "{size} · Updated {time}",
          truncated: "Showing the latest {size} · Updated {time}",
          loadError: "Could not read the log: {message}",
          copied: "Copied to clipboard",
          copyError: "Could not copy the log: {message}",
        },
        apiProvider: {
          title: "Transcription Provider",
          description: "Choose a cloud provider or local engine.",
          selectTitle: "Select transcription provider",
          localQwenLarge: "Local · Qwen3-ASR 1.7B",
          localNemotron: "Local · Nemotron 3.5 ASR",
          localQwen: "Local · Qwen3-ASR · ★ Recommended",
        },
        nemotronLatency: {
          title: "Nemotron response speed",
          description: "Choose faster text or better accuracy.",
          selectTitle: "Select Nemotron response speed",
          balanced: "Faster text",
          accuracy: "More accurate",
        },
        engine: {
          active: "Currently in use",
          activeModel: "In use · {model}",
          whisperLarge: "Whisper Large V3",
          whisperTurbo: "Whisper Large V3 Turbo",
          gptTranscribe: "GPT Transcribe",
          details: "Show {model} details",
          notReadyKey: "Not in use yet. Add an API key, then click {model} again to switch.",
          notReadyDownload: "Not in use yet. Once the model is downloaded, click {model} again to switch.",
          switchFailed: "Engine unchanged.",
          invalidModel: "Choose an available model.",
          keyRequired: "Enter an API key before using this model.",
          cloudNotice: "Using this cloud model uploads dictation audio to its provider.",
          recommended: "Recommended",
          experimental: "Experimental",
          localQwenLarge: {
            name: "Qwen3-ASR 1.7B",
          },
          localQwen: {
            name: "Qwen3-ASR 0.6B",
          },
          qwen: {
            name: "Qwen3-ASR",
            description: "Transcribes on this computer; recordings aren't uploaded. Comes in two sizes, 0.6B and 1.7B.",
          },
          more: "More engines",
          qwenSize: {
            label: "Size",
            smallNote: "Faster",
            largeNote: "Usually more accurate",
            download: "Download",
            memory: "Memory",
            wait: "After a 15-second sentence",
            waitValue: "about {seconds} s",
            waitUnknown: "shown after a few dictations",
            inUse: "In use",
            ready: "Downloaded",
            downloading: "Downloading {percent}%",
            absent: "Not downloaded",
            suggest: "This computer is fast enough for 1.7B, which is usually more accurate. You keep using 0.6B while it downloads, and it switches over when done.",
            suggestAction: "Download 1.7B (about 2.5 GB)",
            slow: "1.7B is slow on this computer: about {seconds} s after a 15-second sentence. 0.6B is faster.",
            slowAction: "Switch back to 0.6B",
          },
          groq: {
            name: "Groq",
            description: "The fastest cloud Whisper. Recordings are uploaded to Groq.",
          },
          openai: {
            name: "OpenAI",
            description: "Good Chinese punctuation (gpt-transcribe). Recordings are uploaded to OpenAI.",
          },
          localNemotron: {
            name: "Nemotron 3.5 ASR",
            description: "Streams while you speak, but noticeably less accurate than Qwen.",
          },
          status: {
            ready: "Ready",
            downloading: "Downloading",
            needsDownload: "Needs download",
            needsKey: "Needs a key",
            keySet: "Key saved",
            local: "On this device",
          },
        },
        apiKey: {
          title: "API Key",
          description: "Stored only on this computer.",
          groqPlaceholder: "Groq API key",
          openaiPlaceholder: "OpenAI API key",
          reveal: "Show key",
          hide: "Hide key",
        },
        model: {
          title: "Model",
          description: "Select transcription model.",
          selectTitle: "Select transcription model",
          recommendedTag: "★ Recommended",
          options: {
            gptTranscribe: "GPT Transcribe — $0.0045/min ($0.27/hr)",
            whisperLargeV3:
              "Whisper Large V3 (Standard) — $0.00185/min ($0.111/hr)",
            whisperLargeV3Turbo:
              "Whisper Large V3 Turbo (Faster) — $0.000667/min ($0.04/hr)",
            qwen3AsrLocal: "Qwen3-ASR 0.6B (on-device) — free, offline",
            nemotron35Local: "Nemotron 3.5 ASR 0.6B (live) — free, offline",
          },
        },
        localModel: {
          title: "Local model",
          statusAbsent: "Not downloaded — about {total} on disk, one-time download.",
          statusPartial: "Download interrupted — you can continue it.",
          statusDownloading: "Downloading… {done} / {total}",
          statusReady: "Ready · {size} on disk",
          statusUnsupported: "Nemotron is not available on this platform.",
          download: "Download model",
          resume: "Resume download",
          cancel: "Cancel download",
          delete: "Delete model",
          deleteConfirm: "Delete the local model? You'll need to download {size} again to use it.",
          deletePartial: "Discard download",
          deletePartialConfirm:
            "Discard the unfinished download and free up the disk space? You can start it again anytime.",
          downloadFailed: "Model download failed: {reason}",
          switchPrompt: "Local model is ready. Switch transcription to the local engine now?",
        },
        localCompute: {
          title: "GPU acceleration",
          selectTitle: "Choose CPU or GPU",
          auto: "Automatic (currently CPU)",
          cpu: "CPU",
          gpu: "GPU (Vulkan)",
          statusCpu:
            "Running on the CPU. A discrete GPU is usually faster; with Intel HD/UHD integrated graphics, stay on the CPU.",
          statusAbsent: "Using the GPU needs a {total} GPU acceleration download.",
          statusDownloading: "Downloading GPU acceleration… {done} / {total}",
          statusReady: "Using {device}.",
          statusNoDevice: "GPU acceleration is installed, but the GPU can't be used right now — still on the CPU. Try updating your graphics driver.",
          statusFellBack: "The GPU failed, so TypeAloud switched to the CPU. It will try the GPU again after a restart.",
          download: "Download GPU acceleration",
          retry: "Retry download",
          cancel: "Cancel download",
          delete: "Remove GPU acceleration",
          deleteConfirm: "Remove GPU acceleration and go back to the CPU? The models stay; only the 33 MB component is deleted.",
          downloadFailed: "GPU acceleration download failed: {reason}",
        },
        saved: "Saved",
        saveError: "Couldn't save — the last change was not kept.",
        permissions: {
          allGranted: "System permissions are in place",
          allGrantedDetail:
            "Microphone and Accessibility are both granted — recording and automatic insertion work.",
          recheck: "Re-check",
          checked: "Checked — all permissions are in place.",
          needsAttention: "Checked — some permissions need attention. See the controls below.",
          checkFailed: "Could not complete the permission check. Please try again.",
        },
        dictionaryLink: {
          title: "Dictionary",
          description:
            "Names, brands and terms that get misspelled, and automatic replacements for words that keep coming out wrong.",
          open: "Edit dictionary",
        },
        about: {
          title: "About",
          reveal: "Show in Finder",
        },
      },
      axCloud: {
        hint: "Drag me into the list",
        close: "Close",
      },
      microphoneAccess: {
        unknown: "Microphone not yet checked",
        granted: "Microphone available",
        denied: "Microphone access blocked",
        unavailable: "No microphone found",
        error: "Microphone check failed — try again",
        check: "Check microphone",
        checking: "Checking microphone…",
        deniedHint: "Allow desktop apps to access the microphone in Windows Settings, then return and check again.",
        settingsFailed: "Could not open Windows microphone settings. Open Privacy & security → Microphone manually.",
      },
      inputPrompt: {
        title: "Voice Input",
        hint: "Hold {record} to dictate",
        starting: "Starting recording...",
        listening: "Listening...",
        lockedHint: "Hands-free · press {record} to finish",
        lockTip: "Tip: double-tap {record} to dictate without holding",
        recording: "Recording",
        cancelled: "Cancelled",
        processing: "Processing...",
        transcribing: "Transcribing audio...",
        recordingWithDuration: "Recording {duration}",
        transcribingCount: "Transcribing ({count})",
        inserting: "Inserting...",
        insertingCount: "Inserting ({count})",
        statusSeparator: " · ",
        noAudio: "No audio captured",
        noSpeech: "No speech detected",
        transcriptionFailed: "Transcription failed - please try again",
        transcriptionFailedReason: "Transcription failed: {reason}",
        transcriptionHungSaved: "Transcription stalled - saved to History to retry",
        recordingInterrupted: "Recording interrupted",
        transcriptionIncompleteTitle: "Transcription incomplete",
        transcriptionIncompleteHint: "Partial text kept. Copy it, or click a field and tap {record}.",
        recoverySavedHint: "Saved to History. Copy it, or click a field and tap {record}.",
        localModelMissingTitle: "Local model is not downloaded yet",
        localModelMissing: "Finish downloading the model to start dictating.",
        openLocalModel: "Open model settings",
        noApiKeyTitle: "API key required",
        noApiKey: "Add your API key in Settings first",
        invalidApiKey: "API key invalid or unauthorized - check Settings",
        recordingFailed: "Recording failed",
        permissionDenied: "Microphone permission denied",
        noMicrophone: "No microphone found",
        microphoneStartupTimeout: "Microphone startup timed out",
        microphoneBusy: "Microphone is busy",
        microphoneUnsupported: "Microphone settings not supported",
        checkMicrophone: "Please check your microphone settings",
        textInserted: "Text inserted",
        insertFailed: "Insertion failed — copy it from History",
        insertFailedTitle: "Insertion failed",
        insertFailedHint: "Click where it goes, then tap {record}",
        copyButton: "Copy",
        copied: "Copied",
        copyFailed: "Copy failed. Try again; your text is still in History.",
      },
    },
    zh: {
      sidebar: {
        home: "首页",
        dictionary: "词典",
        history: "历史",
        settings: "设置",
        help: "帮助",
      },
      home: {
        ready: "随时可以听写",
        setupNeeded: "完成设置后即可开始",
        readyHint: "在任意应用中按住快捷键即可开始讲话",
        setupHint: "补齐下方缺失项后即可使用",
        dictate: "听写",
        readyBadge: "就绪",
        setupBadge: "待设置",
        recentTitle: "最近",
        viewAll: "查看全部",
        noActivity: "暂无最近活动",
        engineLabel: "转写引擎",
        engineLocalQwen: "Qwen",
        engineLocalQwenLarge: "Qwen 1.7B",
        engineCaptionLocalQwenLarge: "Qwen 1.7B 在本机转写，录音不会上传。比 0.6B 慢，通常更准",
        engineMore: "更多",
        engineQwenSize: "千问大小",
        engineAllSettings: "全部引擎设置…",
        engineLocalNemotron: "Nemotron",
        engineRecommended: "推荐",
        engineExperimental: "\u5b9e\u9a8c\u6027",
        engineChecking: "\u68c0\u67e5\u4e2d\u2026",
        engineReadyLocal: "\u672c\u5730",
        engineReadyCloud: "\u4e91\u7aef",
        engineDownloading: "\u4e0b\u8f7d\u4e2d\u2026",
        engineDownloadProgress: "\u4e0b\u8f7d\u4e2d \u00b7 {percent}%",
        engineNeedsDownload: "\u9700\u8981\u4e0b\u8f7d",
        engineNeedsSetup: "\u9700\u8981\u914d\u7f6e",
        engineCaptionLocalQwen: "Qwen 在本机转写，录音不会上传",
        engineCaptionLocalNemotron: "Nemotron 在本机运行，边说边出字",
        engineCaptionGroq: "云端转写，使用你的 Groq API Key",
        engineCaptionOpenai: "云端转写，使用你的 OpenAI API Key",
      },
      readiness: {
        apiKey: "API Key",
        microphone: "麦克风",
        accessibility: "辅助功能",
        addApiKey: "添加 API Key",
        localModel: "本地模型",
        engine: "转写引擎",
        axGuide: {
          title: "允许 TypeAloud 使用辅助功能",
          lead: "macOS 需要这项权限，TypeAloud 才能做到这两件事：",
          useInsert: "把听写好的文字直接输入到你正在用的应用里",
          useHotkey: "在任意应用中响应“按住说话”快捷键",
          privacy:
            "这项权限只用来响应快捷键和输入文字。TypeAloud 不会记录你的按键，也不会监控其他应用。",
          open: "打开辅助功能设置",
          waiting: "等待授权中…",
          waitingHint: "在系统设置里打开 TypeAloud 旁边的开关，授权后这里会自动继续。",
          retryHint: "还没检测到授权。请在辅助功能列表中打开 TypeAloud，或再试一次。",
          revealApp: "在 Finder 中显示 TypeAloud",
          revealHint: "列表里找不到 TypeAloud？把它从 Finder 拖进列表即可（等同于点 +）。",
        },
      },
      onboarding: {
        start: "开始",
        next: "下一步",
        back: "上一步",
        skip: "先跳过",
        skipStep: "暂时跳过这一步",
        finish: "完成",
        resume: "继续设置向导",
        welcome: {
          title: "说话，就是打字",
          lead: "在任何应用里，按住快捷键开口说，松手，文字就出现在光标处。",
          holdTitle: "按住 {keys}",
          holdDesc: "在任意输入框里",
          speakTitle: "开口说话",
          speakDesc: "说完直接松手",
          insertTitle: "文字上屏",
          insertDesc: "自动输入到光标处",
        },
        privacy: {
          title: "本地听写，声音留在本机",
          lead: "使用本地模型，语音在这台电脑上转成文字，无需上传音频。",
          noAccount: "本地听写无需注册账号",
          offline: "模型下载一次，即可离线听写",
          line2: "历史记录只保存在这台电脑上",
          usageTitle: "发送匿名使用统计",
          usageDesc:
            "每天一次：听写了几次、多少字，用的哪个引擎、软件和系统版本。不含录音、文字，也没有能认出你的信息。随时可以在设置里关掉。",
        },
        mic: {
          title: "先让 TypeAloud 听到你",
          lead: "只在你按住快捷键时录音，松手即停。",
          enable: "启用麦克风",
          enableHint: "系统会询问是否允许使用麦克风，允许后即可继续。",
          granted: "麦克风已就绪",
          denied: "麦克风被拒绝了。请在 系统设置 → 隐私与安全性 → 麦克风 里打开 TypeAloud，授权后这里会自动继续。",
          unknown: "还没实际录过音",
          openSettings: "打开麦克风设置",
        },
        ax: {
          title: "让 TypeAloud 为你输入文字",
          granted: "辅助功能已就绪",
        },
        key: {
          title: "连接你的转写服务",
          lead: "云端转写要用你自己的 API Key，产生的费用由 Groq 或 OpenAI 直接收取。",
          leadCloudDefault: "这台电脑的内存或 CPU 核心较少，默认使用 OpenAI；也可以选择本地的 Qwen。",
          cloudDefault: "这台电脑默认使用云端，以免本地转写过慢。",
          localDescription: "在这台电脑上转写，无需注册账号。",
          localKind: "本地模型",
          cloudKind: "云端服务",
          cloudNotice: "听写录音将发送至 {provider} 转写，使用你自己的 API Key。",
          localSlow: "本地转写在这台电脑上可能很慢。",
          more: "更多选项 ▸",
          moreHide: "收起更多选项 ▾",
          cloudSetup: "点击选择，然后填写 API Key。",
          keyLabel: "{provider} API Key",
          downloadProgress: "下载中 {percent}%",
          downloadMissing: "未下载",
          downloadReady: "就绪",
          downloadFailed: "下载失败——点击重试",
          otherDownloading: "另一个模型正在下载，请先在设置中完成或取消。",
          titleLocalFirst: "选择转写引擎",
          leadLocalFirst: "选择免费、离线的本地听写，或使用自己的 API Key 连接 OpenAI。",
          localNemotronName: "本地 · Nemotron 3.5 ASR",
          localQwenName: "本地 · Qwen3-ASR",
          localRecommendedTag: "推荐 · 免费 · 离线",
          localOfflineTag: "免费 · 离线",
          localAbsent: "一次性下载约 {total}——点击选择并下载。",
          localResume: "下载中断了，点击继续下载。",
          localDownloading: "下载中… {done} / {total}。可以先继续后面的设置，稍后自动完成。",
          localReady: "已下载就绪——点击启用本地引擎。",
          localSelected: "已选中，听写在这台电脑上完成。",
          localError: "下载失败：{reason}点击重试。",
          cloudToggle: "或连接云端服务（Groq / OpenAI）▸",
          cloudToggleHide: "收起云端选项 ▾",
          groqDesc: "使用你自己的 Groq API Key，用量上限由你的 Groq 账户决定。",
          openaiDesc: "使用你自己的 OpenAI API Key，按量付费。",
          placeholderGroq: "粘贴你的 Groq API Key（gsk_…）",
          placeholderOpenai: "粘贴你的 OpenAI API Key（sk-…）",
          save: "保存",
          saved: "已保存 ✓",
          getKeyGroq: "还没有 API Key？打开 console.groq.com 免费创建（约 1 分钟）。",
          getKeyOpenai: "还没有 API Key？打开 platform.openai.com 创建。",
          configured: "这个服务已经填过 API Key，可以直接继续。",
          error: "保存失败：{message}",
        },
        try: {
          engineReady: "引擎就绪",
          micUnchecked: "麦克风尚未验证",
          historyHint: "文字没出现在这里？去历史记录查看或复制。",
          historyFallback: "结果已经存进历史记录，但这里没出现文字。可以去历史记录里查看或复制。",
          success: "文字收到了！在其他应用中也可以这样使用快捷键。",
          title: "就绪！说你的第一句话",
          lead: "以后在任何应用里，都是同样的动作。",
          placeholder: "把光标放在这里，按住 {keys} 说：今天天气不错",
          hint: "按住 {keys} 说话 → 松手 → 文字出现在这里",
        },
        tryPending: {
          title: "还差一点",
          lead: "补齐下面几项就能用了；也可以先进入主界面，首页会提醒你还差哪几项。",
        },
      },
      update: {
        checkShort: "检查更新",
        checkingShort: "检查中…",
        downloadingShort: "下载 {version}",
        restartShort: "重启更新",
        readyTitle: "{version} 已下好，重启即可用上",
        cardTitle: "{version} 已经下好了",
        cardHint: "不会自动重启，你方便的时候再点。",
        whatsNew: "看看改了什么",
        restart: "重启更新",
      },
      history: {
        title: "历史",
        subtitle: "你最近的转写记录",
        search: "搜索",
        clearAll: "清空",
        confirmClear: "再次点击以确认",
        empty: "暂无历史记录",
        noResults: "无匹配结果",
        today: "今天",
        yesterday: "昨天",
      },
      dictionary: {
        title: "词典",
        subtitle: "添加容易被写错的人名、品牌和术语，让转写把它们写对。",
        wordsTitle: "词汇",
        wordsDesc: "转写出来拼得差不多的词，会按你在这里写的样子改过来。",
        placeholder: "输入一个词，按回车添加",
        replaceTitle: "自动替换",
        replaceDesc: "某个词总被写错？填上它被写成了什么、应该是什么，以后就会自动改过来。所有引擎都有效。",
        replaceHeard: "被写成，例如 cloud code",
        replaceWanted: "应该是，例如 Claude Code",
        replaceAdd: "添加",
        replaceRemove: "删除 {heard} → {wanted}",
        remove: "删除 {entry}",
        saved: "已保存",
        count: "{count} 个词条",
        countOne: "1 个词条",
        aboutTitle: "词典怎么起作用",
        aboutWhat: "输入一个词按回车添加，也可以粘贴一串用逗号隔开的词。改动会自动保存。",
        aboutHow: "用云端引擎转写时，这些词会一起发给模型作参考。加进来的词更容易写对，但不保证每次都对。",
        localNote: "本地引擎没法提前参考这些词。转写完成后，如果某个词只差一两个字母，或者只是大小写、空格不一样，会自动改成你写的样子。如果它被写成了别的正常单词，就需要加一条自动替换。",
        punctuationTitle: "中文标点自动优化",
        punctuationDesc: "用 Whisper 转写中文时，TypeAloud 会把下面这句示例一起发给模型，帮它加上标点。这句话是固定的，不含你的任何信息；GPT 模型和其他语言不会用到。",
        saveError: "保存词典出错：{message}",
      },
      activity: {
        retryErrors: {
          historyRead: "无法读取历史记录，请重试。",
          entryMissing: "这条历史记录已不存在。",
          notPending: "这条记录已无法重新转写。",
          audioMissing: "这条记录的录音已不可用。",
          audioRead: "无法读取录音，请重试。",
          settingsRead: "无法读取设置，请重试。",
          resultSave: "无法保存重试结果，请重试。",
          audioFormat: "本地引擎无法读取此录音格式，请在设置中切换到云端引擎后重试。",
          noSpeech: "未检测到语音",
          captureIncomplete: "录音不完整，已保存录到的部分，可以重新转写。",
        },
        copyTitle: "复制文本",
        deleteTitle: "删除",
        playTitle: "播放录音（调试）",
        pendingAudio: "转写卡住了，点击重试",
        pendingHint: "录音还在，可以点击重试。",
        retranscribeTitle: "重新转写",
        retranscribeFailed: "重新转写失败，请再试一次",
        retranscribeFailedReason: "重新转写失败：{reason}",
      },
      settings: {
        title: "设置 - TypeAloud",
        pageTitle: "设置",
        pageSubtitle: "设置会自动保存。",
        tabsAria: "设置分类",
        modelSingleHint: "云端转写，按音频时长计费。",
        modelMultipleHint: "价格为美元。Groq 每次请求至少按 10 秒计费。",
        modelOpenaiPrice: "US$0.0045/分钟 · US$0.27/音频小时",
        modelOpenaiDetail: "准确率高，支持多种语言。",
        modelTurboPrice: "US$0.04/音频小时",
        modelTurboDetail: "速度更快，费用更低。",
        modelV3Price: "US$0.111/音频小时 · 约 2.8 倍费用",
        modelV3Detail: "速度较慢。Groq 公布的测试中识别错误更少，实际效果取决于你的录音。",
        advanced: "高级设置",
        section: {
          dictation: "听写设置",
          app: "应用设置",
        },
        recordingShortcut: {
          title: "录音快捷键",
          description:
            "按住这个快捷键说话，松手结束。",
          selectTitle: "选择录音快捷键",
        },
        accessibility: {
          title: "辅助功能权限",
          description: "用于全局快捷键和自动输入文字。",
          granted: "✅ 已授予辅助功能权限",
          notRequired: "✅ 此平台无需权限",
          denied: "❌ 尚未获得辅助功能权限",
          rechecking: "重新检查中...",
        },
        microphone: {
          title: "麦克风权限",
          description: "TypeAloud 需要麦克风来录音。",
        },
        permission: {
          checking: "检查中...",
          granted: "✅ 已授权",
          notDetermined: "尚未请求麦克风权限",
          denied: "❌ 已拒绝 — 请在系统设置中开启",
          restricted: "❌ 受系统策略限制",
          error: "❌ 检查权限出错",
        },
        checkPermission: "检查权限",
        uiLanguage: {
          title: "界面语言",
          description: "选择应用界面显示语言。",
          selectTitle: "选择界面语言",
          auto: "跟随系统",
          english: "English",
          chinese: "中文",
        },
        theme: {
          title: "主题风格",
          description: "浅色、深色，或跟随系统外观。",
          selectTitle: "选择界面主题",
          option: {
            auto: "跟随系统",
            midnight: "深色",
            elegant: "浅色",
          },
        },
        transcriptionLanguage: {
          title: "听写语言",
          description: "选择你说话用的语言，也可以自动识别。",
          auto: "自动检测",
          selectTitle: "选择听写语言",
          localNote:
            "Qwen 会自动识别语言，用不上这项设置。",
          groupCommon: "常用",
          groupAll: "全部语言",
        },
        removeFillerWords: {
          title: "去掉语气词",
          description: "删掉停顿时的「嗯」「呃」，「啊」「呀」这类带语气的字会保留。",
        },
        mergeSpelledLetters: {
          title: "自动合并拼读字母",
          description: "把一个个分开念的字母连起来，例如 A P I → API。",
        },
        autoLaunch: {
          title: "开机自启",
          description: "电脑启动时自动运行 TypeAloud。",
          aria: "开机自启",
        },
        startMinimized: {
          title: "启动时最小化",
          description: "每次启动都不显示主窗口，只在后台运行，快捷键照常可用。",
          aria: "启动时最小化",
        },
        updates: {
          title: "软件更新",
          description: "新版本会在后台自动下载，什么时候重启由你决定。",
          check: "检查更新",
          restart: "重启并更新",
          checking: "正在检查…",
          downloading: "正在下载 v{version}…",
          ready: "v{version} 已就绪 — 重启即可更新",
          upToDate: "v{version} — 已是最新",
          error: "检查更新失败，请稍后再试。",
          storeManaged: "v{version} — 由 Microsoft Store 自动更新",
        },
        usageStats: {
          title: "匿名使用统计",
          description: "每天发送一次：听写了几次、多少字，用的哪个引擎、软件和系统版本。不含录音和文字。关闭后，还没发出的统计也会一并删除。",
          previewTitle: "查看发送的内容",
          previewDescription: "下一次上传的原始内容，包括今天到目前为止的计数。",
          previewAria: "使用统计预览",
          previewOff: "统计已关闭，不记录也不发送。",
          previewEmpty: "还没有记录。",
          previewLoaded: "{count} 条 · {size}。今天这条明天发出。",
        },
        diagnostics: {
          title: "\u8bca\u65ad\u65e5\u5fd7",
          description: "\u67e5\u770b\u5e76\u590d\u5236\u7528\u4e8e\u6392\u67e5\u6027\u80fd\u95ee\u9898\u7684\u672c\u673a\u65e5\u5fd7\u3002",
          refresh: "\u5237\u65b0",
          copy: "\u590d\u5236\u5168\u90e8",
          contentAria: "\u8bca\u65ad\u65e5\u5fd7\u5185\u5bb9",
          loading: "\u6b63\u5728\u52a0\u8f7d\u65e5\u5fd7\u2026",
          empty: "\u76ee\u524d\u6ca1\u6709\u53ef\u7528\u7684\u8bca\u65ad\u65e5\u5fd7\u3002",
          loaded: "{size} \u00b7 \u66f4\u65b0\u4e8e {time}",
          truncated: "\u4ec5\u663e\u793a\u6700\u65b0 {size} \u00b7 \u66f4\u65b0\u4e8e {time}",
          loadError: "\u65e0\u6cd5\u8bfb\u53d6\u65e5\u5fd7\uff1a{message}",
          copied: "\u5df2\u590d\u5236\u5230\u526a\u8d34\u677f",
          copyError: "\u65e0\u6cd5\u590d\u5236\u65e5\u5fd7\uff1a{message}",
        },
        apiProvider: {
          title: "转写服务",
          description: "选择云端服务或本地引擎。",
          selectTitle: "选择转写服务",
          localQwenLarge: "本地 · Qwen3-ASR 1.7B",
          localNemotron: "本地 · Nemotron 3.5 ASR",
          localQwen: "本地 · Qwen3-ASR · ★ 推荐",
        },
        nemotronLatency: {
          title: "Nemotron 出字速度",
          description: "选择出字更快，还是识别更准。",
          selectTitle: "选择 Nemotron 出字速度",
          balanced: "出字更快",
          accuracy: "识别更准",
        },
        engine: {
          active: "正在使用",
          activeModel: "正在使用 · {model}",
          whisperLarge: "Whisper Large V3",
          whisperTurbo: "Whisper Large V3 Turbo",
          gptTranscribe: "GPT Transcribe",
          details: "查看 {model} 详情",
          notReadyKey: "尚未启用。填好 API Key 后，再点一次 {model} 即可切换。",
          notReadyDownload: "尚未启用。模型下载完成后，再点一次 {model} 即可切换。",
          switchFailed: "引擎未更改。",
          invalidModel: "请选择可用的模型。",
          keyRequired: "使用这个模型前，请先填写 API Key。",
          cloudNotice: "使用此云端模型会将听写录音上传至对应服务商。",
          recommended: "推荐",
          experimental: "实验性",
          localQwenLarge: {
            name: "Qwen3-ASR 1.7B",
          },
          localQwen: {
            name: "Qwen3-ASR 0.6B",
          },
          qwen: {
            name: "Qwen3-ASR",
            description: "在这台电脑上转写，录音不上传。有 0.6B 和 1.7B 两种大小。",
          },
          more: "更多引擎",
          qwenSize: {
            label: "大小",
            smallNote: "更快",
            largeNote: "通常更准",
            download: "下载",
            memory: "内存",
            wait: "说 15 秒松手后等",
            waitValue: "约 {seconds} 秒",
            waitUnknown: "用几次后显示",
            inUse: "正在使用",
            ready: "已下载",
            downloading: "下载中 {percent}%",
            absent: "未下载",
            suggest: "这台电脑速度够快，可以用 1.7B，识别通常更准。下载期间照常用 0.6B，下完自动换上。",
            suggestAction: "下载 1.7B（约 2.5 GB）",
            slow: "1.7B 在这台电脑上偏慢：说 15 秒的话，松手后要等约 {seconds} 秒。0.6B 更快。",
            slowAction: "换回 0.6B",
          },
          groq: {
            name: "Groq",
            description: "最快的云端 Whisper。录音会上传到 Groq。",
          },
          openai: {
            name: "OpenAI",
            description: "中文标点表现较好（gpt-transcribe）。录音会上传到 OpenAI。",
          },
          localNemotron: {
            name: "Nemotron 3.5 ASR",
            description: "边说边出字，但识别准确率明显低于 Qwen。",
          },
          status: {
            ready: "已就绪",
            downloading: "下载中",
            needsDownload: "需下载",
            needsKey: "需要 API Key",
            keySet: "已填 API Key",
            local: "本机运行",
          },
        },
        apiKey: {
          title: "API Key",
          description: "只保存在这台电脑上。",
          groqPlaceholder: "Groq API Key",
          openaiPlaceholder: "OpenAI API Key",
          reveal: "显示 API Key",
          hide: "隐藏 API Key",
        },
        model: {
          title: "模型",
          description: "选择转写模型。",
          selectTitle: "选择转写模型",
          recommendedTag: "★ 推荐",
          options: {
            gptTranscribe: "GPT Transcribe — $0.0045/分钟 ($0.27/小时)",
            whisperLargeV3:
              "Whisper Large V3（标准） — $0.00185/分钟 ($0.111/小时)",
            whisperLargeV3Turbo:
              "Whisper Large V3 Turbo（更快） — $0.000667/分钟 ($0.04/小时)",
            qwen3AsrLocal: "Qwen3-ASR 0.6B（本地）— 免费、离线",
            nemotron35Local: "Nemotron 3.5 ASR 0.6B（实时）— 免费、离线",
          },
        },
        localModel: {
          title: "本地模型",
          statusAbsent: "未下载 — 磁盘占用约 {total}，一次性下载。",
          statusPartial: "下载中断，可以继续下载。",
          statusDownloading: "下载中… {done} / {total}",
          statusReady: "已就绪 · 磁盘占用 {size}",
          statusUnsupported: "Nemotron 在当前平台不可用。",
          download: "下载模型",
          resume: "继续下载",
          cancel: "取消下载",
          delete: "删除模型",
          deleteConfirm: "删除本地模型？以后再用需要重新下载 {size}。",
          deletePartial: "删除未完成的下载",
          deletePartialConfirm: "删除未完成的下载文件、释放磁盘空间？随时可以重新开始下载。",
          downloadFailed: "模型下载失败：{reason}",
          switchPrompt: "本地模型已就绪。现在切换到本地转写引擎吗？",
        },
        localCompute: {
          title: "显卡加速",
          selectTitle: "选择用 CPU 还是显卡",
          auto: "自动（当前为 CPU）",
          cpu: "CPU",
          gpu: "显卡（Vulkan）",
          statusCpu:
            "当前用 CPU 运行。有独立显卡的话通常更快；如果是 Intel HD／UHD 集成显卡，建议继续用 CPU。",
          statusAbsent: "使用显卡前，需要下载 {total} 的显卡加速组件。",
          statusDownloading: "正在下载显卡加速组件… {done} / {total}",
          statusReady: "正在使用 {device}。",
          statusNoDevice: "显卡加速组件已安装，但暂时用不了显卡，当前仍用 CPU。可以试试更新显卡驱动。",
          statusFellBack: "显卡运行失败，已改用 CPU。重启 TypeAloud 后会再试显卡。",
          download: "下载显卡加速组件",
          retry: "重新下载",
          cancel: "取消下载",
          delete: "删除显卡加速组件",
          deleteConfirm: "删除显卡加速组件并改回 CPU？模型会保留，只删除这 33 MB 的组件。",
          downloadFailed: "显卡加速组件下载失败：{reason}",
        },
        saved: "已保存",
        saveError: "没能保存——刚才那次改动没生效。",
        permissions: {
          allGranted: "系统权限齐了",
          allGrantedDetail: "麦克风、辅助功能都已授权——录音和自动输入文字都能用。",
          recheck: "重新检查",
          checked: "已检查，所有权限正常。",
          needsAttention: "已检查，部分权限需要处理，请查看下方设置。",
          checkFailed: "未能完成权限检查，请重试。",
        },
        dictionaryLink: {
          title: "词典",
          description: "添加容易被写错的人名、品牌和术语，或者设置自动替换。",
          open: "编辑词典",
        },
        about: {
          title: "关于",
          reveal: "在 Finder 中显示",
        },
      },
      axCloud: {
        hint: "把我拖进列表",
        close: "关闭",
      },
      microphoneAccess: {
        unknown: "麦克风尚未检查",
        granted: "麦克风可用",
        denied: "无法访问麦克风",
        unavailable: "未找到麦克风",
        error: "麦克风检查失败，请重试",
        check: "检查麦克风",
        checking: "正在检查麦克风…",
        deniedHint: "请在 Windows 设置中允许桌面应用访问麦克风，然后返回重新检查。",
        settingsFailed: "无法打开 Windows 麦克风设置，请手动前往“隐私和安全性 → 麦克风”。",
      },
      inputPrompt: {
        title: "语音输入",
        hint: "按住 {record} 进行听写",
        starting: "正在开始录音...",
        listening: "正在聆听...",
        lockedHint: "免按住录音中，按一下 {record} 结束",
        lockTip: "下次可以双击 {record}，不用一直按着",
        recording: "录音中",
        cancelled: "已取消",
        processing: "处理中...",
        transcribing: "正在转写...",
        recordingWithDuration: "录音中 {duration}",
        transcribingCount: "转写中（{count}）",
        inserting: "正在输入文字...",
        insertingCount: "正在输入文字（{count}）",
        statusSeparator: " · ",
        noAudio: "没有录到声音",
        noSpeech: "未检测到语音",
        transcriptionFailed: "转写失败，请重试",
        transcriptionFailedReason: "转写失败：{reason}",
        transcriptionHungSaved: "转写卡住了，已存到历史记录，可以重试",
        recordingInterrupted: "\u5f55\u97f3\u5df2\u4e2d\u65ad",
        transcriptionIncompleteTitle: "转写未完成",
        transcriptionIncompleteHint: "已保留部分文字，可复制，或点输入框后轻按 {record}",
        recoverySavedHint: "已存到历史记录，可复制，或点输入框后轻按 {record}",
        localModelMissingTitle: "本地模型还没下载好",
        localModelMissing: "下载完成后即可开始听写。",
        openLocalModel: "打开模型设置",
        noApiKeyTitle: "需要 API Key",
        noApiKey: "请先在设置中填写 API Key",
        invalidApiKey: "API Key 无效或未授权，请检查设置",
        recordingFailed: "录音失败",
        permissionDenied: "麦克风权限被拒绝",
        noMicrophone: "未发现麦克风",
        microphoneStartupTimeout: "\u9ea6\u514b\u98ce\u542f\u52a8\u8d85\u65f6",
        microphoneBusy: "麦克风正被占用",
        microphoneUnsupported: "麦克风设置不受支持",
        checkMicrophone: "请检查麦克风设置",
        textInserted: "文字已输入",
        insertFailed: "文字未能输入，可以到历史记录里复制",
        insertFailedTitle: "文字未能输入",
        insertFailedHint: "点一下要输入的地方，再轻按 {record}",
        copyButton: "复制",
        copied: "已复制",
        copyFailed: "复制失败，请重试；文字仍保存在历史记录中。",
      },
    },
  };

  const fallbackLanguage = "en";
  let currentLanguage = fallbackLanguage;

  function getNestedValue(source, key) {
    if (!source || typeof key !== "string") {
      return undefined;
    }
    return key.split(".").reduce((acc, part) => {
      if (!acc || typeof acc !== "object") {
        return undefined;
      }
      return acc[part];
    }, source);
  }

  function formatTemplate(value, vars = {}) {
    if (typeof value !== "string") {
      return value;
    }
    return value.replace(/\{(\w+)\}/g, (match, key) => {
      const replacement = vars[key];
      return replacement === undefined || replacement === null
        ? match
        : String(replacement);
    });
  }

  function detectSystemLanguage() {
    const lang = (navigator.languages && navigator.languages[0]) || navigator.language || "";
    if (lang && lang.toLowerCase().startsWith("zh")) {
      return "zh";
    }
    return "en";
  }

  function resolveLanguage(value) {
    if (!value || typeof value !== "string" || value === "auto") {
      return detectSystemLanguage();
    }
    const normalized = value.toLowerCase();
    if (normalized.startsWith("zh")) {
      return "zh";
    }
    return "en";
  }

  function setLanguage(value) {
    currentLanguage = resolveLanguage(value);
    setDocumentLanguage(currentLanguage);
    return currentLanguage;
  }

  function getLanguage() {
    return currentLanguage;
  }

  function t(key, vars) {
    const langPack = translations[currentLanguage] || translations[fallbackLanguage];
    const fallbackPack = translations[fallbackLanguage];
    const value =
      getNestedValue(langPack, key) ?? getNestedValue(fallbackPack, key) ?? key;
    return formatTemplate(value, vars);
  }

  function applyI18n(root = document) {
    if (!root || !root.querySelectorAll) {
      return;
    }
    root.querySelectorAll("[data-i18n]").forEach((element) => {
      const key = element.getAttribute("data-i18n");
      if (!key) {
        return;
      }
      const value = t(key);
      const attr = element.getAttribute("data-i18n-attr");
      if (attr) {
        attr
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
          .forEach((name) => {
            element.setAttribute(name, value);
          });
      } else {
        element.textContent = value;
      }
    });
  }

  function setDocumentLanguage(lang) {
    if (!document || !document.documentElement) {
      return;
    }
    const htmlLang = lang === "zh" ? "zh-CN" : "en";
    document.documentElement.setAttribute("lang", htmlLang);
  }

  function initI18n(preferredLanguage) {
    const resolved = setLanguage(preferredLanguage);
    applyI18n(document);
    return resolved;
  }

  function getLocale() {
    return currentLanguage === "zh" ? "zh-CN" : "en-US";
  }

  // Persistent History text/error codes: keep translations for retired codes.
  // Renaming a code requires a data migration, not just editing this lookup.
  function localizeRetryError(reason) {
    const keys = {
      RETRY_HISTORY_READ: "historyRead",
      RETRY_ENTRY_MISSING: "entryMissing",
      RETRY_NOT_PENDING: "notPending",
      RETRY_AUDIO_MISSING: "audioMissing",
      RETRY_AUDIO_READ: "audioRead",
      RETRY_SETTINGS_READ: "settingsRead",
      RETRY_RESULT_SAVE: "resultSave",
      RETRY_AUDIO_FORMAT: "audioFormat",
      RETRY_NO_SPEECH: "noSpeech",
      RETRY_CAPTURE_INCOMPLETE: "captureIncomplete",
    };
    const key = Object.hasOwn(keys, reason) ? keys[reason] : null;
    return key ? t(`activity.retryErrors.${key}`) : reason;
  }

  window.TypeAloudI18n = {
    localizeRetryError,
    initI18n,
    setLanguage,
    getLanguage,
    resolveLanguage,
    applyI18n,
    t,
    getLocale,
  };

  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-i18n-ready", "1");
  }
})();
