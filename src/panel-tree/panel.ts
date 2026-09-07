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
const attrsTable = document.getElementById("attrs-table") as HTMLTableElement
const fieldsTable = document.getElementById("fields-table") as HTMLTableElement

let selectedId: string | null = null
const collapsed = new Set<string>()
let latestTree: ComponentTreeNode[] = []

const port = chrome.runtime.connect({ name: TREE_PORT_NAME })
port.postMessage({ type: "init", tabId: chrome.devtools.inspectedWindow.tabId })

port.onMessage.addListener((message: PanelResponse) => {
    if (message.type === "hookStatus") renderStatus(message.status)
    else if (message.type === "tree") renderTree(message.tree)
    else if (message.type === "details") renderDetails(message.details)
    else if (message.type === "contentScriptGone") renderStatus({ present: false, instances: [] }, true)
})

function refresh(): void {
    port.postMessage({ type: "requestHookStatus" })
    port.postMessage({ type: "requestTree" })
    if (selectedId) port.postMessage({ type: "requestDetails", id: selectedId })
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
    if (!details) {
        detailsEmpty.hidden = false
        detailsContent.hidden = true
        detailsEmpty.textContent = selectedId ? "This component is no longer present." : "Select a component to inspect it."
        return
    }
    detailsEmpty.hidden = true
    detailsContent.hidden = false
    detailsHeader.textContent = `${details.label}  (${details.kind})`
    renderFieldsTable(attrsTable, details.attrs, "No attrs.")
    renderFieldsTable(fieldsTable, details.fields, "No fields.")
}

function renderFieldsTable(table: HTMLTableElement, fields: FieldPreview[], emptyText: string): void {
    table.innerHTML = ""
    if (fields.length === 0) {
        const tr = document.createElement("tr")
        const td = document.createElement("td")
        td.className = "empty-note"
        td.textContent = emptyText
        tr.appendChild(td)
        table.appendChild(tr)
        return
    }
    for (const field of fields) {
        const tr = document.createElement("tr")
        const nameTd = document.createElement("td")
        nameTd.className = "field-name"
        nameTd.textContent = field.name
        const typeTd = document.createElement("td")
        typeTd.className = "field-type"
        typeTd.textContent = field.typeLabel
        const valueTd = document.createElement("td")
        valueTd.className = "field-value"
        valueTd.textContent = field.preview
        tr.append(nameTd, typeTd, valueTd)
        table.appendChild(tr)
    }
}
