/**
 * Captures the exact bytes of VSON and VBIN request bodies, in the page (MAIN world, so it can see
 * what the page's own code passes to fetch, XMLHttpRequest and sendBeacon).
 *
 * Chrome's DevTools network API only gives a request's body as text (`postData.text`), decoded as
 * UTF-8 before the extension sees it, so every byte that is not valid UTF-8 is already lost. A
 * binary body such as VBIN cannot be rebuilt from it. The page's code has the real bytes.
 *
 * It does nothing until the VeloJSON panel asks for it (`startBodyCapture`), and only keeps bodies
 * whose Content-Type says velojson. Requests that do not come from the page's JavaScript (a form
 * post, a worker, the browser itself) are not seen here, and the panel falls back to `postData`.
 */
import { bytesToBase64, classifyContentType } from "../shared/bytes.ts"
import type { CapturedRequestBody } from "../shared/protocol.ts"

/** A body over this size is not kept */
const MAX_BODY_BYTES = 8 * 1024 * 1024

let report: ((body: CapturedRequestBody) => void) | null = null
let installed = false

export function startBodyCapture(onBody: (body: CapturedRequestBody) => void): void {
    report = onBody
    install()
}

export function stopBodyCapture(): void {
    report = null
}

/** Copies what a request body holds when it is bytes, now, before the page can change them */
function bytesOf(body: unknown): Uint8Array | Promise<Uint8Array> | null {
    if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0))
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
    if (body instanceof Blob) return body.arrayBuffer().then(buffer => new Uint8Array(buffer))
    return null
}

/** Reports a body, when its Content-Type says velojson. `getBytes` is only called then, so other bodies are not copied */
function publish(method: string, url: string, contentType: string | null, getBytes: () => Uint8Array | Promise<Uint8Array> | null): void {
    if (!report || classifyContentType(contentType) !== "vson-or-vbin") return
    const startedAt = Date.now()
    const bytes = getBytes()
    if (!bytes) return
    Promise.resolve(bytes).then(copy => {
        if (copy.length > MAX_BODY_BYTES) return
        report?.({ method: method.toUpperCase(), url: withoutFragment(url), startedAt, contentType, bytes: bytesToBase64(copy) })
    }).catch(() => {})
}

function withoutFragment(url: string): string {
    const index = url.indexOf("#")
    return index < 0 ? url : url.slice(0, index)
}

function absolute(url: string | URL): string {
    try {
        return new URL(String(url), location.href).href
    } catch {
        return String(url)
    }
}

function install(): void {
    if (installed) return
    installed = true

    const originalFetch = window.fetch
    const patchedFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        if (report) {
            try {
                const request = input instanceof Request ? input : null
                const headers = new Headers(init?.headers ?? request?.headers)
                const body = init?.body ?? undefined
                const contentType = headers.get("content-type") ?? (body instanceof Blob && body.type ? body.type : null)
                const method = init?.method ?? request?.method ?? "GET"
                const url = request ? request.url : absolute(input as string | URL)
                if (body !== undefined) {
                    publish(method, url, contentType, () => bytesOf(body))
                } else if (request && request.body && !request.bodyUsed && classifyContentType(contentType) === "vson-or-vbin") {
                    // A clone, so the page's own request is untouched
                    publish(method, url, contentType, () => request.clone().arrayBuffer().then(buffer => new Uint8Array(buffer)))
                }
            } catch {
                // Never get in the page's way
            }
        }
        return Reflect.apply(originalFetch, this, [input, init])
    }
    Object.defineProperty(patchedFetch, "name", { value: "fetch" })
    window.fetch = patchedFetch

    const requests = new WeakMap<XMLHttpRequest, { method: string; url: string; contentType: string | null }>()
    const originalOpen = XMLHttpRequest.prototype.open
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
        requests.set(this, { method, url: absolute(url), contentType: null })
        return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest)
    } as typeof XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
        const request = requests.get(this)
        if (request && name.toLowerCase() === "content-type") request.contentType = value
        return originalSetRequestHeader.call(this, name, value)
    }
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
        const request = requests.get(this)
        if (report && request && body) {
            try {
                publish(request.method, request.url, request.contentType ?? (body instanceof Blob && body.type ? body.type : null), () => bytesOf(body))
            } catch {
                // Never get in the page's way
            }
        }
        return originalSend.call(this, body)
    }

    const originalSendBeacon = navigator.sendBeacon
    if (originalSendBeacon) {
        navigator.sendBeacon = function (this: Navigator, url: string | URL, data?: BodyInit | null) {
            if (report && data) {
                try {
                    publish("POST", absolute(url), data instanceof Blob && data.type ? data.type : null, () => bytesOf(data))
                } catch {
                    // Never get in the page's way
                }
            }
            return originalSendBeacon.call(this, url, data)
        }
    }
}
