// Native Liquid Glass hookup (macOS). The backend says whether this window has a
// native glass backdrop; only then does the page add html.native-glass and let the
// glass show through its own surfaces. See src-tauri/src/glass.rs.
//
// The glass views live below the webview, so they cannot follow CSS on their own.
// A page with separate glass surfaces (the recording prompt) registers them with
// NativeGlass.track(), and every change to their box or opacity is reported back.
(function () {
  if (window.NativeGlass) {
    return;
  }

  const bridge = window.__TYPEALOUD_IPC__;
  const html = document.documentElement;
  // main always has a backdrop on macOS (glass, or vibrancy before macOS 26): set
  // the class before first paint so the Overlay title bar padding never jumps.
  const optimistic = /Macintosh/.test(navigator.userAgent) && /main\.html$/.test(location.pathname);
  if (optimistic) {
    html.classList.add("native-glass");
  }

  let enabled = false;
  let surfaces = [];
  let lastSent = "";
  let frame = 0;

  const ready = (bridge ? bridge.invoke("get-native-glass") : Promise.resolve(false))
    .catch(() => false)
    .then((on) => {
      enabled = !!on;
      html.classList.toggle("native-glass", enabled);
      if (enabled) {
        syncAppearance();
        new MutationObserver(syncAppearance).observe(html, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        startTracking();
      }
      return enabled;
    });

  function syncAppearance() {
    const theme = html.getAttribute("data-theme");
    if (theme) {
      bridge.invoke("set-glass-appearance", theme !== "elegant").catch(() => {});
    }
  }

  function regionFor(surface) {
    const style = getComputedStyle(surface.element);
    const rect = surface.element.getBoundingClientRect();
    const visible = style.display !== "none" && style.visibility !== "hidden";
    return {
      id: surface.id,
      x: Math.round(rect.left * 2) / 2,
      y: Math.round(rect.top * 2) / 2,
      width: visible ? Math.round(rect.width * 2) / 2 : 0,
      height: visible ? Math.round(rect.height * 2) / 2 : 0,
      radius: parseFloat(style.borderTopLeftRadius) || 0,
      opacity: visible ? Math.round(parseFloat(style.opacity) * 100) / 100 : 0,
    };
  }

  function send() {
    const regions = surfaces.map(regionFor);
    const payload = JSON.stringify(regions);
    if (payload === lastSent) {
      return;
    }
    lastSent = payload;
    bridge.invoke("set-glass-regions", regions).catch(() => {});
  }

  function transitioning() {
    return surfaces.some((surface) =>
      surface.element.getAnimations().some(
        (animation) => typeof CSSTransition !== "undefined"
          && animation instanceof CSSTransition
          && animation.playState === "running"
      )
    );
  }

  // Follows a CSS transition frame by frame, then stops; infinite decorative
  // animations (breathe, mic glow) never move a surface's box, so they are ignored.
  function schedule() {
    if (frame) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = 0;
      send();
      if (transitioning()) {
        schedule();
      }
    });
  }

  function startTracking() {
    if (!surfaces.length) {
      return;
    }
    const resize = new ResizeObserver(schedule);
    surfaces.forEach((surface) => resize.observe(surface.element));
    document.addEventListener("transitionrun", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    document.addEventListener("transitioncancel", schedule, true);
    window.addEventListener("resize", schedule);
    // Not subtree: the wave bars restyle every audio frame and never move a surface.
    const mutations = new MutationObserver(schedule);
    [document.body, ...surfaces.map((surface) => surface.element)].forEach((element) => {
      mutations.observe(element, { attributes: true, attributeFilter: ["class", "hidden", "style"] });
    });
    schedule();
  }

  window.NativeGlass = {
    ready,
    // Register the page's glass surfaces: [{ id, element }]. Call once at startup.
    track(list) {
      surfaces = list.filter((surface) => surface.element);
      if (enabled) {
        startTracking();
      }
    },
  };
})();
