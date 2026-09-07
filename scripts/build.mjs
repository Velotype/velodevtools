import * as esbuild from "esbuild"
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")
const dist = join(root, "dist")
const watch = process.argv.includes("--watch")

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

// Static files that don't need bundling: manifest, icons, and every entry's HTML shell.
cpSync(join(root, "public"), dist, { recursive: true })
const htmlShells = {
    "devtools/devtools.html": "devtools/devtools.html",
    "panel-tree/panel.html": "panel-tree/panel.html",
    "panel-events/panel.html": "panel-events/panel.html",
    "panel-velojson/panel.html": "panel-velojson/panel.html",
    "popup/popup.html": "popup/popup.html"
}
for (const [src, out] of Object.entries(htmlShells)) {
    mkdirSync(join(dist, dirname(out)), { recursive: true })
    cpSync(join(root, "src", src), join(dist, out))
}

const entryPoints = [
    "src/background/service-worker.ts",
    "src/content/page-hook.ts",
    "src/content/bridge.ts",
    "src/devtools/devtools.ts",
    "src/panel-tree/panel.ts",
    "src/panel-events/panel.ts",
    "src/panel-velojson/panel.ts",
    "src/popup/popup.ts"
]

const buildOptions = {
    entryPoints,
    outdir: dist,
    outbase: "src",
    bundle: true,
    format: "iife",
    target: "chrome111",
    sourcemap: true,
    logLevel: "info"
}

if (watch) {
    const ctx = await esbuild.context(buildOptions)
    await ctx.watch()
    console.log("watching for changes...")
} else {
    await esbuild.build(buildOptions)
}
