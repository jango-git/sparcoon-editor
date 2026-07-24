/**
 * Wires a {@link Store} into the {@link PaletteAccess} shape `ColorPicker`/`ColorRamp` expect,
 * shared by every caller that constructs one (previewSettings.ts, graphCanvas.ts) so the store ->
 * command plumbing exists in exactly one place.
 */

import { addPaletteSwatch, removePaletteSwatch } from "../../model/commands";
import { selectPaletteSwatches } from "../../model/selectors";
import type { Store } from "../../model/store";
import type { PaletteAccess } from "./colorPicker";

export function createPaletteAccess(store: Store): PaletteAccess {
  return {
    swatches: () => selectPaletteSwatches(store),
    onSave: (color, label) => addPaletteSwatch(store, color, label),
    onRemove: (name) => removePaletteSwatch(store, name),
  };
}
