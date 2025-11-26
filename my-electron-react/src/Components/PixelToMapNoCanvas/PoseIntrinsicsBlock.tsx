// ============================================================================
// FILE: src/components/PixelToMapNoCanvas/PoseIntrinsicsBlock.tsx
// ============================================================================
import React from "react";
import s from "./PixelToMapNoCanvas.module.scss";

export default function PoseIntrinsicsBlock({
                                                // pose
                                                lat, setLat, lon, setLon, alt_m, setAlt, groundAlt, setGroundAlt, agl, setAgl,
                                                yaw, setYaw, pitch, setPitch, roll, setRoll,
                                                autoFixPose,
                                                // intrinsics
                                                imgW, imgH, fx, setFx, fy, setFy, cx, setCx, cy, setCy,
                                                k1, setK1, k2, setK2, p1, setP1, p2, setP2, k3, setK3,
                                                fovx, setFovx, onApplyIntrinsics,
                                                // exif orientation
                                                oriNormalized, orientation, oriWas
                                            }: any) {
    return (
        <>
            <h3 className={s.h3}>Pose (NADIR)</h3>
            {num("Latitude (°)", lat, setLat, 1e-7)}
            {num("Longitude (°)", lon, setLon, 1e-7)}
            {num("Altitude (m, AMSL)", alt_m, (v:number)=>{ setAlt(v); setGroundAlt(v - agl); })}
            <div className={s.grid2}>
                {num("Ground Alt (m, AMSL)", groundAlt, (v:number)=>{ setGroundAlt(v); setAgl(alt_m - v); })}
                {num("Height AGL (m)", agl, (v:number)=>{ setAgl(v); setGroundAlt(alt_m - v); })}
            </div>
            {num("Yaw (°)",   yaw,   setYaw,   0.01)}
            {num("Pitch (°, +down)", pitch, setPitch, 0.01)}
            {num("Roll (°, +right)", roll,  setRoll,  0.01)}
            <button className={s.btn} onClick={autoFixPose}>Auto-fix pose</button>

            <h3 className={s.h3}>Intrinsics</h3>
            <div className={s.grid2}>
                {readonly("Image W (px)", imgW)}
                {readonly("Image H (px)", imgH)}
                {num("fx (px)", fx, setFx, 0.01)}
                {num("fy (px)", fy, setFy, 0.01)}
                {num("cx (px)", cx, setCx, 0.01)}
                {num("cy (px)", cy, setCy, 0.01)}
                {num("k1", k1, setK1, 1e-7)}
                {num("k2", k2, setK2, 1e-7)}
                {num("p1", p1, setP1, 1e-7)}
                {num("p2", p2, setP2, 1e-7)}
                {num("k3", k3, setK3, 1e-7)}
            </div>
            {num("FOVx (°) → auto fx/fy", fovx, setFovx, 0.01)}
            <button className={s.btn} onClick={onApplyIntrinsics}>Apply intrinsics</button>

            <div className={s.monoDim}>
                EXIF Orientation: {oriNormalized ? "Horizontal (normal)" : String(orientation)}
                {oriWas ? ` · was ${oriWas}` : ""}
            </div>
        </>
    );
}

function num(label: string, value: number, set: (v: number) => void, step: number = 1) {
    return (
        <label className={s.lbl}>
            {label}
            <input
                type="number"
                step={step}
                value={Number.isFinite(value) ? value : 0}
                onChange={(e)=>set(parseFloat(e.target.value))}
                className={s.input}
            />
        </label>
    );
}
function readonly(label: string, value: number | string) {
    return (
        <label className={s.lbl}>
            {label}
            <input type="text" readOnly value={String(value)} className={s.inputReadonly} />
        </label>
    );
}
