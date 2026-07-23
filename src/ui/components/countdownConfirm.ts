/**
 * Click-to-confirm: a destructive button that counts down over repeated clicks before it runs
 * `onConfirm`, so a single stray click never deletes. `clicks` is the total presses needed (3 for a
 * row remove); the button shows the presses still remaining and reverts to `icon` if left idle for
 * CONFIRM_REVERT_MS. Ported from tesselot's shared confirm control; reused wherever a delete needs a
 * guard (timeline row remove today, more later).
 */
const CONFIRM_REVERT_MS = 2000;

export function attachCountdownConfirm(
  button: HTMLElement,
  icon: string,
  clicks: number,
  onConfirm: () => void,
): void {
  let remaining: number | undefined;
  let timer: number | undefined;

  const revert = (): void => {
    remaining = undefined;
    button.classList.remove("counting");
    button.innerHTML = icon;
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    remaining = remaining === undefined ? clicks - 1 : remaining - 1;
    if (remaining <= 0) {
      revert();
      onConfirm();
      return;
    }
    button.classList.add("counting");
    button.textContent = String(remaining);
    timer = window.setTimeout(revert, CONFIRM_REVERT_MS);
  });
}
