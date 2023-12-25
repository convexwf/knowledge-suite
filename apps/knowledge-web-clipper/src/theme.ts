import { normalizeThemeMode, saveSettings } from "./settings.js";
import type { ThemeMode } from "./types.js";

interface ThemeModeBinding {
  readonly mode: ThemeMode;
  setMode(value: unknown): void;
}

function bindThemeMode(initialMode: ThemeMode, control?: HTMLSelectElement): ThemeModeBinding {
  let mode = normalizeThemeMode(initialMode);
  const systemPreference = globalThis.matchMedia("(prefers-color-scheme: dark)");

  const apply = (): void => {
    const resolvedMode = mode === "system"
      ? (systemPreference.matches ? "dark" : "light")
      : mode;
    document.documentElement.dataset.theme = resolvedMode;
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.style.colorScheme = resolvedMode;
    if (control) control.value = mode;
  };

  apply();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.themeMode) return;
    mode = normalizeThemeMode(changes.themeMode.newValue);
    apply();
  });

  systemPreference.addEventListener("change", () => {
    if (mode === "system") apply();
  });

  return {
    get mode() {
      return mode;
    },
    setMode(value: unknown) {
      mode = normalizeThemeMode(value);
      apply();
    }
  };
}

export function bindThemeModePreference(initialMode: ThemeMode): void {
  bindThemeMode(initialMode);
}

export function bindThemeModeControl(control: HTMLSelectElement, initialMode: ThemeMode): void {
  const binding = bindThemeMode(initialMode, control);
  control.addEventListener("change", () => {
    const previousMode = binding.mode;
    const nextMode = normalizeThemeMode(control.value);
    binding.setMode(nextMode);
    void saveSettings({ themeMode: nextMode }).catch(() => binding.setMode(previousMode));
  });
}
