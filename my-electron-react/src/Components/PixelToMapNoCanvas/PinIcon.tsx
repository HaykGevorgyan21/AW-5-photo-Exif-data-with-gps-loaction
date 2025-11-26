// ============================================================================
// FILE: src/components/PixelToMapNoCanvas/PinIcon.tsx
// ============================================================================
import React from "react";

export default function PinIcon({ n, scale = 1 }: { n: number; scale?: number }) {
    const r = 14, tail = 18;
    const W = 2 * (r + 4), H = r + tail + 6;
    const cx = W / 2, cy = r + 2;

    return (
        <svg width={W * scale} height={H * scale} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" style={{ display: "block" }}>
            <ellipse cx={cx} cy={H - 3} rx={r * 0.9} ry={4} fill="rgba(0,0,0,0.25)"/>
            <path
                d={`M ${cx - r} ${cy}
A ${r} ${r} 0 1 1 ${cx + r} ${cy}
Q ${cx} ${cy + tail} ${cx} ${cy + tail}
Q ${cx} ${cy + tail} ${cx - r} ${cy} Z`}
                fill="#D93025" stroke="#A12016" strokeWidth="1.5"
            />
            <circle cx={cx} cy={cy} r={r * 0.62} fill="#fff" />
            <text x={cx} y={cy + 1.5} textAnchor="middle" dominantBaseline="middle"
                  fontFamily="ui-monospace, Menlo, Consolas, monospace" fontWeight="700" fontSize="12" fill="#111">
                {n}
            </text>
        </svg>
    );
}
