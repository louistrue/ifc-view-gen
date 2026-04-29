/**
 * web-ifc Emscripten logs `[WEB-IFC]…` to **stdout** (and sometimes stderr).
 * Patch both streams before ts-node / IFC so plan test output stays readable.
 */

function installWebIfcConsoleNoiseFilter() {
    const marker = '[WEB-IFC]'
    function shouldDrop(line) {
        return line.includes(marker)
    }

    /** @param {import('stream').Writable} stream */
    function patchStream(stream) {
        const origWrite = stream.write.bind(stream)
        let buf = ''
        let suppressedLines = 0
        let restored = false

        stream.write = function webIfcWriteFilter(chunk, encoding, cb) {
            if (restored) return origWrite(chunk, encoding, cb)
            let realCb
            if (typeof encoding === 'function') {
                realCb = encoding
            } else {
                realCb = cb
            }
            let s
            if (typeof chunk === 'string') s = chunk
            else if (Buffer.isBuffer(chunk)) s = chunk.toString('utf8')
            else s = Buffer.from(chunk).toString('utf8')
            buf += s
            let nl
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl + 1)
                buf = buf.slice(nl + 1)
                if (shouldDrop(line)) suppressedLines += 1
                else origWrite(line)
            }
            if (buf.length > 1_000_000) {
                if (!shouldDrop(buf)) origWrite(buf)
                buf = ''
            }
            if (typeof realCb === 'function') realCb()
            return true
        }

        return {
            getSuppressedLines: () => suppressedLines,
            restore: () => {
                if (restored) return
                restored = true
                stream.write = origWrite
                if (buf.length > 0 && !shouldDrop(buf)) origWrite(buf)
                buf = ''
            },
        }
    }

    const out = patchStream(process.stdout)
    const err = patchStream(process.stderr)

    return {
        restoreAll: () => {
            out.restore()
            err.restore()
        },
        getCounts: () => ({
            suppressedStdoutLines: out.getSuppressedLines(),
            suppressedStderrLines: err.getSuppressedLines(),
        }),
    }
}

installWebIfcConsoleNoiseFilter()

require('ts-node').register({
    skipProject: true,
    transpileOnly: true,
    compilerOptions: {
        module: 'commonjs',
        moduleResolution: 'node',
        target: 'es2020',
        esModuleInterop: true,
    },
})

require('./test-plan-door-visibility.ts')
