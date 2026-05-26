// Stub for react-devtools-core. Ink statically imports `connectToDevTools`
// from it in build/devtools.js, but only calls it when DEV=true — which the
// shipped bundle never sets. Aliasing the package to this no-op lets esbuild
// bundle Ink without the optional devtools dependency present.
export function connectToDevTools() {}
export default {};
