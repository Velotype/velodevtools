// Copies files that don't need bundling into dist/: the manifest, icons, and every entry's HTML
// shell.
import { copy } from "@std/fs"

const root = new URL("../", import.meta.url)
const dist = new URL("dist/", root)

await Deno.remove(dist, { recursive: true }).catch(() => {})
await Deno.mkdir(dist, { recursive: true })

await copy(new URL("public/", root), dist, { overwrite: true })

const htmlShells = [
    "devtools/devtools.html",
    "panel-tree/panel.html",
    "panel-events/panel.html",
    "panel-velojson/panel.html",
    "popup/popup.html"
]
for (const relativePath of htmlShells) {
    const destination = new URL(relativePath, dist)
    await Deno.mkdir(new URL(".", destination), { recursive: true })
    await copy(new URL(`src/${relativePath}`, root), destination, { overwrite: true })
}
