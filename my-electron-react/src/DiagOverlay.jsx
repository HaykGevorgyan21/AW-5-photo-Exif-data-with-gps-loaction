// FILE: src/DiagOverlay.jsx
import { useEffect, useState } from 'react'

export default function DiagOverlay() {
    const [steps, setSteps] = useState([
        { k: 'boot',    ok: false, msg: 'Renderer boot' },
        { k: 'assets',  ok: false, msg: 'Assets loaded' },
        { k: 'opencv',  ok: false, msg: 'OpenCV ready (optional)' }
    ])
    const setOk = (k, ok, extra) =>
        setSteps(s => s.map(i => i.k === k ? { ...i, ok, msg: extra || i.msg } : i))

    useEffect(() => {
        setOk('boot', true)
        // crude assets check: ensure main bundle tag present
        const hasJs = [...document.querySelectorAll('script')].some(s => /assets\/.+\.js/.test(s.src))
        const hasCss = [...document.querySelectorAll('link[rel=stylesheet]')].some(l => /assets\/.+\.css/.test(l.href))
        setOk('assets', hasJs && hasCss, hasJs && hasCss ? 'Assets found' : 'Assets missing!')
        // OpenCV (optional)
        const cv = window.cv
        if (cv && (cv.getBuildInformation || cv.Mat)) setOk('opencv', true, 'OpenCV present')
    }, [])

    return (
        <div style={{
            position:'fixed', inset:10, padding:12, border:'1px solid #999',
            background:'rgba(255,255,255,.9)', fontFamily:'ui-monospace,monospace',
            fontSize:12, zIndex:999999, borderRadius:8
        }}>
            <div style={{fontWeight:700, marginBottom:6}}>Diagnostics</div>
            {steps.map(s=>(
                <div key={s.k}>
                    <span style={{display:'inline-block', width:16}}>{s.ok ? '✅' : '❌'}</span>
                    {s.msg}
                </div>
            ))}
        </div>
    )
}
