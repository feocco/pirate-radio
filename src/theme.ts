/**
 * Palette values that must stay identical across the stylesheet and the media
 * player. Shikwasa takes its accent as a constructor option and writes it to an
 * inline `--color-primary`, so it cannot read the stylesheet's custom property.
 * Both callers read these constants instead of repeating the literals.
 */
export const ACCENT = "#c1440e";
export const ACCENT_DARK = "#ff6a35";
