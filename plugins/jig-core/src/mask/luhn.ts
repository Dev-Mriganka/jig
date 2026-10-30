/** Luhn checksum over a string of ASCII digits. */
export function luhn(digits: string): boolean {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        let n = digits.charCodeAt(digits.length - 1 - i) - 48;
        if (i % 2 === 1) {
            n *= 2;
            if (n > 9) n -= 9;
        }
        sum += n;
    }
    return sum % 10 === 0;
}
