// How long a watch has run, as a short phrase for lists and notices.

/** `45 s`, `12 min`, `2 h 5 min`, `3 d 4 h`: rounded down, and never negative. */
export function formatAge(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
    const days = Math.floor(hours / 24);
    return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}
