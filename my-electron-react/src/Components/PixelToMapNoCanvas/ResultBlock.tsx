// ============================================================================
// FILE: src/components/PixelToMapNoCanvas/ResultBlock.tsx
// ============================================================================
import React from "react";
import s from "./PixelToMapNoCanvas.module.scss";

export default function ResultBlock({ out }: { out: string }) {
    return (
        <>
            <h3 className={s.h3}>Result</h3>
            <pre className={s.pre}>{out}</pre>
        </>
    );
}
