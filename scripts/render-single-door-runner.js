require('ts-node').register({
    skipProject: true,
    transpileOnly: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2020', esModuleInterop: true },
})
require('./render-single-door.ts')
