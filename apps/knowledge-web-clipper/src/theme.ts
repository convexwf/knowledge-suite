import { normalizeThemeMode, saveSettings } from "./settings.js";
import type { ThemeMode } from "./types.js";

export function bindThemeModeControl(control: HTMLSelectElement, initialMode: ThemeMode): void {
  let mode = normalizeThemeMode(initialMode);
  const systemPreference = globalThis.matchMedia("(prefers-color-scheme: dark)");

  const apply = (): void => {
    const resolvedMode = mode === "system"
      ? (systemPreference.matches ? "dark" : "light")
      : mode;
    document.documentElement.dataset.theme = resolvedMode;
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.style.colorScheme = resolvedMode;
    control.value = mode;
  };

  apply();
  control.addEventListener("change", () => {
    const previousMode = mode;
    mode = normalizeThemeMode(control.value);
    apply();
    void saveSettings({ themeMode: mode }).catch(() => {
      mode = previousMode;
      apply();
    });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.themeMode) return;
    mode = normalizeThemeMode(changes.themeMode.newValue);
    apply();
  });

  systemPreference.addEventListener("change", () => {
    if (mode === "system") apply();
  });
}
