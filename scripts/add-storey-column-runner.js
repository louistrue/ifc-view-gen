/* eslint-disable */
/**
 * Bootstrap: filter web-ifc's `[WEB-IFC]` stdout/stderr chatter, then load the
 * TypeScript script via ts-node. Same pattern as airtable-render-round-runner.js.
 */

function installWebIfcConsoleNoiseFilter() {
    const marker = '[WEB-IFC]'
    function shouldDrop(line) {
        return line.includes(marker)
    }

    function patchStream(stream) {
        const origWrite = stream.write.bind(stream)
        let buf = ''
        stream.write = function webIfcWriteFilter(chunk, encoding, cb) {
            let realCb
            if (typeof encoding === 'function') realCb = encoding
            else realCb = cb
            let s
            if (typeof chunk === 'string') s = chunk
            else if (Buffer.isBuffer(chunk)) s = chunk.toString('utf8')
            else s = Buffer.from(chunk).toString('utf8')
            buf += s
            let nl
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl + 1)
                buf = buf.slice(nl + 1)
                if (!shouldDrop(line)) origWrite(line)
            }
            if (buf.length > 1_000_000) {
                if (!shouldDrop(buf)) origWrite(buf)
                buf = ''
            }
            if (typeof realCb === 'function') realCb()
            return true
        }
    }

    patchStream(process.stdout)
    patchStream(process.stderr)
}

installWebIfcConsoleNoiseFilter()

require('dotenv').config()

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

require('./add-storey-column.ts')
