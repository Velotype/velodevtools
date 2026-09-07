/**
 * Turns an arbitrary live JS value into a short, safe-to-clone string preview.
 *
 * Used for component field/attr values, which can be anything a page's Velotype Components hold
 * (DOM nodes, functions, RenderObjects, circular structures, huge arrays, ...). Never throws, and
 * never returns the live value itself -- only text -- since these previews cross a postMessage /
 * structured-clone boundary where functions and DOM nodes are not cloneable.
 */

const MAX_STRING = 120
const MAX_ITEMS = 20
const MAX_DEPTH = 2

export function typeLabelOf(value: unknown): string {
    if (value === null) return "null"
    if (Array.isArray(value)) return "array"
    if (value instanceof Map) return "Map"
    if (value instanceof Set) return "Set"
    if (isRenderObjectLike(value)) return renderObjectKind(value)
    if (isElementLike(value)) return "Element"
    return typeof value
}

export function preview(value: unknown): string {
    return previewInner(value, 0, new WeakSet())
}

function previewInner(value: unknown, depth: number, seen: WeakSet<object>): string {
    if (value === null) return "null"
    if (value === undefined) return "undefined"
    const t = typeof value
    if (t === "string") return truncateString(JSON.stringify(value))
    if (t === "number" || t === "boolean") return String(value)
    if (t === "bigint") return `${value}n`
    if (t === "symbol") return value.toString()
    if (t === "function") {
        const fn = value as (...args: unknown[]) => unknown
        return fn.name ? `ƒ ${fn.name}()` : "ƒ ()"
    }

    const obj = value as object
    if (seen.has(obj)) return "[circular]"

    if (isElementLike(value)) return describeElement(value as Element)
    if (isRenderObjectLike(value)) {
        seen.add(obj)
        return `${renderObjectKind(value)}(${previewInner(value.value, depth + 1, seen)})`
    }
    if (value instanceof Map) return `Map(${value.size})`
    if (value instanceof Set) return `Set(${value.size})`

    if (Array.isArray(value)) {
        if (depth >= MAX_DEPTH) return `Array(${value.length})`
        seen.add(obj)
        const items = value.slice(0, MAX_ITEMS).map(v => previewInner(v, depth + 1, seen))
        const suffix = value.length > MAX_ITEMS ? `, … (${value.length} total)` : ""
        return `[${items.join(", ")}${suffix}]`
    }

    if (t === "object") {
        if (depth >= MAX_DEPTH) return constructorNameOf(value)
        seen.add(obj)
        const keys = Object.keys(value as Record<string, unknown>)
        const shown = keys.slice(0, MAX_ITEMS).map(k => `${k}: ${previewInner((value as Record<string, unknown>)[k], depth + 1, seen)}`)
        const suffix = keys.length > MAX_ITEMS ? `, … (${keys.length} keys)` : ""
        const name = constructorNameOf(value)
        const prefix = name && name !== "Object" ? `${name} ` : ""
        return `${prefix}{${shown.join(", ")}${suffix}}`
    }

    return String(value)
}

function truncateString(s: string): string {
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…"` : s
}

function constructorNameOf(value: object): string {
    return value.constructor?.name || "Object"
}

function isElementLike(value: unknown): value is Element {
    return typeof value === "object" && value !== null && "nodeType" in value && (value as Node).nodeType === 1
}

function describeElement(el: Element): string {
    const id = el.id ? `#${el.id}` : ""
    const cls = el.classList.length ? `.${Array.from(el.classList).join(".")}` : ""
    return `<${el.tagName.toLowerCase()}${id}${cls}>`
}

/**
 * Duck-types a Velotype RenderObject / RenderBasic / RenderObjectArray instance.
 *
 * These classes aren't exported from Velotype's public API surface, so instead of an
 * `instanceof` check this looks for the shape Velotype's core relies on internally
 * (`renderDefault()` + `unmountKey()` + a `value` getter) -- see MultiRenderable in
 * velotype's tsx-core.ts.
 */
export function isRenderObjectLike(value: unknown): value is { value: unknown; getString?: () => string; push?: unknown; getAt?: unknown } {
    if (typeof value !== "object" || value === null) return false
    const v = value as Record<string, unknown>
    return typeof v.renderDefault === "function" && typeof v.unmountKey === "function" && "value" in v
}

function renderObjectKind(value: { getString?: unknown; push?: unknown; getAt?: unknown }): string {
    if (typeof value.push === "function" && typeof value.getAt === "function") return "RenderObjectArray"
    if (typeof value.getString === "function") return "RenderBasic"
    return "RenderObject"
}
