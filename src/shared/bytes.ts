export function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
}

export function hexToBytes(hex: string): Uint8Array {
    const cleaned = hex.trim().replace(/[\s:]/g, "")
    if (cleaned.length % 2 !== 0) throw new Error("Hex string must have an even number of digits")
    const bytes = new Uint8Array(cleaned.length / 2)
    for (let i = 0; i < bytes.length; i++) {
        const byteHex = cleaned.slice(i * 2, i * 2 + 2)
        const value = Number.parseInt(byteHex, 16)
        if (Number.isNaN(value)) throw new Error(`Invalid hex byte "${byteHex}"`)
        bytes[i] = value
    }
    return bytes
}

export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(" ")
}

/** VSON's leading byte packs `(encodingFormat * 8) + wireType`; only encodingFormat 1
 *  (KeyTable) exists today, so a valid VSON buffer must start with a byte in [8, 15]. */
export function looksLikeVSON(bytes: Uint8Array): boolean {
    const first = bytes[0]
    return first !== undefined && first >= 8 && first <= 15
}
