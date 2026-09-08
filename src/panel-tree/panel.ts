import {
    TREE_PORT_NAME,
    type ComponentDetails,
    type ComponentTreeNode,
    type FieldPreview,
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

let selectedId: string | null = null
const collapsed = new Set<string>()
let latestTree: ComponentTreeNode[] = []
let latestDetails: ComponentDetails | null = null

/** Which field paths are currently expanded, and their last-fetched children -- keyed by
 *  JSON.stringify(path) since a real object key could itself contain "." or other separators.
 *  Cleared whenever the selected component changes, since paths are only meaningful relative to it. */
const expandedPaths = new Set<string>()
const fieldChildrenCache = new Map<string, FieldPreview[] | null>()

const port = chrome.runtime.connect({ name: TREE_PORT_NAME })
port.postMessage({ type: "init", tabId: chrome.devtools.inspectedWindow.tabId })

port.onMessage.addListener((message: PanelResponse) => {
    if (message.type === "hookStatus") renderStatus(message.status)
    else if (message.type === "tree") renderTree(message.tree)
    else if (message.type === "details") renderDetails(message.details)
    else if (message.type === "contentScriptGone") renderStatus({ present: false, instances: [] }, true)
    else if (message.type === "fieldChildren") {
        fieldChildrenCache.set(JSON.stringify(message.path), message.children)
        renderDetails(latestDetails)
    }
})

function refresh(): void {
    port.postMessage({ type: "requestHookStatus" })
    port.postMessage({ type: "requestTree" })
    if (selectedId) {
        port.postMessage({ type: "requestDetails", id: selectedId })
        // Keep already-expanded branches live too, not just the top-level fields list.
        for (const pathKey of expandedPaths) {
            port.postMessage({ type: "requestFieldChildren", id: selectedId, path: JSON.parse(pathKey) })
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

function renderStatus(status: HookStatus, contentScriptGone = false): void {
    if (contentScriptGone) {
        statusBar.textContent = "Lost connection to this tab (navigated or reloaded?). Reopen DevTools to reconnect."
        return
    }
    if (!status.present) {
        statusBar.textContent = "No Velotype instance detected on this page yet."
        return
    }
    statusBar.innerHTML = ""
    for (const instance of status.instances) {
        const span = document.createElement("span")
        span.className = "instance"
        span.textContent = `instance #${instance.instanceId} (attr "${instance.domKeyName}"): ${instance.componentCount} tracked object(s)`
        statusBar.appendChild(span)
    }
}

function renderTree(tree: ComponentTreeNode[]): void {
    latestTree = tree
    treeEl.innerHTML = ""
    if (tree.length === 0) {
        const li = document.createElement("li")
        li.className = "empty-note"
        li.textContent = "No components found in the DOM."
        treeEl.appendChild(li)
        return
    }
    for (const node of tree) treeEl.appendChild(renderNode(node))
}

function renderNode(node: ComponentTreeNode): HTMLLIElement {
    const li = document.createElement("li")
    const row = document.createElement("div")
    row.className = "node-row" + (node.id === selectedId ? " selected" : "")

    const toggle = document.createElement("span")
    toggle.className = "node-toggle"
    const hasChildren = node.children.length > 0
    toggle.textContent = hasChildren ? (collapsed.has(node.id) ? "▸" : "▾") : ""
    toggle.addEventListener("click", event => {
        event.stopPropagation()
        if (!hasChildren) return
        if (collapsed.has(node.id)) collapsed.delete(node.id)
        else collapsed.add(node.id)
        renderTree(latestTree)
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
        if (selectedId !== node.id) {
            expandedPaths.clear()
            fieldChildrenCache.clear()
        }
        selectedId = node.id
        renderTree(latestTree)
        port.postMessage({ type: "requestDetails", id: node.id })
        port.postMessage({ type: "requestHighlight", id: node.id })
    })
    row.addEventListener("mouseenter", () => {
        port.postMessage({ type: "requestHighlight", id: node.id })
    })
    row.addEventListener("mouseleave", () => {
        port.postMessage({ type: "requestHighlight", id: selectedId })
    })

    li.appendChild(row)

    if (hasChildren && !collapsed.has(node.id)) {
        const ul = document.createElement("ul")
        for (const child of node.children) ul.appendChild(renderNode(child))
        li.appendChild(ul)
    }
    return li
}

function renderDetails(details: ComponentDetails | null): void {
    latestDetails = details
    if (!details) {
        detailsEmpty.hidden = false
        detailsContent.hidden = true
        detailsEmpty.textContent = selectedId ? "This component is no longer present." : "Select a component to inspect it."
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
                if (selectedId) port.postMessage({ type: "requestFieldChildren", id: selectedId, path: field.path })
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
