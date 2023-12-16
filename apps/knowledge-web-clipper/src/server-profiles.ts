import type { ExtensionSettings } from "./types.js";

export function renderServerProfileOptions(
  select: HTMLSelectElement,
  settings: Pick<ExtensionSettings, "profiles" | "activeProfileId">,
): void {
  select.replaceChildren(
    ...settings.profiles.map((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name;
      return option;
    }),
  );
  select.value = settings.activeProfileId;
}

export function hasServerProfileChange(
  changes: Record<string, chrome.storage.StorageChange>,
): boolean {
  return "serverProfiles" in changes || "activeServerProfileId" in changes;
}
