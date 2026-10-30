// WCAG 2 contrast of two sRGB colours written as hex. Written out here, so the ratios in the docs are checked by code
// that can be read in a minute.

function channels(hex: string): [number, number, number] {
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
    const full = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    const parts = short ? short.slice(1, 4).map((digit) => digit + digit) : full?.slice(1, 4);
    if (parts === undefined) throw new Error(`not a hex colour: ${hex}`);
    return parts.map((part) => Number.parseInt(part, 16)) as [number, number, number];
}

/** Relative luminance: 0 for black, 1 for white. */
export function luminance(hex: string): number {
    const [r, g, b] = channels(hex).map((value) => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** From 1 (the same colour) to 21 (black on white). */
export function contrast(a: string, b: string): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (light + 0.05) / (dark + 0.05);
}
