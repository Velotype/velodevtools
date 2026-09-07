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

/**
 * velojson's leading byte packs `(encodingFormat * 8) + wireType`, where `encodingFormat` is one
 * of Base (0), KeyTable (1), or KeyID/VBIN (2) and `wireType` is 0-7 -- see velojson's common.ts.
 * So a valid buffer's first byte must fall in [0, 23].
 */
export function looksLikeVSON(bytes: Uint8Array): boolean {
    const first = bytes[0]
    return first !== undefined && first <= 23
}

export type VSONEncodingFormat = "Base" | "KeyTable" | "VBIN"

/**
 * Reads just the encoding format out of a velojson buffer's leading byte, for display purposes.
 * VBIN (KeyID format) payloads decode via `VSON.decode()` into a "debug format" -- object keys
 * come back as their raw numeric KeyIDs (e.g. `{"1": "hello"}`) rather than real field names,
 * since real names require a schema-generated mapper this extension doesn't have access to.
 */
export function describeEncodingFormat(bytes: Uint8Array): VSONEncodingFormat | null {
    const first = bytes[0]
    if (first === undefined || first > 23) return null
    const format = Math.floor(first / 8)
    if (format === 0) return "Base"
    if (format === 1) return "KeyTable"
    return "VBIN"
}

/**
 * velojson has a real, specific Content-Type per format -- see veloschema's `ContentTypes`
 * (`application/vson; charset=utf-8` and `application/vbin; charset=utf-8`) and its generated
 * clients, which set/read exactly these. When a Content-Type is available, that's authoritative
 * and should be used instead of guessing from bytes.
 */
export type ContentTypeVerdict = "vson-or-vbin" | "other" | "unknown"

export function classifyContentType(contentType: string | null | undefined): ContentTypeVerdict {
    if (!contentType) return "unknown"
    const lower = contentType.toLowerCase()
    if (lower.includes("vson") || lower.includes("vbin")) return "vson-or-vbin"
    if (lower === "application/octet-stream" || lower === "") return "unknown"
    return "other"
}
