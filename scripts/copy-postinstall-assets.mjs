/**
 * Copies web-ifc WASM and @thatopen/fragments worker into public/ (Windows-safe).
 * Replaces Unix-only mkdir/cp in package.json postinstall.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function copyDirFiltered(srcDir, destDir, filter) {
    if (!fs.existsSync(srcDir)) {
        console.warn(`[postinstall-assets] Skip missing: ${srcDir}`)
        return 0
    }
    fs.mkdirSync(destDir, { recursive: true })
    let n = 0
    for (const name of fs.readdirSync(srcDir)) {
        if (!filter(name)) continue
        fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name))
        n++
    }
    return n
}

const wasmSrc = path.join(root, 'node_modules', 'web-ifc')
const wasmDest = path.join(root, 'public', 'wasm', 'web-ifc')
const wasmCount = copyDirFiltered(wasmSrc, wasmDest, (name) => name.endsWith('.wasm'))
if (wasmCount > 0) {
    console.log(`[postinstall-assets] Copied ${wasmCount} web-ifc WASM file(s) -> public/wasm/web-ifc/`)
} else {
    console.warn('[postinstall-assets] No .wasm files copied (install web-ifc first).')
}

const workerSrc = path.join(
    root,
    'node_modules',
    '@thatopen',
    'fragments',
    'dist',
    'Worker',
    'worker.mjs'
)
const workerDestDir = path.join(root, 'public', 'fragments-worker')
const workerDest = path.join(workerDestDir, 'worker.mjs')
if (fs.existsSync(workerSrc)) {
    fs.mkdirSync(workerDestDir, { recursive: true })
    fs.copyFileSync(workerSrc, workerDest)
    console.log('[postinstall-assets] Copied fragments worker -> public/fragments-worker/worker.mjs')
} else {
    console.warn(`[postinstall-assets] Missing fragments worker: ${workerSrc}`)
}
