//! Native Liquid Glass backdrops (macOS 26+).
//!
//! Every glass surface is an `NSGlassEffectView` placed directly below the WKWebView, so it
//! shows wherever the page leaves its own background transparent (`html.native-glass` in CSS).
//!
//! - `main` gets one view filling the window, under the transparent sidebar. Before macOS 26
//!   it falls back to Tauri's sidebar vibrancy material.
//! - `input-prompt` is a transparent 460x244 canvas around a 360x80 card and a transcription
//!   bubble that animate on their own, so a whole-window effect would be the wrong shape. The
//!   page reports each surface's rect and opacity (`set_glass_regions`) and this module keeps
//!   one view per surface in step with it. Without Liquid Glass the prompt keeps its CSS look.
//!
//! The glass's light/dark appearance is set per view from the app theme, never on the window:
//! a window appearance would also pin the webview's `prefers-color-scheme` and break the
//! "auto" theme.

use serde::Deserialize;

/// One glass surface of a window, in CSS pixels relative to the webview's top-left corner.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlassRegion {
  pub id: String,
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  pub radius: f64,
  pub opacity: f64,
}

/// Whether this window's page should drop its opaque surfaces for a native backdrop.
pub fn has_native_backdrop(label: &str) -> bool {
  match label {
    "main" => cfg!(target_os = "macos"),
    "input-prompt" => imp::liquid_glass_available(),
    _ => false,
  }
}

pub fn install_main_backdrop(window: &tauri::WebviewWindow) {
  imp::install_main_backdrop(window);
}

pub fn set_regions(window: &tauri::WebviewWindow, regions: Vec<GlassRegion>) -> Result<(), String> {
  imp::set_regions(window, regions)
}

pub fn set_appearance(window: &tauri::WebviewWindow, dark: bool) -> Result<(), String> {
  imp::set_appearance(window, dark)
}

#[cfg(target_os = "macos")]
mod imp {
  use std::cell::RefCell;
  use std::collections::HashMap;

  use objc2::rc::Retained;
  use objc2::MainThreadMarker;
  use objc2_app_kit::{
    NSAppKitVersionNumber, NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua,
    NSAppearanceNameDarkAqua, NSAutoresizingMaskOptions, NSGlassEffectView,
    NSGlassEffectViewStyle, NSView, NSWindow, NSWindowOrderingMode,
  };
  use objc2_foundation::{NSPoint, NSRect, NSSize};
  use tauri::window::{Color, Effect, EffectsBuilder};

  use super::GlassRegion;

  /// First AppKit release with NSGlassEffectView (macOS 26.0). Referencing the class on an
  /// older system would abort, so every path checks this first.
  const MIN_APPKIT_VERSION_LIQUID_GLASS: f64 = 2685.0;

  /// Region id of the main window's full-size view; page-reported ids never collide with it
  /// because only the prompt reports regions.
  const WINDOW_REGION: &str = "window";

  // AppKit objects are main-thread only, and every access below runs inside `with_webview`,
  // which Tauri executes on the main thread.
  thread_local! {
    static VIEWS: RefCell<HashMap<(String, String), Retained<NSGlassEffectView>>> =
      RefCell::new(HashMap::new());
    static DARK: RefCell<HashMap<String, bool>> = RefCell::new(HashMap::new());
  }

  pub fn liquid_glass_available() -> bool {
    unsafe { NSAppKitVersionNumber >= MIN_APPKIT_VERSION_LIQUID_GLASS }
  }

  pub fn install_main_backdrop(window: &tauri::WebviewWindow) {
    // Clears both the NSWindow background and the WKWebView's own (drawsBackground).
    if let Err(error) = window.set_background_color(Some(Color(0, 0, 0, 0))) {
      log::warn!("glass: main transparent background failed: {error}");
      return;
    }

    if !liquid_glass_available() {
      let effects = EffectsBuilder::new().effect(Effect::Sidebar).build();
      if let Err(error) = window.set_effects(effects) {
        log::warn!("glass: main vibrancy fallback failed: {error}");
      }
      return;
    }

    let label = window.label().to_string();
    let result = window.with_webview(move |webview| {
      let Some(mtm) = MainThreadMarker::new() else {
        return;
      };
      let ns_window = unsafe { &*(webview.ns_window() as *const NSWindow) };
      // The glass samples what is behind the window, which needs a non-opaque window.
      ns_window.setOpaque(false);

      let web_view = unsafe { &*(webview.inner() as *const NSView) };
      let Some(container) = (unsafe { web_view.superview() }) else {
        return;
      };
      let view = glass_view(mtm, &label, WINDOW_REGION);
      view.setFrame(container.bounds());
      view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
      );
      container.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, Some(web_view));
    });
    if let Err(error) = result {
      log::warn!("glass: main backdrop failed: {error}");
    }
  }

  pub fn set_regions(window: &tauri::WebviewWindow, regions: Vec<GlassRegion>) -> Result<(), String> {
    if !liquid_glass_available() {
      return Ok(());
    }

    let label = window.label().to_string();
    window
      .with_webview(move |webview| {
        let Some(mtm) = MainThreadMarker::new() else {
          return;
        };
        let web_view = unsafe { &*(webview.inner() as *const NSView) };
        let Some(container) = (unsafe { web_view.superview() }) else {
          return;
        };

        VIEWS.with(|views| {
          views.borrow_mut().retain(|(owner, id), view| {
            let keep = owner != &label || regions.iter().any(|region| &region.id == id);
            if !keep {
              view.removeFromSuperview();
            }
            keep
          });
        });

        let host = web_view.frame();
        let flipped = container.isFlipped();
        for region in &regions {
          let view = glass_view(mtm, &label, &region.id);
          let attached = unsafe { view.superview() }
            .is_some_and(|parent| Retained::as_ptr(&parent) == &*container as *const NSView);
          if !attached {
            container.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, Some(web_view));
          }

          let width = region.width.max(0.0);
          let height = region.height.max(0.0);
          let y = if flipped {
            host.origin.y + region.y
          } else {
            host.origin.y + host.size.height - region.y - height
          };
          view.setFrame(NSRect::new(
            NSPoint::new(host.origin.x + region.x, y),
            NSSize::new(width, height),
          ));
          view.setCornerRadius(region.radius.max(0.0));
          let opacity = region.opacity.clamp(0.0, 1.0);
          view.setAlphaValue(opacity);
          view.setHidden(opacity <= 0.0 || width <= 0.0 || height <= 0.0);
        }
      })
      .map_err(|error| error.to_string())
  }

  pub fn set_appearance(window: &tauri::WebviewWindow, dark: bool) -> Result<(), String> {
    if !liquid_glass_available() {
      return Ok(());
    }

    let label = window.label().to_string();
    window
      .with_webview(move |_| {
        DARK.with(|modes| modes.borrow_mut().insert(label.clone(), dark));
        VIEWS.with(|views| {
          for ((owner, _), view) in views.borrow().iter() {
            if owner == &label {
              apply_appearance(view, dark);
            }
          }
        });
      })
      .map_err(|error| error.to_string())
  }

  /// The view registered for `(label, id)`, created on first use with the window's last
  /// reported appearance.
  fn glass_view(mtm: MainThreadMarker, label: &str, id: &str) -> Retained<NSGlassEffectView> {
    VIEWS.with(|views| {
      views
        .borrow_mut()
        .entry((label.to_string(), id.to_string()))
        .or_insert_with(|| {
          let view = NSGlassEffectView::initWithFrame(mtm.alloc(), NSRect::ZERO);
          view.setStyle(NSGlassEffectViewStyle::Regular);
          if let Some(dark) = DARK.with(|modes| modes.borrow().get(label).copied()) {
            apply_appearance(&view, dark);
          }
          view
        })
        .clone()
    })
  }

  fn apply_appearance(view: &NSGlassEffectView, dark: bool) {
    let name = unsafe {
      if dark {
        NSAppearanceNameDarkAqua
      } else {
        NSAppearanceNameAqua
      }
    };
    view.setAppearance(NSAppearance::appearanceNamed(name).as_deref());
  }
}

#[cfg(not(target_os = "macos"))]
mod imp {
  use super::GlassRegion;

  pub fn liquid_glass_available() -> bool {
    false
  }

  pub fn install_main_backdrop(_window: &tauri::WebviewWindow) {}

  pub fn set_regions(_window: &tauri::WebviewWindow, _regions: Vec<GlassRegion>) -> Result<(), String> {
    Ok(())
  }

  pub fn set_appearance(_window: &tauri::WebviewWindow, _dark: bool) -> Result<(), String> {
    Ok(())
  }
}
