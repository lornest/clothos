/** Left accent border — thick vertical line with a cap at the bottom */
export const ACCENT_BORDER = {
  topLeft: '',
  bottomLeft: '╹',
  vertical: '┃',
  topRight: '',
  bottomRight: '',
  horizontal: ' ',
  bottomT: '',
  topT: '',
  cross: '',
  leftT: '',
  rightT: '',
};

/** Continuous left accent border — no bottom cap (for stacking) */
export const ACCENT_BORDER_CONTINUOUS = {
  ...ACCENT_BORDER,
  bottomLeft: '┃',
};
