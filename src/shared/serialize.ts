/**
 * Turns an arbitrary live JS value into safe-to-clone data for the field inspector: a short
 * one-line `preview()` summary, and (for objects/arrays/Maps/Sets/RenderObjects) `childrenOf()` to
 * enumerate its own properties on demand for expand/collapse navigation.
 *
 * Used for component field/attr values, which can be anything a page's Velotype Components hold
 * (DOM nodes, functions, RenderObjects, huge arrays, ...). Never throws, and never returns the live
 * value itself -- only text and further-enumerable child values -- since these cross a postMessage /
 * structured-clone boundary where functions and DOM nodes are not cloneable.
 */

const MAX_STRING = 120
const MAX_CHILDREN = 200
/** Bounds RenderObject-of-RenderObject-of-RenderObject... unwrapping in preview(); real chains
 *  this deep are not a thing Velotype produces, this is just a defensive cap. */
const MAX_RENDER_OBJECT_UNWRAP_DEPTH = 5

export function typeLabelOf(value: unknown): string {
    if (value === null) return "null"
    if (Array.isArray(value)) return "array"
    if (value instanceof Map) return "Map"
    if (value instanceof Set) return "Set"
    if (isRenderObjectLike(value)) return renderObjectKind(value)
    if (isElementLike(value)) return "Element"
    return typeof value
}

/** A short, one-line, non-recursive summary -- the collapsed label for a field. Expand via
 *  childrenOf() to see further into an object/array rather than inlining it here. */
export function preview(value: unknown, renderObjectUnwrapDepth = 0): string {
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
    if (isElementLike(value)) return describeElement(value)
    if (isRenderObjectLike(value)) {
        const inner = renderObjectUnwrapDepth < MAX_RENDER_OBJECT_UNWRAP_DEPTH
            ? preview(value.value, renderObjectUnwrapDepth + 1)
            : "…"
        return `${renderObjectKind(value)}(${inner})`
    }
    if (value instanceof Map) return `Map(${value.size})`
    if (value instanceof Set) return `Set(${value.size})`
    if (Array.isArray(value)) return `Array(${value.length})`

    // Plain object or class instance
    const name = constructorNameOf(value)
    if (name !== "Object") return name
    const keyCount = Object.keys(value).length
    return keyCount === 0 ? "{}" : `{${keyCount} key${keyCount === 1 ? "" : "s"}}`
}

/**
 * Enumerates a value's own children for expand/collapse navigation, or `null` if `value` isn't
 * something with further children to show (a primitive, function, or DOM element).
 *
 * Capped at MAX_CHILDREN per level -- this is a debugging tool, not a full data dump.
 */
export function childrenOf(value: unknown): Array<{ key: string; value: unknown }> | null {
    if (value === null || typeof value !== "object") return null
    if (isElementLike(value)) return null
    if (isRenderObjectLike(value)) return [{ key: "value", value: value.value }]
    if (value instanceof Map) {
        return Array.from(value.entries(), ([k, v]) => [k, v] as const)
            .slice(0, MAX_CHILDREN)
            .map(([k, v], index) => ({ key: typeof k === "string" ? k : `[${index}]`, value: v }))
    }
    if (value instanceof Set) {
        return Array.from(value.values()).slice(0, MAX_CHILDREN).map((v, index) => ({ key: `[${index}]`, value: v }))
    }
    if (Array.isArray(value)) {
        return value.slice(0, MAX_CHILDREN).map((v, index) => ({ key: String(index), value: v }))
    }
    return Object.entries(value).slice(0, MAX_CHILDREN).map(([key, v]) => ({ key, value: v }))
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
