/**
 * Tracks whether a modal panel (Settings, visual viewer) is open. Esc closes the modal;
 * without this check the same keypress also cancelled JARVIS's speech and any running turn.
 */
let open = 0;

export const pushModal = (): void => {
  open++;
};

export const popModal = (): void => {
  open = Math.max(0, open - 1);
};

export const isModalOpen = (): boolean => open > 0;
