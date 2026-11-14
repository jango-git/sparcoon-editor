/**
 * Click-to-confirm: a destructive button that counts down over repeated clicks before it runs
 * `onConfirm`, so a single stray click never deletes. `clicks` is the total presses needed (3 for a
 * row remove); the button shows the presses still remaining and reverts to `icon` if left idle for
 * CONFIRM_REVERT_MS. Once confirmed it stays grey for CONFIRMED_MS so the press reads as done,
 * ignoring clicks meanwhile.
 */
const CONFIRM_REVERT_MS = 2000;
const CONFIRMED_MS = 1000;

export function attachCountdownConfirm(
  button: HTMLElement,
  icon: string,
  clicks: number,
  onConfirm: () => void,
): void {
  let remaining: number | undefined;
  let timer: number | undefined;
  button.classList.add("countdown-confirm");

  const revert = (): void => {
    remaining = undefined;
    button.classList.remove("counting");
    button.style.minWidth = "";
    button.innerHTML = icon;
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (button.classList.contains("confirmed")) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    remaining = remaining === undefined ? clicks - 1 : remaining - 1;
    if (remaining <= 0) {
      revert();
      button.classList.add("confirmed");
      timer = window.setTimeout(() => button.classList.remove("confirmed"), CONFIRMED_MS);
      onConfirm();
      return;
    }
    if (!button.classList.contains("counting")) {
      // Keeps a labelled button (Arrange) its width while it shows the lone digit.
      button.style.minWidth = `${String(button.offsetWidth)}px`;
      button.classList.add("counting");
    }
    button.replaceChildren(
      Object.assign(document.createElement("span"), {
        className: "countdown-confirm__count",
        textContent: String(remaining),
      }),
    );
    timer = window.setTimeout(revert, CONFIRM_REVERT_MS);
  });
}
