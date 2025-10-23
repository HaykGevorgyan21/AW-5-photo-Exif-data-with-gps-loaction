// PixelToMapNoCanvas.tsx
import React, { useRef, useState } from "react";
import * as exifr from "exifr";
import s from "./PixelToMapNoCanvas.module.scss";

export default function PixelToMapNoCanvas({
                                               enableOpenCV = false,
                                               opencvUrl = "/opencv/opencv.js",
                                           }: {
    enableOpenCV?: boolean;
    opencvUrl?: string;
}) {
    // ------------ image / view state ------------
    const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
    const [imgW, setImgW] = useState(0);
    const [imgH, setImgH] = useState(0);
    const [blobUrl, setBlobUrl] = useState<string | null>(null);

    // zoom & pan (separate refs for preview vs viewer)
    const previewRef = useRef<HTMLDivElement | null>(null);
    const viewerRef = useRef<HTMLDivElement | null>(null);
    const [scale, setScale] = useState(1);
    const [tx, setTx] = useState(0);
    const [ty, setTy] = useState(0);
    const [panning, setPanning] = useState(false);
    const panStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
    const MIN_SCALE = 1, MAX_SCALE = 8;

    // ------------ intrinsics ------------
    const [fx, setFx] = useState(0);
    const [fy, setFy] = useState(0);
    const [cx, setCx] = useState(0);
    const [cy, setCy] = useState(0);
    const [fovx, setFovx] = useState(0); // deg

    // ------------ pose (AMSL alt; yaw ENU, pitch +down, roll +right) ------------
    const [lat, setLat] = useState<number>(0);
    const [lon, setLon] = useState<number>(0);
    const [alt_m, setAlt] = useState<number>(0); // camera AMSL
    const [yaw, setYaw] = useState<number>(0); // 0=N, +CW
    const [pitch, setPitch] = useState<number>(0); // +down
    const [roll, setRoll] = useState<number>(0); // +right
    const [groundAlt, setGroundAlt] = useState<number>(0); // ground AMSL

    // ------------ UI / misc ------------
    const [mount, setMount] = useState<"forward" | "nadir">("forward");
    const [pixelStr, setPixelStr] = useState("");
    const [out, setOut] = useState("Select image, then click inside…");
    const [metaDump, setMetaDump] = useState<Record<string, any> | null>(null);

    // modal
    const [viewerOpen, setViewerOpen] = useState(false);

    // ------------ math helpers ------------
    const deg2rad = (d: number) => (d * Math.PI) / 180;
    function Rx(a: number) {
        const c = Math.cos(a), s = Math.sin(a);
        return [[1,0,0],[0,c,-s],[0,s,c]] as number[][];
    }
    function Ry(a: number) {
        const c = Math.cos(a), s = Math.sin(a);
        return [[c,0,s],[0,1,0],[-s,0,c]] as number[][];
    }
    function Rz(a: number) {
        const c = Math.cos(a), s = Math.sin(a);
        return [[c,-s,0],[s,c,0],[0,0,1]] as number[][];
    }
    function matMul(A: number[][], B: number[][]) {
        const R = [[0,0,0],[0,0,0],[0,0,0]] as number[][];
        for (let i=0;i<3;i++) for (let j=0;j<3;j++)
            R[i][j] = A[i][0]*B[0][j] + A[i][1]*B[1][j] + A[i][2]*B[2][j];
        return R;
    }
    function matVec(A: number[][], v: number[]) {
        return [
            A[0][0]*v[0] + A[0][1]*v[1] + A[0][2]*v[2],
            A[1][0]*v[0] + A[1][1]*v[1] + A[1][2]*v[2],
            A[2][0]*v[0] + A[2][1]*v[1] + A[2][2]*v[2],
        ];
    }
    function normalize(v: number[]) {
        const n = Math.hypot(v[0], v[1], v[2]) || 1;
        return [v[0]/n, v[1]/n, v[2]/n];
    }
    function metersPerDeg(latDeg: number) {
        const L = deg2rad(latDeg || 0);
        const mlat = 111132.92 - 559.82 * Math.cos(2*L) + 1.175 * Math.cos(4*L) - 0.0023 * Math.cos(6*L);
        const mlon = 111412.84 * Math.cos(L) - 93.5 * Math.cos(3*L) + 0.118 * Math.cos(5*L);
        return { mlat, mlon };
    }
    function fxFromFovX(W: number, fovx_deg: number) {
        const half = Math.tan(deg2rad((fovx_deg || 1e-6)/2));
        return W/2 / Math.max(half, 1e-9);
    }

    // ------------ robust EXIF helpers ------------
    function toDecimalDegrees(value: any, ref?: string | null): number | undefined {
        if (Array.isArray(value) && value.length >= 3) {
            const [D,M,S] = value.map(Number);
            if ([D,M,S].every(Number.isFinite)) {
                let dec = Math.abs(D) + M/60 + S/3600;
                if (ref && /[SW]/i.test(ref)) dec = -dec;
                if (!ref && D < 0) dec = -dec;
                return dec;
            }
        }
        if (typeof value === "string" && value.includes(",")) {
            const parts = value.split(",").map((p) => parseFloat(p.trim()));
            if (parts.length >= 3 && parts.every(Number.isFinite)) {
                let dec = Math.abs(parts[0]) + parts[1]/60 + parts[2]/3600;
                if (ref && /[SW]/i.test(ref)) dec = -dec;
                if (!ref && parts[0] < 0) dec = -dec;
                return dec;
            }
        }
        const n = Number(value);
        return Number.isFinite(n) ? n : undefined;
    }
    function pickFirst<T = number>(obj: any, keys: string[], convert?: (v: any) => T | undefined): T | undefined {
        for (const k of keys) if (k in (obj ?? {})) {
            const v = obj[k];
            const out = convert ? convert(v) : (v as T);
            if (out !== undefined && out !== null && !(Number.isNaN(out as any))) return out;
        }
        return undefined;
    }
    function fxFrom35mm(W: number, f35mm?: number, fallbackFovxDeg?: number) {
        if (Number.isFinite(f35mm) && W > 0) return (Number(f35mm) / 36) * W;
        if (fallbackFovxDeg && W > 0) return fxFromFovX(W, fallbackFovxDeg);
        return undefined;
    }

    // ------------ projection ENU ------------
    function project(u: number, v: number) {
        const _fx = Number.isFinite(fx) && fx !== 0 ? fx : fxFromFovX(imgW, fovx);
        const _fy = Number.isFinite(fy) && fy !== 0 ? fy : _fx;
        const _cx = Number.isFinite(cx) ? cx : imgW / 2;
        const _cy = Number.isFinite(cy) ? cy : imgH / 2;

        const baseLat = Number.isFinite(lat) ? lat : 0;
        const baseLon = Number.isFinite(lon) ? lon : 0;

        // body from ENU with yaw→pitch→roll
        const R_enu_body = matMul(Rz(deg2rad(yaw || 0)), matMul(Ry(deg2rad(pitch || 0)), Rx(deg2rad(roll || 0))));
        // camera relative to body
        const R_body_cam = mount === "nadir"
            ? Rx(deg2rad(-90))
            : ([[1,0,0],[0,1,0],[0,0,1]] as number[][]);
        const R_enu_cam = matMul(R_enu_body, R_body_cam as number[][]);

        function trySolve(zSign: number) {
            const x = (u - _cx) / _fx, y = (v - _cy) / _fy;
            const d_cam = normalize([x, y, zSign]);   // pinhole ray
            const d_enu = matVec(R_enu_cam, d_cam);
            const dz = d_enu[2];
            if (Math.abs(dz) < 1e-9) return null;
            // alt_m & groundAlt must be AMSL
            const t = ((groundAlt || 0) - (alt_m || 0)) / dz;
            if (t < 0) return null; // ray goes upward / behind
            const xE = t * d_enu[0], yN = t * d_enu[1];
            const { mlat, mlon } = metersPerDeg(baseLat);
            return { lat: baseLat + yN / mlat, lon: baseLon + xE / mlon };
        }
        return trySolve(+1) ?? trySolve(-1);
    }

    // ------------ file load + metadata parse ------------
    async function loadFile(f: File) {
        if (blobUrl) {
            URL.revokeObjectURL(blobUrl);
            setBlobUrl(null);
        }
        const url = URL.createObjectURL(f);
        setBlobUrl(url);

        const img = new Image();
        img.onload = async () => {
            setImgEl(img);
            setImgW(img.naturalWidth);
            setImgH(img.naturalHeight);
            setCx(img.naturalWidth / 2);
            setCy(img.naturalHeight / 2);
            // reset view
            setScale(1); setTx(0); setTy(0);

            try {
                // exifr will parse EXIF + (most) XMP (DJI custom)
                const meta: any = await exifr.parse(f, { xmp: true, icc: false, tiff: true, jfif: true, ihdr: true });
                setMetaDump(meta ?? {});

                // ---- Lat/Lon ----
                const latRef = meta.GPSLatitudeRef ?? meta.gpslatituderef ?? null;
                const lonRef = meta.GPSLongitudeRef ?? meta.gpslongituderef ?? null;
                const mLat = pickFirst<number>(meta, ["GPSLatitude", "latitude"], (v) => toDecimalDegrees(v, latRef));
                const mLon = pickFirst<number>(meta, ["GPSLongitude", "longitude"], (v) => toDecimalDegrees(v, lonRef));
                if (Number.isFinite(mLat)) setLat(mLat as number);
                if (Number.isFinite(mLon)) setLon(mLon as number);

                // ---- Altitude (AMSL preferred) ----
                const gpsAlt = pickFirst<number>(meta, ["GPSAltitude", "altitude"], Number);
                const absAlt = pickFirst<number>(meta, ["AbsoluteAltitude", "drone-dji:AbsoluteAltitude"], Number);
                const relAlt = pickFirst<number>(meta, ["RelativeAltitude", "drone-dji:RelativeAltitude"], Number);
                // GPSAltitudeRef could be "Below Sea Level"
                const altRef = meta.GPSAltitudeRef;
                const gpsAltSigned = Number.isFinite(gpsAlt)
                    ? (String(altRef).toLowerCase().includes("below") ? -Number(gpsAlt) : Number(gpsAlt))
                    : undefined;

                let useAlt: number | undefined = undefined;
                if (Number.isFinite(absAlt)) useAlt = Number(absAlt);         // best
                else if (Number.isFinite(gpsAltSigned)) useAlt = gpsAltSigned;
                else if (Number.isFinite(relAlt) && Number.isFinite(groundAlt)) useAlt = Number(groundAlt) + Number(relAlt);
                if (Number.isFinite(useAlt)) setAlt(useAlt!);

                // ---- Yaw ----
                // Prefer explicit GPSImgDirection; else DJI FlightYaw/GimbalYaw
                const yawDeg =
                    pickFirst<number>(meta, ["GPSImgDirection", "gpsimgdirection"], Number) ??
                    pickFirst<number>(meta, ["FlightYawDegree", "drone-dji:FlightYawDegree", "GimbalYawDegree", "drone-dji:GimbalYawDegree"], Number);
                if (Number.isFinite(yawDeg)) setYaw(Number(yawDeg));

                // ---- Pitch (DJI uses "down is negative") → model expects +down
                const pitchDJI = pickFirst<number>(
                    meta,
                    [
                        "PosePitchDegrees",
                        "FlightPitchDegree", "drone-dji:FlightPitchDegree",
                        "GimbalPitchDegree", "drone-dji:GimbalPitchDegree",
                        "CameraPitch"
                    ],
                    Number
                );
                if (Number.isFinite(pitchDJI)) {
                    const p = -Number(pitchDJI); // invert to +down
                    setPitch(p);
                    if (Math.abs(p) > 60) setMount("nadir"); // likely down-looking
                }

                // ---- Roll ----
                const rollDeg = pickFirst<number>(
                    meta,
                    ["PoseRollDegrees", "GimbalRollDegree", "drone-dji:GimbalRollDegree", "CameraRoll"],
                    Number
                );
                if (Number.isFinite(rollDeg)) setRoll(Number(rollDeg));

                // ---- Intrinsics fx/fy from 35mm equivalence or FOV ----
                // Many DJI shots include FocalLengthIn35mmFormat (e.g., 24mm equiv) and FOV ~ 73.7 deg
                const f35 = pickFirst<number>(meta, ["FocalLengthIn35mmFormat", "ExifIFD:FocalLengthIn35mmFilm"], Number);
                const metaFov = pickFirst<number>(meta, ["FOV"], Number); // deg if present
                if (Number.isFinite(metaFov) && !Number.isFinite(fovx)) setFovx(Number(metaFov));
                const guessFx = fxFrom35mm(img.naturalWidth, f35, metaFov ?? fovx);
                const byFov = fxFromFovX(img.naturalWidth, (metaFov ?? fovx) || 73.7); // sane default for 24mm equiv on 4k wide
                setFx(Number.isFinite(guessFx) ? (guessFx as number) : byFov);
                setFy(Number.isFinite(guessFx) ? (guessFx as number) : byFov);
                if (!Number.isFinite(cx) || !cx) setCx(img.naturalWidth / 2);
                if (!Number.isFinite(cy) || !cy) setCy(img.naturalHeight / 2);

                setOut("EXIF/XMP parameters applied. Click the image to compute ground point.");
            } catch (e) {
                const _fx = fxFromFovX(img.naturalWidth, fovx || 73.7);
                setFx(_fx); setFy(_fx); setCx(img.naturalWidth/2); setCy(img.naturalHeight/2);
                setOut("No readable metadata. Using FOVx fallback. Fill pose/alt/groundAlt and click on image.");
            }
        };
        img.src = url;
    }

    // ------------ draw metrics (contain + zoom/pan) ------------
    function getDrawMetrics(which: "preview" | "viewer") {
        const host = which === "preview" ? previewRef.current : viewerRef.current;
        if (!host || !imgW || !imgH) return null;
        const rect = host.getBoundingClientRect();
        const contW = rect.width, contH = rect.height;
        const baseS = Math.min(contW / imgW, contH / imgH);
        const S = baseS * scale;
        const drawW = imgW * S, drawH = imgH * S;
        const offX = (contW - drawW) / 2 + tx;
        const offY = (contH - drawH) / 2 + ty;
        return { contW, contH, baseS, S, drawW, drawH, offX, offY };
    }

    // ------------ image interactions (VIEWER ONLY) ------------
    function pickUV(e: React.MouseEvent, which: "preview" | "viewer") {
        if (!imgEl) return null;
        const host = which === "preview" ? previewRef.current : viewerRef.current;
        if (!host) return null;
        const m = getDrawMetrics(which);
        if (!m) return null;
        const rect = host.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        const u = (x - m.offX) / m.S, v = (y - m.offY) / m.S;
        if (u < 0 || v < 0 || u >= imgW || v >= imgH) return null;
        return { u, v, x, y, metrics: m };
    }

    const onMove: React.MouseEventHandler<HTMLDivElement> = (e) => {
        if (panning && panStartRef.current && viewerRef.current) {
            const rect = viewerRef.current.getBoundingClientRect();
            const x = e.clientX - rect.left, y = e.clientY - rect.top;
            const dx = x - panStartRef.current.x, dy = y - panStartRef.current.y;
            setTx(panStartRef.current.tx + dx); setTy(panStartRef.current.ty + dy);
            return;
        }
        const uv = pickUV(e, "viewer");
        setPixelStr(uv ? `pixel: (${Math.round(uv.u)}, ${Math.round(uv.v)})` : "");
    };
    const onMouseDown: React.MouseEventHandler<HTMLDivElement> = (e) => {
        if (!viewerRef.current) return;
        const rect = viewerRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        panStartRef.current = { x, y, tx, ty };
        setPanning(true);
    };
    const onMouseUp: React.MouseEventHandler<HTMLDivElement> = () => {
        setPanning(false); panStartRef.current = null;
    };
    const onMouseLeave: React.MouseEventHandler<HTMLDivElement> = () => {
        setPanning(false); panStartRef.current = null;
    };

    const onWheel: React.WheelEventHandler<HTMLDivElement> = (e) => {
        if (!imgEl) return;
        e.preventDefault();
        const uv = pickUV(e as any, "viewer");
        const m = uv?.metrics || getDrawMetrics("viewer");
        if (!uv || !m) return;
        const factor = Math.pow(1.0015, -e.deltaY);
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
        if (newScale === scale) return;
        const Sprime = m.baseS * newScale;
        const offXprime = uv.x - uv.u * Sprime;
        const offYprime = uv.y - uv.v * Sprime;
        const txPrime = offXprime - (m.contW - imgW * Sprime) / 2;
        const tyPrime = offYprime - (m.contH - imgH * Sprime) / 2;
        setScale(newScale); setTx(txPrime); setTy(tyPrime);
    };

    const onClickCompute: React.MouseEventHandler<HTMLDivElement> = (e) => {
        if (!imgEl) { setOut("Load an image first."); return; }
        const uv = pickUV(e, "viewer");
        if (!uv) { setOut("Click is outside image."); return; }
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            setOut("No GPS in metadata. Fill Latitude/Longitude first."); return;
        }
        if (!Number.isFinite(alt_m) || !Number.isFinite(groundAlt)) {
            setOut("Set both Ground Alt (AMSL) and Altitude (AMSL)."); return;
        }

        const hit = project(uv.u, uv.v);
        if (!hit) {
            setOut("Ray didn’t hit the ground plane (up/behind). Check mount/pitch and AMSL vs AGL.");
            return;
        }
        setOut(
            [
                `Pixel (${uv.u.toFixed(1)}, ${uv.v.toFixed(1)})`,
                `Lat: ${hit.lat.toFixed(7)}`,
                `Lon: ${hit.lon.toFixed(7)}`,
                `groundAlt=${Number(groundAlt).toFixed(2)} m; alt=${Number(alt_m).toFixed(2)} m`,
                `yaw=${Number(yaw).toFixed(2)}°, pitch=${Number(pitch).toFixed(2)}°, roll=${Number(roll).toFixed(2)}°`,
                `fx=${Number(fx).toFixed(2)}, fy=${Number(fy).toFixed(2)}, cx=${Number(cx).toFixed(2)}, cy=${Number(cy).toFixed(2)}`,
                `mount: ${mount}`,
            ].join("\n")
        );
    };
    const onDoubleClick: React.MouseEventHandler<HTMLDivElement> = () => {
        setScale(1); setTx(0); setTy(0);
    };

    // ---- render blocks reused (compact vs viewer) ----
    const PoseIntrinsicsBlock = (
        <>
            <h3 className={s.h3}>Pose</h3>
            {num("Latitude (°)", lat, setLat, 1e-7)}
            {num("Longitude (°)", lon, setLon, 1e-7)}
            {num("Altitude (m, AMSL)", alt_m, setAlt, 0.01)}
            {num("Yaw (°)", yaw, setYaw, 0.01)}
            {num("Pitch (°, +down)", pitch, setPitch, 0.01)}
            {num("Roll (°, +right)", roll, setRoll, 0.01)}
            {num("Ground Alt (m, AMSL)", groundAlt, setGroundAlt, 0.01)}

            <h3 className={s.h3}>Intrinsics</h3>
            <div className={s.grid2}>
                {readonly("Image W (px)", imgW)}
                {readonly("Image H (px)", imgH)}
                {num("fx (px)", fx, setFx, 0.01)}
                {num("fy (px)", fy, setFy, 0.01)}
                {num("cx (px)", cx, setCx, 0.01)}
                {num("cy (px)", cy, setCy, 0.01)}
            </div>
            {num("FOVx (°) → auto fx/fy", fovx, setFovx, 0.01)}
            <button
                className={s.btn}
                onClick={() => {
                    if (!imgW) return;
                    const _fx = fxFromFovX(imgW, fovx || 73.7);
                    setFx(_fx); setFy(_fx);
                    setCx(imgW/2); setCy(imgH/2);
                    setOut("Intrinsics updated from FOVx.");
                }}
            >
                Apply intrinsics
            </button>

            <h3 className={s.h3}>Mount</h3>
            <select value={mount} onChange={(e) => setMount(e.target.value as any)} className={s.select}>
                <option value="forward">Forward (z along heading)</option>
                <option value="nadir">Down (nadir)</option>
            </select>
        </>
    );

    const ResultBlock = (
        <>
            <h3 className={s.h3}>Result</h3>
            <pre className={s.pre}>{out}</pre>

            <h4 className={s.h4}>EXIF/XMP (важные поля)</h4>
            <pre className={s.preSmall}>
        {metaDump
            ? JSON.stringify(
                {
                    GPSLatitude: metaDump.GPSLatitude,
                    GPSLatitudeRef: metaDump.GPSLatitudeRef,
                    GPSLongitude: metaDump.GPSLongitude,
                    GPSLongitudeRef: metaDump.GPSLongitudeRef,
                    GPSAltitude: metaDump.GPSAltitude,
                    GPSAltitudeRef: metaDump.GPSAltitudeRef,
                    GPSImgDirection: metaDump.GPSImgDirection,
                    RelativeAltitude: metaDump.RelativeAltitude ?? metaDump["drone-dji:RelativeAltitude"],
                    AbsoluteAltitude: metaDump.AbsoluteAltitude ?? metaDump["drone-dji:AbsoluteAltitude"],
                    FlightYawDegree: metaDump.FlightYawDegree ?? metaDump["drone-dji:FlightYawDegree"],
                    FlightPitchDegree: metaDump.FlightPitchDegree ?? metaDump["drone-dji:FlightPitchDegree"],
                    GimbalPitchDegree: metaDump.GimbalPitchDegree ?? metaDump["drone-dji:GimbalPitchDegree"],
                    PosePitchDegrees: metaDump.PosePitchDegrees,
                    PoseRollDegrees: metaDump.PoseRollDegrees,
                    FOV: metaDump.FOV,
                    FocalLengthIn35mmFormat: metaDump.FocalLengthIn35mmFormat,
                    Make: metaDump.Make,
                    Model: metaDump.Model,
                },
                null,
                2
            )
            : "—"}
      </pre>
        </>
    );

    // ------------ UI ------------
    return (
        <>
            <div className={s.rootGrid}>
                {/* Left (preview) */}
                <div className={s.panel}>
                    <div className={s.dropzone}>
                        <input
                            type="file"
                            accept="image/*"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); }}
                        />
                        <div className={s.dropHint}>Load Image (EXIF auto-parse)</div>
                    </div>

                    <div
                        ref={previewRef}
                        className={s.preview}
                        onClick={() => blobUrl && setViewerOpen(true)}
                        title={blobUrl ? "Open large viewer" : "Load an image first"}
                    >
                        {blobUrl && (
                            <>
                                <ZoomedImage src={blobUrl} imgW={imgW} imgH={imgH} scale={1} tx={0} ty={0} />
                                <div className={s.previewOverlay}>Click to open viewer</div>
                            </>
                        )}
                    </div>
                    <div className={s.monoDim}>zoom: preview</div>
                </div>

                {/* Middle (pose/intrinsics quick) */}
                <div className={s.panel}>{PoseIntrinsicsBlock}</div>

                {/* Right (result quick) */}
                <div className={s.panel}>{ResultBlock}</div>
            </div>

            {/* ===== Modal Viewer ===== */}
            {viewerOpen && (
                <div
                    role="dialog"
                    aria-modal="true"
                    className={s.modal}
                    onKeyDown={(e) => { if (e.key === "Escape") setViewerOpen(false); }}
                >
                    <div className={s.modalCard}>
                        {/* header */}
                        <div className={s.modalHeader}>
                            <div className={s.title}>Image Viewer</div>
                            <div className={s.headerBtns}>
                                <button onClick={() => { setScale(1); setTx(0); setTy(0); }} className={s.btn}>Reset</button>
                                <button onClick={() => setViewerOpen(false)} className={s.btn}>Close (Esc)</button>
                            </div>
                        </div>

                        {/* body */}
                        <div className={s.modalBody}>
                            {/* big image with full interactions */}
                            <div className={s.imagePane}>
                                <div
                                    ref={viewerRef}
                                    className={`${s.viewer} ${panning ? s.grabbing : s.crosshair}`}
                                    onMouseMove={onMove}
                                    onMouseDown={onMouseDown}
                                    onMouseUp={onMouseUp}
                                    onMouseLeave={onMouseLeave}
                                    onWheel={onWheel}
                                    onClick={onClickCompute}
                                    onDoubleClick={onDoubleClick}
                                >
                                    {blobUrl && <ZoomedImage src={blobUrl} imgW={imgW} imgH={imgH} scale={scale} tx={tx} ty={ty} />}
                                </div>
                                <div className={s.monoBright}>
                                    {pixelStr} · zoom: {scale.toFixed(2)}
                                </div>
                            </div>

                            {/* middle (full controls) */}
                            <div className={s.infoPane}>{PoseIntrinsicsBlock}</div>

                            {/* right (result) */}
                            <div className={s.resultPane}>{ResultBlock}</div>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

// ---- small inputs ----
function num(label: string, value: number, set: (v: number) => void, step: number = 1) {
    return (
        <label className={s.lbl}>
            {label}
            <input
                type="number"
                step={step}
                value={Number.isFinite(value) ? value : 0}
                onChange={(e) => set(parseFloat(e.target.value))}
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

// ---- image with CSS transform for visual zoom/pan ----
function ZoomedImage({
                         src, imgW, imgH, scale, tx, ty
                     }: { src: string; imgW: number; imgH: number; scale: number; tx: number; ty: number }) {
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

// ---- tiny style helper ----
export const btnStyle: React.CSSProperties = {};
