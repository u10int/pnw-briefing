/** APCA-W3 (0.0.98G-4g) constants. */
const APCA = {
  mainTRC: 2.4, sRco: 0.2126729, sGco: 0.7151522, sBco: 0.072175,
  normBG: 0.56, normTXT: 0.57, revTXT: 0.62, revBG: 0.65,
  blkThrs: 0.022, blkClmp: 1.414, scaleBoW: 1.14, scaleWoB: 1.14,
  loBoWoffset: 0.027, loWoBoffset: 0.027, deltaYmin: 0.0005, loClip: 0.1,
} as const

const DARK_TEXT_RGB = [26, 26, 26] as const // #1a1a1a
const LIGHT_TEXT_RGB = [255, 255, 255] as const // #ffffff

/** sRGB 8-bit channel → APCA screen luminance Ys. */
const srgbToY = (rgb: ReadonlyArray<number>): number => {
  const exp = (channel: number) => (channel / 255) ** APCA.mainTRC
  return APCA.sRco * exp(rgb[0]) + APCA.sGco * exp(rgb[1]) + APCA.sBco * exp(rgb[2])
}

/**
 * APCA-W3 Lc contrast (signed). Positive = dark text on light bg; negative = light text on dark.
 * Text Y first, background Y second — polarity matters.
 */
const apcaContrastLc = (textY: number, backgroundY: number): number => {
  if (
    !Number.isFinite(textY)
    || !Number.isFinite(backgroundY)
    || Math.min(textY, backgroundY) < 0
    || Math.max(textY, backgroundY) > 1.1
  ) {
    return 0
  }

  const txtY = textY > APCA.blkThrs ? textY : textY + (APCA.blkThrs - textY) ** APCA.blkClmp
  const bgY = backgroundY > APCA.blkThrs ? backgroundY : backgroundY + (APCA.blkThrs - backgroundY) ** APCA.blkClmp

  if (Math.abs(bgY - txtY) < APCA.deltaYmin) {
    return 0
  }

  let output: number
  if (bgY > txtY) {
    const sapc = (bgY ** APCA.normBG - txtY ** APCA.normTXT) * APCA.scaleBoW
    output = sapc < APCA.loClip ? 0 : sapc - APCA.loBoWoffset
  } else {
    const sapc = (bgY ** APCA.revBG - txtY ** APCA.revTXT) * APCA.scaleWoB
    output = sapc > -APCA.loClip ? 0 : sapc + APCA.loWoBoffset
  }

  return output * 100
}

const parseCssRgb = (color: string): [number, number, number] | undefined => {
  const hex = color.trim().replace(/^#/, "")

  if (/^[\da-f]{3}$/i.test(hex)) {
    return [
      Number.parseInt(hex[0] + hex[0], 16),
      Number.parseInt(hex[1] + hex[1], 16),
      Number.parseInt(hex[2] + hex[2], 16),
    ]
  }

  if (/^[\da-f]{6}$/i.test(hex)) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ]
  }

  const match = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i)
  if (!match) {
    return undefined
  }

  let r = Number(match[1])
  let g = Number(match[2])
  let b = Number(match[3])
  if (r <= 1 && g <= 1 && b <= 1) {
    r *= 255
    g *= 255
    b *= 255
  }

  return [r, g, b]
}

/**
 * Picks black or white text for contrast against a CSS hex/rgb background,
 * using APCA-W3 Lc (whichever candidate has the higher absolute contrast).
 */
export const contrastTextColor = (background: string): string => {
  const rgb = parseCssRgb(background)
  if (!rgb) {
    return "#1a1a1a"
  }

  const backgroundY = srgbToY(rgb)
  const darkLc = Math.abs(apcaContrastLc(srgbToY(DARK_TEXT_RGB), backgroundY))
  const lightLc = Math.abs(apcaContrastLc(srgbToY(LIGHT_TEXT_RGB), backgroundY))

  return darkLc >= lightLc ? "#1a1a1a" : "#ffffff"
}
