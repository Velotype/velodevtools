// Generates the extension's toolbar/devtools icons as plain PNGs using only Node's built-in
// zlib (no image library dependency). Draws a solid background square with a white "V" chevron.
import { deflateSync } from "node:zlib"
import { writeFileSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, "..", "public", "icons")
mkdirSync(outDir, { recursive: true })

const BG = [0x4f, 0x46, 0xe5] // indigo-600
const FG = [0xff, 0xff, 0xff]

const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
        }
        table[n] = c >>> 0
    }
    return table
})()

function crc32(buf) {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
    const typeBuf = Buffer.from(type, "ascii")
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32BE(data.length, 0)
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

/** Signed distance-ish test for a chevron ("V") shape centered in a size x size box */
function isChevronPixel(x, y, size) {
    // Normalize to 0..1
    const nx = x / size
    const ny = y / size
    const thickness = 0.22
    // Two diagonal strokes meeting at the bottom-center, like a checkmark/V
    const leftStroke = Math.abs((ny - 0.22) - (nx - 0.18) * 1.35) < thickness && nx < 0.52 && ny > 0.18 && ny < 0.82
    const rightStroke = Math.abs((ny - 0.82) - (0.82 - nx) * 1.35) < thickness && nx >= 0.48 && ny > 0.18 && ny < 0.82
    return leftStroke || rightStroke
}

function generatePng(size) {
    const raw = Buffer.alloc((size * 4 + 1) * size)
    let pos = 0
    for (let y = 0; y < size; y++) {
        raw[pos++] = 0 // filter type: none
        for (let x = 0; x < size; x++) {
            const fg = isChevronPixel(x, y, size)
            const [r, g, b] = fg ? FG : BG
            raw[pos++] = r
            raw[pos++] = g
            raw[pos++] = b
            raw[pos++] = 255
        }
    }

    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(size, 0)
    ihdr.writeUInt32BE(size, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // color type: RGBA
    ihdr[10] = 0
    ihdr[11] = 0
    ihdr[12] = 0

    const idat = deflateSync(raw)
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    return Buffer.concat([
        signature,
        chunk("IHDR", ihdr),
        chunk("IDAT", idat),
        chunk("IEND", Buffer.alloc(0))
    ])
}

for (const size of [16, 32, 48, 128]) {
    const png = generatePng(size)
    const path = join(outDir, `icon${size}.png`)
    writeFileSync(path, png)
    console.log(`wrote ${path} (${png.length} bytes)`)
}
