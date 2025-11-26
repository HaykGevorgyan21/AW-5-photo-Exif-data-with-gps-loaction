// ============================================================================
// FILE: src/components/PixelToMapNoCanvas/GoogleEarthTools.tsx
// ============================================================================
import React from "react";
import s from "./PixelToMapNoCanvas.module.scss";

type HitPoint = {
    id: number; name: string; pixelU: number; pixelV: number;
    lat: number; lon: number; altAMSL: number; groundAltAMSL: number; agl: number;
};

export default function GoogleEarthTools({
                                             imgW, imgH, points, setPoints, setOut,
                                             applyCalibrationPreset, CALIB_ILCE5100_6000x4000,
                                             toGoogleEarthCoord, toDMS, copy, download, buildKML
                                         }: any) {
    return (
        <>
            <h3 className={s.h3}>Google Earth / KML</h3>
            <div className={s.monoDim}>(lon,lat,alt=ground AMSL)։</div>

            <div className={s.rowBtns}>
                <button
                    className={s.btn}
                    onClick={() => {
                        if (!imgW || !imgH) { setOut("Load an image first."); return; }
                        applyCalibrationPreset(CALIB_ILCE5100_6000x4000, imgW, imgH);
                    }}
                >
                    Apply ILCE-5100 calibration
                </button>

                <button className={s.btn} onClick={()=>{
                    if (!points.length) { setOut("No points to export."); return; }
                    const kml = buildKML(points as HitPoint[]);
                    download("aw_points.kml", kml);
                    setOut((prev:string)=>prev + `\nExported ${points.length} point(s) to aw_points.kml`);
                }}>Download KML</button>

                <button className={s.btn} onClick={()=>{
                    if (!points.length) { setOut("No points to copy."); return; }
                    const last = points[points.length - 1] as HitPoint;
                    copy(toGoogleEarthCoord(last.lon, last.lat, last.groundAltAMSL));
                }}>Copy last (lon,lat,alt)</button>

                <button className={s.btn} onClick={()=>{
                    if (!points.length) { setOut("No points to copy."); return; }
                    const last = points[points.length - 1] as HitPoint;
                    copy(`${last.lat.toFixed(7)}, ${last.lon.toFixed(7)}`);
                }}>Copy last (lat, lon)</button>

                <button className={s.btn} onClick={()=>{
                    if (!points.length) { setOut("No points to copy."); return; }
                    const last = points[points.length - 1] as HitPoint;
                    copy(`${toDMS(last.lat,true)}  ${toDMS(last.lon,false)}`);
                }}>Copy last (DMS)</button>

                <button className={s.btnDanger} onClick={()=>{ setPoints([]); setOut("Cleared points."); }}>
                    Clear points
                </button>
            </div>

            <div className={s.pointsTableWrap}>
                <table className={s.tbl}>
                    <thead>
                    <tr>
                        <th>#</th><th>Name</th><th>Pixel(u,v)</th><th>Lat</th><th>Lon</th>
                        <th>Alt(AMSL)</th><th>Ground(AMSL)</th><th>AGL</th><th>GE coord</th>
                    </tr>
                    </thead>
                    <tbody>
                    {points.map((p: HitPoint, idx: number)=>(
                        <tr key={p.id}>
                            <td>{idx+1}</td>
                            <td>{p.name}</td>
                            <td>({Math.round(p.pixelU)}, {Math.round(p.pixelV)})</td>
                            <td>{p.lat.toFixed(7)}</td>
                            <td>{p.lon.toFixed(7)}</td>
                            <td>{p.altAMSL.toFixed(2)}</td>
                            <td>{p.groundAltAMSL.toFixed(2)}</td>
                            <td>{p.agl.toFixed(2)}</td>
                            <td className={s.monoSmall}>{toGoogleEarthCoord(p.lon, p.lat, p.groundAltAMSL)}</td>
                        </tr>
                    ))}
                    {!points.length && (<tr><td colSpan={9} className={s.monoDim}>— no points yet —</td></tr>)}
                    </tbody>
                </table>
            </div>
        </>
    );
}
