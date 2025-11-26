// ============================================================================
// FILE: src/components/PixelToMapNoCanvas/ZoomedImage.tsx
// ============================================================================
import React from "react";
import s from "./PixelToMapNoCanvas.module.scss";

export default function ZoomedImage({
                                        src, imgW, imgH, scale, tx, ty,
                                    }: { src:string; imgW:number; imgH:number; scale:number; tx:number; ty:number }) {
    return (
        <div className={s.zoomWrap}>
            <img
                src={src}
                alt="loaded"
                draggable={false}
                className={s.zoomImg}
                style={{ transform: `translate(-50%, -50%) translate(${tx}px, ${ty}px) scale(${scale})` }}
            />
        </div>
    );
}
