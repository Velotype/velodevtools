import { frameLabel } from "../shared/frames.ts"
import {
    TREE_PORT_NAME,
    type ComponentDetails,
    type ComponentTreeNode,
    type FieldPreview,
    type FrameInfo,
    type HookStatus,
    type PanelResponse
} from "../shared/protocol.ts"

const statusBar = document.getElementById("status-bar") as HTMLDivElement
const treeEl = document.getElementById("tree") as HTMLUListElement
const detailsEmpty = document.getElementById("details-empty") as HTMLDivElement
const detailsContent = document.getElementById("details-content") as HTMLDivElement
const detailsHeader = document.getElementById("details-header") as HTMLDivElement
const attrsTree = document.getElementById("attrs-tree") as HTMLUListElement
const fieldsTree = document.getElementById("fields-tree") as HTMLUListElement

/** A node of the tree, which belongs to one frame: node ids only mean something within their frame */
interface Selected {
    frameId: number
    id: string
}
/** What each frame that has Velotype last sent */
interface FrameState {
    frame: FrameInfo
    status: HookStatus
    tree: ComponentTreeNode[]
}
const frames = new Map<number, FrameState>()
/** Frames in tree order: the top frame first, then the iframes as they connected */
function framesInOrder(): FrameState[] {
    return [...frames.values()].filter(state => state.status.present).sort((a, b) => a.frame.frameId - b.frame.frameId)
}
const nodeKey = (frameId: number, id: string) => `${frameId}/${id}`

let selected: Selected | null = null
const collapsed = new Set<string>()
let latestDetails: ComponentDetails | null = null
let lostConnection = false

/** Which field paths are currently expanded, and their last-fetched children -- keyed by
 *  JSON.stringify(path) since a real object key could itself contain "." or other separators.
 *  Cleared whenever the selected component changes, since paths are only meaningful relative to it. */
const expandedPaths = new Set<string>()
const fieldChildrenCache = new Map<string, FieldPreview[] | null>()

const port = chrome.runtime.connect({ name: TREE_PORT_NAME })
port.postMessage({ type: "init", tabId: chrome.devtools.inspectedWindow.tabId })

function stateOf(frame: FrameInfo): FrameState {
    let state = frames.get(frame.frameId)
    if (!state) {
        state = { frame, status: { present: false, instances: [] }, tree: [] }
        frames.set(frame.frameId, state)
    }
    state.frame = frame
    return state
}

port.onMessage.addListener((message: PanelResponse) => {
    if (message.type === "contentScriptGone") {
        frames.clear()
        lostConnection = true
        renderStatus()
        renderTree()
        return
    }
    if (message.type === "frameGone") {
        frames.delete(message.frame.frameId)
        renderStatus()
        renderTree()
        return
    }
    lostConnection = false
    const state = stateOf(message.frame)
    const fromSelected = selected !== null && selected.frameId === message.frame.frameId
    if (message.type === "hookStatus") {
        state.status = message.status
        renderStatus()
        renderTree()
    } else if (message.type === "tree") {
        state.tree = message.tree
        renderTree()
    } else if (message.type === "details") {
        if (fromSelected) renderDetails(message.details)
    } else if (message.type === "fieldChildren") {
        if (fromSelected) {
            fieldChildrenCache.set(JSON.stringify(message.path), message.children)
            renderDetails(latestDetails)
        }
    }
})

function refresh(): void {
    port.postMessage({ type: "requestHookStatus" })
    port.postMessage({ type: "requestTree" })
    if (selected) {
        const { frameId, id } = selected
        port.postMessage({ type: "requestDetails", id, frameId })
        // Keep already-expanded branches live too, not just the top-level fields list.
        for (const pathKey of expandedPaths) {
            port.postMessage({ type: "requestFieldChildren", id, path: JSON.parse(pathKey), frameId })
        }
    }
}
refresh()
setInterval(refresh, 1500)

window.addEventListener("beforeunload", () => {
    try {
        port.postMessage({ type: "requestHighlight", id: null })
    } catch {
        // Panel is closing anyway.
    }
})

function renderStatus(): void {
    if (lostConnection) {
        statusBar.textContent = "Lost connection to this tab (navigated or reloaded?). Reopen DevTools to reconnect."
        return
    }
    const present = framesInOrder()
    if (present.length === 0) {
        statusBar.textContent = "No Velotype instance detected on this page yet."
        return
    }
    statusBar.innerHTML = ""
    for (const { frame, status } of present) {
        for (const instance of status.instances) {
            const span = document.createElement("span")
            span.className = "instance"
            const where = present.length > 1 ? `${frameLabel(frame)}, ` : ""
            span.textContent = `${where}instance #${instance.instanceId} (velotype ${instance.version}): ${instance.componentCount} tracked object(s)`
            statusBar.appendChild(span)
        }
    }
}

function renderTree(): void {
    treeEl.innerHTML = ""
    const present = framesInOrder()
    if (present.length === 0 || present.every(state => state.tree.length === 0)) {
        const li = document.createElement("li")
        li.className = "empty-note"
        li.textContent = "No components found in the DOM."
        treeEl.appendChild(li)
        return
    }
    for (const state of present) {
        if (state.tree.length === 0) continue
        // A page with more than one frame that has Velotype shows each as its own root
        if (present.length > 1) {
            const header = document.createElement("li")
            header.className = "frame-header"
            header.textContent = frameLabel(state.frame)
            treeEl.appendChild(header)
        }
        for (const node of state.tree) treeEl.appendChild(renderNode(node, state.frame.frameId))
    }
}

function renderNode(node: ComponentTreeNode, frameId: number): HTMLLIElement {
    const li = document.createElement("li")
    const row = document.createElement("div")
    const key = nodeKey(frameId, node.id)
    row.className = "node-row" + (selected && nodeKey(selected.frameId, selected.id) === key ? " selected" : "")

    const toggle = document.createElement("span")
    toggle.className = "node-toggle"
    const hasChildren = node.children.length > 0
    toggle.textContent = hasChildren ? (collapsed.has(key) ? "▸" : "▾") : ""
    toggle.addEventListener("click", event => {
        event.stopPropagation()
        if (!hasChildren) return
        if (collapsed.has(key)) collapsed.delete(key)
        else collapsed.add(key)
        renderTree()
    })
    row.appendChild(toggle)

    const label = document.createElement("span")
    label.className = `node-label node-kind-${node.kind}`
    label.textContent = node.label
    row.appendChild(label)

    const tag = document.createElement("span")
    tag.className = "node-tag"
    tag.textContent = `<${node.tag}>`
    row.appendChild(tag)

    row.addEventListener("click", () => {
        if (!selected || nodeKey(selected.frameId, selected.id) !== key) {
            expandedPaths.clear()
            fieldChildrenCache.clear()
        }
        selected = { frameId, id: node.id }
        renderTree()
        port.postMessage({ type: "requestDetails", id: node.id, frameId })
        port.postMessage({ type: "requestHighlight", id: node.id, frameId })
    })
    row.addEventListener("mouseenter", () => {
        port.postMessage({ type: "requestHighlight", id: node.id, frameId })
    })
    row.addEventListener("mouseleave", () => {
        port.postMessage({ type: "requestHighlight", id: selected?.id ?? null, frameId: selected?.frameId })
    })

    li.appendChild(row)

    if (hasChildren && !collapsed.has(key)) {
        const ul = document.createElement("ul")
        for (const child of node.children) ul.appendChild(renderNode(child, frameId))
        li.appendChild(ul)
    }
    return li
}

function renderDetails(details: ComponentDetails | null): void {
    latestDetails = details
    if (!details) {
        detailsEmpty.hidden = false
        detailsContent.hidden = true
        detailsEmpty.textContent = selected ? "This component is no longer present." : "Select a component to inspect it."
        return
    }
    detailsEmpty.hidden = true
    detailsContent.hidden = false
    detailsHeader.textContent = `${details.label}  (${details.kind})`
    renderFieldTree(attrsTree, details.attrs, "No attrs.")
    renderFieldTree(fieldsTree, details.fields, "No fields.")
}

function renderFieldTree(container: HTMLUListElement, fields: FieldPreview[], emptyText: string): void {
    container.innerHTML = ""
    if (fields.length === 0) {
        const li = document.createElement("li")
        li.className = "empty-note"
        li.textContent = emptyText
        container.appendChild(li)
        return
    }
    for (const field of fields) container.appendChild(renderFieldNode(field))
}

function renderFieldNode(field: FieldPreview): HTMLLIElement {
    const li = document.createElement("li")
    const pathKey = JSON.stringify(field.path)
    const isExpanded = field.expandable && expandedPaths.has(pathKey)

    const row = document.createElement("div")
    row.className = "field-row"

    const toggle = document.createElement("span")
    toggle.className = "field-toggle"
    toggle.textContent = field.expandable ? (isExpanded ? "▾" : "▸") : ""
    if (field.expandable) {
        toggle.addEventListener("click", () => {
            if (expandedPaths.has(pathKey)) {
                expandedPaths.delete(pathKey)
            } else {
                expandedPaths.add(pathKey)
                if (selected) port.postMessage({ type: "requestFieldChildren", id: selected.id, path: field.path, frameId: selected.frameId })
            }
            renderDetails(latestDetails)
        })
    }
    row.appendChild(toggle)

    const name = document.createElement("span")
    name.className = "field-name"
    name.textContent = field.name
    row.appendChild(name)

    const type = document.createElement("span")
    type.className = "field-type"
    type.textContent = field.typeLabel
    row.appendChild(type)

    const value = document.createElement("span")
    value.className = "field-value"
    value.textContent = field.preview
    row.appendChild(value)

    li.appendChild(row)

    if (isExpanded) {
        const children = fieldChildrenCache.get(pathKey)
        if (children === undefined) {
            const loading = document.createElement("div")
            loading.className = "field-loading"
            loading.textContent = "loading…"
            li.appendChild(loading)
        } else if (children === null) {
            const gone = document.createElement("div")
            gone.className = "field-loading"
            gone.textContent = "(no longer present)"
            li.appendChild(gone)
        } else if (children.length === 0) {
            const empty = document.createElement("div")
            empty.className = "field-empty-note"
            empty.textContent = "(no further fields)"
            li.appendChild(empty)
        } else {
            const ul = document.createElement("ul")
            for (const child of children) ul.appendChild(renderFieldNode(child))
            li.appendChild(ul)
        }
    }

    return li
}
