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

export type VSONEncodingFormat = "Base" | "KeyTable" | "VBIN"

/**
 * Reads just the encoding format out of a velojson buffer's leading byte
 * (`(encodingFormat * 8) + wireType` -- see velojson's common.ts), for display purposes only.
 * Callers must already know `bytes` is velojson (e.g. from its Content-Type) before calling this --
 * it's not a "is this velojson" test, just "which of the three formats is it".
 *
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
 * (`application/vson` and `application/vbin`, generally sent as e.g.
 * `application/vson; charset=utf-8`) and its generated clients/gateways, which set/read exactly
 * these. This is the sole authority for whether a body is velojson: a body is only ever decoded
 * when its Content-Type says so here, nothing is ever guessed from its bytes.
 *
 * Matches by substring (rather than an exact string) so a `; charset=...` suffix, or any other
 * parameter, doesn't matter.
 */
export type ContentTypeVerdict = "vson-or-vbin" | "other" | "unknown"

export function classifyContentType(contentType: string | null | undefined): ContentTypeVerdict {
    if (!contentType) return "unknown"
    const lower = contentType.toLowerCase()
    if (lower.includes("vson") || lower.includes("vbin")) return "vson-or-vbin"
    if (lower === "application/octet-stream" || lower === "") return "unknown"
    return "other"
}
