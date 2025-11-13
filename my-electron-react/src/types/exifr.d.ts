declare module 'exifr' {
    export function parse(input: ArrayBuffer | Blob | File | string, options?: Record<string, unknown>): Promise<Record<string, unknown> | undefined>
    const _default: { parse: typeof parse }
    export default _default
}
