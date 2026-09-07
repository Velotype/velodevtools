// Deliberately importing the "server" build ("@jsr/velotype__velojson", not "/browser"): the
// browser build only implements the KeyTable format and hard-throws on Base or VBIN (KeyID)
// payloads. The server build's VSON.decode() handles all three, falling back to a "debug format"
// for VBIN (object keys become their raw numeric KeyIDs, since real key names require a
// schema-generated mapper this panel doesn't have -- see describeEncodingFormat() below and the
// README). Bundle size doesn't matter here since this only runs inside the DevTools page, never
// shipped to an end user's browser.
import { VSON } from "@jsr/velotype__velojson"
import { base64ToBytes, bytesToBase64, bytesToHex, describeEncodingFormat, hexToBytes, looksLikeVSON } from "../shared/bytes.ts"

interface BodyResult {
    /** No body present at all (e.g. a GET request with no postData) */
    absent: boolean
    bytes: Uint8Array | null
    decoded: unknown
    error: string | null
}

interface RequestRow {
    id: number
    method: string
    url: string
    request: BodyResult
    response: BodyResult
}

let nextId = 1
const rows: RequestRow[] = []
let selectedId: number | null = null

const requestsBody = document.getElementById("requests-body") as HTMLTableSectionElement
const detailsEmpty = document.getElementById("details-empty") as HTMLDivElement
const detailsOutput = document.getElementById("details-output") as HTMLPreElement
const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement

function decodeIfPlausible(bytes: Uint8Array | null): { decoded: unknown; error: string | null } {
    if (!bytes || bytes.length === 0) return { decoded: undefined, error: null }
    if (!looksLikeVSON(bytes)) return { decoded: undefined, error: "Doesn't look like VSON (unexpected leading byte)" }
    try {
        return { decoded: VSON.decode(bytes), error: null }
    } catch (err) {
        return { decoded: undefined, error: err instanceof Error ? err.message : String(err) }
    }
}

function requestBodyFrom(entry: chrome.devtools.network.Request): BodyResult {
    const postData = entry.request.postData
    if (!postData || !postData.text) return { absent: true, bytes: null, decoded: undefined, error: null }
    // Chrome's DevTools extension API only exposes postData as text, which can be lossy for
    // binary bodies -- this is a best-effort decode, see README for details.
    const bytes = new Uint8Array(postData.text.length)
    for (let i = 0; i < postData.text.length; i++) bytes[i] = postData.text.charCodeAt(i) & 0xff
    const { decoded, error } = decodeIfPlausible(bytes)
    return { absent: false, bytes, decoded, error }
}

function responseBodyFrom(entry: chrome.devtools.network.Request): Promise<BodyResult> {
    return new Promise(resolve => {
        entry.getContent((content, encoding) => {
            if (!content) {
                resolve({ absent: true, bytes: null, decoded: undefined, error: null })
                return
            }
            const bytes = encoding === "base64" ? base64ToBytes(content) : Uint8Array.from(content, c => c.charCodeAt(0) & 0xff)
            const { decoded, error } = decodeIfPlausible(bytes)
            resolve({ absent: false, bytes, decoded, error })
        })
    })
}

async function handleEntry(entry: chrome.devtools.network.Request): Promise<void> {
    const url = (() => {
        try {
            return new URL(entry.request.url).pathname || entry.request.url
        } catch {
            return entry.request.url
        }
    })()
    const row: RequestRow = {
        id: nextId++,
        method: entry.request.method,
        url,
        request: requestBodyFrom(entry),
        response: await responseBodyFrom(entry)
    }
    rows.unshift(row)
    renderRows()
}

chrome.devtools.network.onRequestFinished.addListener(entry => {
    handleEntry(entry).catch(err => console.error("velodevtools: failed to process request", err))
})

clearBtn.addEventListener("click", () => {
    rows.length = 0
    selectedId = null
    renderRows()
    showEmpty()
})

function statusCell(body: BodyResult): HTMLTableCellElement {
    const td = document.createElement("td")
    if (body.absent) {
        td.textContent = "—"
        td.className = "status-no"
    } else if (body.decoded !== undefined) {
        td.textContent = (body.bytes && describeEncodingFormat(body.bytes)) || "VSON"
        td.className = "status-yes"
    } else {
        td.textContent = "no"
        td.className = "status-no"
    }
    return td
}

function renderRows(): void {
    requestsBody.innerHTML = ""
    for (const row of rows) {
        const tr = document.createElement("tr")
        if (row.id === selectedId) tr.classList.add("selected")
        const methodTd = document.createElement("td")
        methodTd.textContent = row.method
        const urlTd = document.createElement("td")
        urlTd.textContent = row.url
        urlTd.title = row.url
        tr.append(methodTd, urlTd, statusCell(row.request), statusCell(row.response))
        tr.addEventListener("click", () => {
            selectedId = row.id
            renderRows()
            showRow(row)
        })
        requestsBody.appendChild(tr)
    }
}

function showEmpty(): void {
    detailsEmpty.hidden = false
    detailsOutput.hidden = true
}

function bodySection(title: string, body: BodyResult): string {
    if (body.absent) return `${title}: (no body)`
    const format = body.bytes ? describeEncodingFormat(body.bytes) : null
    const lines = [`${title}:${format ? ` [${format}]` : ""}`]
    if (body.error) {
        lines.push(`  ${body.error}`)
    } else if (body.decoded !== undefined) {
        if (format === "VBIN") {
            lines.push("  VBIN debug decode: object keys are raw numeric KeyIDs, not real field names")
            lines.push("  (real names require a schema-generated mapper this extension doesn't have)")
        }
        lines.push(indent(JSON.stringify(body.decoded, null, 2)))
    } else {
        lines.push("  (empty)")
    }
    if (body.bytes && body.bytes.length > 0) {
        lines.push(`  ${body.bytes.length} byte(s): ${bytesToHex(body.bytes.slice(0, 64))}${body.bytes.length > 64 ? " …" : ""}`)
    }
    return lines.join("\n")
}

function indent(text: string): string {
    return text.split("\n").map(line => `  ${line}`).join("\n")
}

function showRow(row: RequestRow): void {
    detailsEmpty.hidden = true
    detailsOutput.hidden = false
    detailsOutput.classList.remove("error")
    detailsOutput.textContent = [
        `${row.method} ${row.url}`,
        "",
        bodySection("Request body", row.request),
        "",
        bodySection("Response body", row.response)
    ].join("\n")
}

// ---- Manual decode / encode -------------------------------------------------------------------

const manualFormat = document.getElementById("manual-format") as HTMLSelectElement
const manualInput = document.getElementById("manual-input") as HTMLTextAreaElement
const decodeBtn = document.getElementById("decode-btn") as HTMLButtonElement
const encodeBtn = document.getElementById("encode-btn") as HTMLButtonElement

function showError(message: string): void {
    detailsEmpty.hidden = true
    detailsOutput.hidden = false
    detailsOutput.classList.add("error")
    detailsOutput.textContent = message
}

function showText(text: string): void {
    detailsEmpty.hidden = true
    detailsOutput.hidden = false
    detailsOutput.classList.remove("error")
    detailsOutput.textContent = text
}

decodeBtn.addEventListener("click", () => {
    const text = manualInput.value.trim()
    if (!text) {
        showError("Paste base64 or hex bytes to decode first.")
        return
    }
    try {
        const bytes = manualFormat.value === "hex" ? hexToBytes(text) : base64ToBytes(text)
        const format = describeEncodingFormat(bytes)
        const decoded = VSON.decode(bytes)
        const lines = format ? [`[${format}]`, ""] : []
        if (format === "VBIN") {
            lines.push("VBIN debug decode: object keys are raw numeric KeyIDs, not real field names")
            lines.push("(real names require a schema-generated mapper this extension doesn't have)")
            lines.push("")
        }
        lines.push(JSON.stringify(decoded, null, 2))
        showText(lines.join("\n"))
    } catch (err) {
        showError(`Decode failed: ${err instanceof Error ? err.message : String(err)}`)
    }
})

encodeBtn.addEventListener("click", () => {
    const text = manualInput.value.trim()
    if (!text) {
        showError("Paste JSON to encode first.")
        return
    }
    try {
        const value = JSON.parse(text)
        const bytes = VSON.encode(value)
        showText([`${bytes.length} byte(s)`, "", "base64:", bytesToBase64(bytes), "", "hex:", bytesToHex(bytes)].join("\n"))
    } catch (err) {
        showError(`Encode failed: ${err instanceof Error ? err.message : String(err)}`)
    }
})

showEmpty()
