import React from "react";
import s from "./PixelToMapNoCanvas.module.scss";

export default function DebugBlock({
                                       dbgFlipPitch, setDbgFlipPitch,
                                       dbgFlipRoll,  setDbgFlipRoll,
                                       dbgAltOrder,  setDbgAltOrder,
                                       dbgAltBase,   setDbgAltBase,
                                       dbgInvertV,   setDbgInvertV,
                                       dbgYawOffset, setDbgYawOffset,
                                   }: any) {
    return (
        <>
            <h3 className={s.h3}>Debug / Orientation</h3>
            <div className={s.grid2}>
                <label className={s.chk}>
                    <input type="checkbox" checked={dbgFlipPitch} onChange={e=>setDbgFlipPitch(e.target.checked)} />
                    Flip pitch sign
                </label>
                <label className={s.chk}>
                    <input type="checkbox" checked={dbgFlipRoll} onChange={e=>setDbgFlipRoll(e.target.checked)} />
                    Flip roll sign
                </label>
                <label className={s.chk}>
                    <input type="checkbox" checked={dbgAltOrder} onChange={e=>setDbgAltOrder(e.target.checked)} />
                    Use Rz*Ry*Rx (else Rz*Rx*Ry)
                </label>
                <label className={s.chk}>
                    <input type="checkbox" checked={dbgAltBase} onChange={e=>setDbgAltBase(e.target.checked)} />
                    Use identity base (else ENU→cam default)
                </label>
                <label className={s.chk}>
                    <input type="checkbox" checked={dbgInvertV} onChange={e=>setDbgInvertV(e.target.checked)} />
                    Invert image v axis
                </label>
                <label className={s.lbl}>
                    Yaw offset (°)
                    <input
                        type="number" step={0.1} value={dbgYawOffset}
                        onChange={(e)=>setDbgYawOffset(parseFloat(e.target.value))}
                        className={s.input}
                    />
                </label>
            </div>
        </>
    );
}
