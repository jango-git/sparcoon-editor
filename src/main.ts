/** Entry point. A device without a mouse or trackpad gets a notice instead of the editor, which is
 *  a separate chunk, so such a device never downloads it. */

import { getLocale, initI18n } from "./i18n";
import { initTheme } from "./settings/theme";
import { hasPrecisePointer, mountUnsupportedDevice } from "./ui/unsupportedDevice";

async function main(): Promise<void> {
  const root = document.getElementById("application") ?? undefined;
  if (root === undefined) {
    throw new Error("Missing #application root element");
  }

  // Re-apply the persisted theme and start tracking OS changes while in auto mode. The
  // inline <head> script already set data-theme before paint; this keeps it live.
  initTheme();

  // Locale dictionaries are fetched, not bundled; load the active locale (and the English
  // fallback) before anything builds UI that calls t(). Reflect the choice on <html lang>.
  await initI18n();
  document.documentElement.lang = getLocale();

  if (!hasPrecisePointer()) {
    mountUnsupportedDevice(root);
    return;
  }

  const { startEditor } = await import("./editor");
  await startEditor(root);
}

void main();
