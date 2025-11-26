// ============================================================================
// FILE: src/components/PixelToMapNoCanvas/ModalViewer.tsx
// ============================================================================
import React from "react";
import PinIcon from "./PinIcon";
import ZoomedImage from "./ZoomedImage";
import s from "./PixelToMapNoCanvas.module.scss";

type HitPoint = {
    id: number; name: string; pixelU: number; pixelV: number;
    lat: number; lon: number; altAMSL: number; groundAltAMSL: number; agl: number;
};

export default function ModalViewer({
                                        viewerOpen, setViewerOpen,
                                        open, setOpen,
                                        viewerRef, panning, setPanning, onMove, onMouseDown, onMouseUp, onMouseLeave, onWheel,
                                        onClickCompute, onDoubleClick,
                                        blobUrl, imgW, imgH, scale, setScale, tx, setTx, ty, setTy,
                                        points, imgUVtoScreen, cursorPos, pixelStr,
                                        MAX_SCALE, MIN_SCALE,
                                        downloadAnnotatedImage,
                                        PoseIntrinsicsPanel, GoogleEarthToolsPanel, ResultPanel,
                                    }: any) {
    return !viewerOpen ? null : (
        <div role="dialog" aria-modal="true" className={s.modal}
             onKeyDown={(e)=>{ if (e.key === "Escape") setViewerOpen(false); }}>
            <div className={s.modalCard}>
                <div className={s.modalHeader}>
                    <div className={s.title}>Image Viewer</div>
                    <div className={s.headerBtns}>
                        <button className={s.btn} title={open ? "Hide side panels" : "Show side panels"} onClick={() => setOpen((o:boolean) => !o)}>
                            {open ? "✖ Hide panels" : "☰ Show panels"}
                        </button>
                        <button className={s.btn} title="Zoom in"  onClick={() => setScale((prev:number) => Math.min(prev * 1.25, MAX_SCALE))}>Zoom ➕</button>
                        <button className={s.btn} title="Zoom out" onClick={() => setScale((prev:number) => Math.max(prev / 1.25, MIN_SCALE))}>Zoom ➖</button>
                        <button className={s.btn} title="Unselect all points"
                                onClick={() => { /* parent cleans points + out, keep as is */ }}>
                            🧹 Clear points
                        </button>
                        <button className={s.btn} onClick={() => downloadAnnotatedImage("Aw-img.png")}>Download image</button>
                        <button className={s.btn} onClick={() => { setScale(1); setTx(0); setTy(0); }}>Reset ↺</button>
                        <button className={s.btn} onClick={() => setViewerOpen(false)}>Close (Esc)</button>
                    </div>
                </div>

                <div className={`${s.modalBody} ${open ? s.panesOpen : s.panesClosed}`}>
                    <div className={`${s.imagePane} ${open ? s.panesClosed : s.imagepaneS}`}>
                        <div
                            ref={viewerRef}
                            className={`${s.viewer} ${panning ? s.grabbing : s.cursorPos}`}
                            onMouseMove={onMove}
                            onMouseDown={onMouseDown}
                            onMouseUp={onMouseUp}
                            onMouseLeave={onMouseLeave}
                            onWheel={onWheel}
                            onClick={onClickCompute}
                            onDoubleClick={onDoubleClick}
                        >
                            {blobUrl && <ZoomedImage src={blobUrl} imgW={imgW} imgH={imgH} scale={scale} tx={tx} ty={ty} />}
                            {points.map((p: HitPoint, idx: number) => {
                                const pos = imgUVtoScreen(p.pixelU, p.pixelV, "viewer");
                                if (!pos) return null;
                                return (
                                    <div key={p.id} className={s.marker} style={{ left: pos.x, top: pos.y, transform: "translate(-50%, -100%)" }}>
                                        <PinIcon n={idx + 1} />
                                    </div>
                                );
                            })}
                            {cursorPos && <div className={s.aim} style={{ left: cursorPos.x, top: cursorPos.y }} />}
                        </div>
                        <div className={s.monoBright}>{pixelStr} · zoom: {scale.toFixed(2)}</div>
                    </div>

                    <div className={s.infoPane} aria-hidden={!open}>{PoseIntrinsicsPanel}</div>
                    <div className={s.resultPane} aria-hidden={!open}>
                        {GoogleEarthToolsPanel}
                        {ResultPanel}
                    </div>
                </div>
            </div>
        </div>
    );
}
