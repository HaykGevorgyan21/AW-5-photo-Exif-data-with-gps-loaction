// ============================================================================
// FILE: src/components/PixelToMapNoCanvas/DEMBlock.tsx
// ============================================================================
import React from "react";
import s from "./PixelToMapNoCanvas.module.scss";

type DemState = {
    summary?: string;
    isGeographic4326?: boolean;
} | null;

export default function DEMBlock({
                                     dem,
                                     autoSampleDEM,
                                     setAutoSampleDEM,
                                     loadDEM,
                                     relinkAGLWithDEM,
                                     lat,
                                     lon
                                 }: {
    dem: DemState;
    autoSampleDEM: boolean;
    setAutoSampleDEM: (v: boolean) => void;
    loadDEM: (f: File) => Promise<void>;
    relinkAGLWithDEM: () => Promise<void>;
    lat: number;
    lon: number;
}) {
    return (
        <>
            <h3 className={s.h3}>Offline Ground Elevation (DEM)</h3>
            <div className={s.monoDim}>DEM GeoTIFF ( SRTM/ASTER, EPSG:4326),։</div>
            <div className={s.rowBtns}>
                <input
                    type="file"
                    accept=".tif,.tiff,image/tiff,application/octet-stream"
                    onChange={e => { const f = e.target.files?.[0]; if (f) loadDEM(f); }}
                />
                <label className={s.chk}>
                    <input
                        type="checkbox"
                        checked={autoSampleDEM}
                        onChange={e => setAutoSampleDEM(e.target.checked)}
                    />
                    Auto-sample DEM @ camera GPS (link AMSL↔AGL)
                </label>
                <button
                    className={s.btn}
                    onClick={relinkAGLWithDEM}
                    disabled={!Number.isFinite(lat) || !Number.isFinite(lon)}
                >
                    Sample now @ (lat,lon)
                </button>
            </div>
            <pre className={s.preSmall}>{dem?.summary || "— DEM not loaded —"}</pre>
            {!dem?.isGeographic4326 && dem && (
                <div className={s.warn}>
                    ⚠ DEM CRS is unknown (or not EPSG:4326). Results may be incorrect; a 4326 GeoTIFF is recommended.
                </div>
            )}
        </>
    );
}
