require('dotenv').config()
require('ts-node').register({
    skipProject: true,
    transpileOnly: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2020', esModuleInterop: true },
})
require('./diag-doormesh-ids.ts')
