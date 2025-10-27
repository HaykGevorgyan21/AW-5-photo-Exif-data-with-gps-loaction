// PixelToMapNoCanvas_sony_static_cam.tsx
// Static NADIR camera (always looks DOWN). No gimbal needed.
// Robust EXIF parse for SONY ILCE-5100 (and DJI fields if present).
// Pulls: lat, lon, AMSL, AGL/ground, yaw/pitch/roll (UserComment or DJI),
// FOV (EXIF FOV → 35mmEq → FocalLength+sensor width → manual fallback),
// handles EXIF Orientation, auto AMSL↔AGL linkage.
// Conventions: ENU (x=East, y=North, z=Up). Camera coords set so that:
// x_cam→East, y_cam→South, z_cam→Down (nadir base). So pixel +u=East, +v=South.

import React, { useRef, useState } from "react";
import * as exifr from "exifr";
import s from "./PixelToMapNoCanvas.module.scss";

// --- small DB of sensor widths (mm) for FOV calc when FocalLength is present ---
const SENSOR_WIDTH_MM_BY_MODEL: Record<string, number> = {
    "ILCE-5100": 23.5,
    "ILCE-6000": 23.5,
    "ILCE-6100": 23.5,
    "ILCE-6300": 23.5,
    "ILCE-6400": 23.5,
};

export default function PixelToMapNoCanvas({
                                               enableOpenCV = false, // kept for API compatibility; unused here
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
    const [fovx, setFovx] = useState(63); // deg fallback

    // ------------ pose (AMSL alt; yaw ENU 0=N +CW; pitch +down; roll +right) ------------
    const [lat, setLat] = useState<number>(0);
    const [lon, setLon] = useState<number>(0);
    const [alt_m, setAlt] = useState<number>(0);          // camera AMSL
    const [yaw, setYaw] = useState<number>(0);            // 0=N, +CW
    const [pitch, setPitch] = useState<number>(0);        // +down
    const [roll, setRoll] = useState<number>(0);          // +right
    const [groundAlt, setGroundAlt] = useState<number>(0);// ground AMSL
    const [agl, setAgl] = useState<number>(0);            // Height AGL

    // ------------ UI / misc ------------
    const [pixelStr, setPixelStr] = useState("");
    const [out, setOut] = useState("Select image, then click inside…");
    const [metaDump, setMetaDump] = useState<Record<string, any> | null>(null);
    const [orientation, setOrientation] = useState<string>("Horizontal (normal)");
    const [viewerOpen, setViewerOpen] = useState(false);

    // ------------ math helpers ------------
    const deg2rad = (d: number) => (d * Math.PI) / 180;
    function Rx(a: number) { const c = Math.cos(a), s = Math.sin(a); return [[1,0,0],[0,c,-s],[0,s,c]] as number[][]; }
    function Ry(a: number) { const c = Math.cos(a), s = Math.sin(a); return [[c,0,s],[0,1,0],[-s,0,c]] as number[][]; }
    function Rz(a: number) { const c = Math.cos(a), s = Math.sin(a); return [[c,-s,0],[s,c,0],[0,0,1]] as number[][]; }
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
    function normalize(v: number[]) { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/n, v[1]/n, v[2]/n]; }
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

    // ------------ parsing helpers ------------
    function numberFromMixedString(v: any): number | undefined {
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v === "string") {
            const m = v.match(/-?\d+(?:\.\d+)?/);
            if (m) return parseFloat(m[0]);
        }
        return undefined;
    }
    function parseDMSString(str: string): {value: number, ref?: string} | undefined {
        const rx = /(-?\d+(?:\.\d+)?)\s*(?:deg|°)?\s*(\d+(?:\.\d+)?)?\s*(?:'|m)?\s*(\d+(?:\.\d+)?)?\s*(?:\"|s)?\s*([NSEW])?/i;
        const m = str.match(rx);
        if (!m) return undefined;
        const D = parseFloat(m[1]);
        const M = m[2] ? parseFloat(m[2]) : 0;
        const S = m[3] ? parseFloat(m[3]) : 0;
        const ref = m[4]?.toUpperCase();
        let dec = Math.abs(D) + M/60 + S/3600;
        if (ref === "S" || ref === "W") dec = -dec;
        if (!ref && D < 0) dec = -dec;
        return { value: dec, ref };
    }
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
        if (typeof value === "string") {
            const dms = parseDMSString(value);
            if (dms) return dms.value;
            if (value.includes(",")) {
                const parts = value.split(",").map((p) => parseFloat(p.trim()));
                if (parts.length >= 3 && parts.every(Number.isFinite)) {
                    let dec = Math.abs(parts[0]) + parts[1]/60 + parts[2]/3600;
                    if (ref && /[SW]/i.test(ref)) dec = -dec;
                    if (!ref && parts[0] < 0) dec = -dec;
                    return dec;
                }
            }
        }
        const n = Number(value);
        return Number.isFinite(n) ? n : undefined;
    }
    function pickFirst<T = number>(obj: any, keys: string[], convert?: (v: any) => T | undefined): T | undefined {
        for (const k of keys) if (obj && k in obj) {
            const v = obj[k];
            const out = convert ? convert(v) : (v as T);
            if (out !== undefined && out !== null && !(Number.isNaN(out as any))) return out;
        }
        return undefined;
    }
    function parseUserComment(uc: any) {
        if (typeof uc !== "string") return {} as any;
        const kv: any = {};
        const rx = /(Lat|Lon|Pitch|Roll|Yaw)\s*=\s*(-?\d+(?:\.\d+)?)/gi;
        let m: RegExpExecArray | null;
        while ((m = rx.exec(uc)) !== null) kv[m[1].toLowerCase()] = parseFloat(m[2]);
        return kv; // { lat, lon, pitch, roll, yaw }
    }

    // ------------ Orientation → convert display u,v to sensor u,v ------------
    function uvDisplayToSensor(u: number, v: number) {
        switch ((orientation || "").toLowerCase()) {
            case "rotate 90 cw":
            case "right-top":
            case "6":
                return { u: v, v: imgW - u };
            case "rotate 270 cw":
            case "left-bottom":
            case "8":
                return { u: imgH - v, v: u };
            case "rotate 180":
            case "bottom-right":
            case "3":
                return { u: imgW - u, v: imgH - v };
            default: // Horizontal (normal)
                return { u, v };
        }
    }

    // ------------ ENU projection to ground (STATIC NADIR) ------------
    // Camera basis at nadir (no yaw/pitch/roll):
    // x_cam→East, y_cam→South, z_cam→Down. So pixel +u→East, +v→South.
    // Apply yaw (around Up), then pitch(+down) and roll(+right) as small tilts.
    function project(uDisp: number, vDisp: number) {
        const { u, v } = uvDisplayToSensor(uDisp, vDisp);

        const _fx = Number.isFinite(fx) && fx !== 0 ? fx : fxFromFovX(imgW, fovx);
        const _fy = Number.isFinite(fy) && fy !== 0 ? fy : _fx;
        const _cx = Number.isFinite(cx) ? cx : imgW / 2;
        const _cy = Number.isFinite(cy) ? cy : imgH / 2;

        const baseLat = Number.isFinite(lat) ? lat : 0;
        const baseLon = Number.isFinite(lon) ? lon : 0;

        // Base R that maps camera vector → ENU at perfect nadir, yaw=0
        // Columns are ENU axes of (x_cam, y_cam, z_cam):
        // x_cam(East)=[1,0,0], y_cam(South)=[0,-1,0], z_cam(Down)=[0,0,-1]
        const R_base = [
            [ 1,  0,  0],
            [ 0, -1,  0],
            [ 0,  0, -1],
        ] as number[][];

        // Apply yaw about Up (ENU z), then tilt by pitch(+down) about ENU x? and roll(+right) about ENU y?
        // Practically, body tilts are small; a good stable approximation is to rotate the camera frame
        // by yaw(pivot Up), then pitch about East(+down), then roll about North(+right):
        const R_yaw   = Rz( deg2rad(yaw || 0) );
        const R_pitch = Rx( deg2rad(pitch || 0) ); // +down ≈ rotate forward/down around East (x)
        const R_roll  = Ry( deg2rad(-roll || 0) ); // +right ≈ rotate around North (y), sign chosen to match screen right

        const R_enu_cam = matMul(R_yaw, matMul(R_pitch, matMul(R_roll, R_base)));

        // Pinhole ray in camera coords (z_cam forward is Down here)
        const x = (u - _cx) / _fx;
        const y = (v - _cy) / _fy;
        const d_cam = normalize([x, y, 1]); // points mostly Down
        const d_enu = matVec(R_enu_cam, d_cam); // ENU ray

        const dz = d_enu[2]; // Up component; for nadir ray dz should be negative
        if (Math.abs(dz) < 1e-12) return null;

        const camAlt = Number(alt_m) || 0;
        const gAlt   = Number(groundAlt) || 0;
        const t = (gAlt - camAlt) / dz; // intersect z = gAlt
        if (t < 0) return null; // up/behind

        const xE = t * d_enu[0];
        const yN = t * d_enu[1]; // note: positive to North

        const { mlat, mlon } = metersPerDeg(baseLat);
        return {
            lat: baseLat + yN / mlat,
            lon: baseLon + xE / mlon,
            range: Math.hypot(xE, yN),
        };
    }

    // ------------ Auto-fix “opposites” (light heuristic for bad sign combos) ------------
    function autoFixPose() {
        if (!imgW || !imgH) return;
        const u0 = imgW/2, v0 = imgH/2;

        type Conf = { pitch:number; roll:number; yaw:number; score:number; };
        const cand: Conf[] = [];
        const yawVars   = [ yaw, -yaw ];
        const pitchVars = [ pitch, -pitch ];
        const rollVars  = [ roll, -roll ];

        for (const yv of yawVars)
            for (const pv of pitchVars)
                for (const rv of rollVars) {
                    const bak = { yaw, pitch, roll };
                    setYaw(yv); setPitch(pv); setRoll(rv);
                    const hit = project(u0, v0) as any;
                    let score = Number.POSITIVE_INFINITY;
                    if (hit) {
                        const dz = Math.abs((() => {
                            // quick dz check
                            const _fx = fx || fxFromFovX(imgW, fovx);
                            const _fy = fy || _fx;
                            const R_base = [[1,0,0],[0,-1,0],[0,0,-1]];
                            const R = matMul(Rz(deg2rad(yv)), matMul(Rx(deg2rad(pv)), matMul(Ry(deg2rad(-rv)), R_base)));
                            const d_cam = normalize([0,0,1]);
                            const d_enu = matVec(R, d_cam);
                            return d_enu[2];
                        })());
                        const dist = Math.max(1, hit.range || 1);
                        score = dist + (1/(dz+1e-6))*50;
                    }
                    cand.push({ pitch: pv, roll: rv, yaw: yv, score });
                    setYaw(bak.yaw); setPitch(bak.pitch); setRoll(bak.roll);
                }

        cand.sort((a,b)=>a.score-b.score);
        const best = cand[0];
        if (!isFinite(best.score)) {
            setOut("Auto-fix: no valid ground intersection. Check AMSL/AGL.");
            return;
        }
        setYaw(best.yaw); setPitch(best.pitch); setRoll(best.roll);
        setOut(`Auto-fix → yaw=${best.yaw.toFixed(3)}  pitch=${best.pitch.toFixed(3)}  roll=${best.roll.toFixed(3)}`);
    }

    // ------------ file load + metadata parse ------------
    async function loadFile(f: File) {
        if (blobUrl) { URL.revokeObjectURL(blobUrl); setBlobUrl(null); }
        const url = URL.createObjectURL(f);
        setBlobUrl(url);

        const img = new Image();
        img.onload = async () => {
            setImgEl(img);
            setImgW(img.naturalWidth);
            setImgH(img.naturalHeight);
            setCx(img.naturalWidth / 2);
            setCy(img.naturalHeight / 2);
            setScale(1); setTx(0); setTy(0);

            try {
                const meta: any = await exifr.parse(f, {
                    xmp: true,
                    icc: false,
                    tiff: true,
                    jfif: true,
                    ihdr: true,
                    userComment: true,
                    makerNote: true,
                    multiSegment: true,
                });
                setMetaDump(meta ?? {});
                // Orientation
                const ori =
                    meta.CameraOrientation ??
                    meta.Orientation ??
                    meta["IFD0:Orientation"] ??
                    meta["orientation"];
                setOrientation(String(ori ?? "Horizontal (normal)"));

                // ---- Robust UserComment decode (Sony often stores bytes) ----
                let userComment = "";
                const ucRaw =
                    meta.UserComment ??
                    meta.userComment ??
                    meta["User Comment"] ??
                    meta.makerNote;
                if (ucRaw) {
                    if (typeof ucRaw === "string") {
                        userComment = ucRaw;
                    } else if (ucRaw instanceof Uint8Array || Array.isArray(ucRaw)) {
                        try {
                            const bytes = ucRaw instanceof Uint8Array ? ucRaw : new Uint8Array(ucRaw as any);
                            // Drop "ASCII\0\0\0" header if present
                            let start = 0;
                            if (bytes.length >= 8 &&
                                bytes[0]===0x41 && bytes[1]===0x53 && bytes[2]===0x43 && bytes[3]===0x49 && bytes[4]===0x49) {
                                start = 8;
                            }
                            // try ascii then utf-8
                            userComment = new TextDecoder("ascii").decode(bytes.slice(start)).trim();
                            if (!/Lat|Lon|Pitch|Roll|Yaw/i.test(userComment)) {
                                userComment = new TextDecoder("utf-8").decode(bytes.slice(start)).trim();
                            }
                        } catch { userComment = ""; }
                    }
                }
                const kc = parseUserComment(userComment); // lat, lon, pitch, roll, yaw?

                // Latitude/Longitude
                const latRef = meta.GPSLatitudeRef ?? meta.gpslatituderef ?? "N";
                const lonRef = meta.GPSLongitudeRef ?? meta.gpslongituderef ?? "E";
                const mLat = kc.lat ?? pickFirst<number>(meta, ["GPSLatitude", "latitude"], (v)=>toDecimalDegrees(v, latRef));
                const mLon = kc.lon ?? pickFirst<number>(meta, ["GPSLongitude", "longitude"], (v)=>toDecimalDegrees(v, lonRef));
                if (Number.isFinite(mLat)) setLat(mLat as number);
                if (Number.isFinite(mLon)) setLon(mLon as number);

                // Absolute altitude (AMSL) and RelativeAltitude (DJI) → AGL
                const absAltPref =
                    numberFromMixedString(pickFirst(meta, ["AbsoluteAltitude"])) ??
                    numberFromMixedString(pickFirst(meta, ["GPSAltitude", "altitude"]));
                const relAlt = numberFromMixedString(pickFirst(meta, ["RelativeAltitude"]));

                if (Number.isFinite(absAltPref)) setAlt(absAltPref as number);
                if (Number.isFinite(relAlt)) {
                    setAgl(relAlt as number);
                    if (Number.isFinite(absAltPref)) setGroundAlt((absAltPref as number) - (relAlt as number));
                } else {
                    const initAGL = (agl && agl>0) ? agl : 2;
                    setAgl(initAGL);
                    if (Number.isFinite(absAltPref)) setGroundAlt((absAltPref as number) - initAGL);
                }

                // Attitude: prefer DJI keys; else Sony UserComment
                const yawPref =
                    numberFromMixedString(pickFirst(meta, ["GimbalYawDegree","FlightYawDegree","CameraYaw","Yaw"])) ??
                    kc.yaw;
                const pitchPref =
                    numberFromMixedString(pickFirst(meta, ["GimbalPitchDegree","FlightPitchDegree","CameraPitch","Pitch"])) ??
                    kc.pitch;
                const rollPref =
                    numberFromMixedString(pickFirst(meta, ["GimbalRollDegree","FlightRollDegree","CameraRoll","Roll"])) ??
                    kc.roll;

                if (Number.isFinite(yawPref))   setYaw(yawPref as number);
                if (Number.isFinite(pitchPref)) setPitch(pitchPref as number);
                if (Number.isFinite(rollPref))  setRoll(rollPref as number);

                // ------ FOV / intrinsics ------
                // 1) Explicit FOV
                let fovxDeg =
                    numberFromMixedString(pickFirst(meta, ["FOV","HFOV","HorizontalFOV"])) ?? undefined;

                // 2) 35mm equivalent
                if (!Number.isFinite(fovxDeg)) {
                    const f35 = numberFromMixedString(
                        pickFirst(meta, ["FocalLengthIn35mmFormat","ExifIFD:FocalLengthIn35mmFilm"])
                    );
                    if (Number.isFinite(f35) && (f35 as number) > 0) {
                        const fx35 = (Number(f35) / 36) * img.naturalWidth;
                        setFx(fx35); setFy(fx35);
                    }
                }

                // 3) FocalLength (mm) + sensor width
                if ((!fx || !fy) || (fx===0 && fy===0)) {
                    const fmm = numberFromMixedString(pickFirst(meta, ["FocalLength"]));
                    const model = String(meta.Model || "");
                    const sensorW = SENSOR_WIDTH_MM_BY_MODEL[model] ?? undefined;
                    if (Number.isFinite(fmm) && (fmm as number) > 0 && Number.isFinite(sensorW)) {
                        const f = Number(fmm);
                        const sw = Number(sensorW);
                        fovxDeg = 2 * (180/Math.PI) * Math.atan((sw/2) / f);
                        const _fx = fxFromFovX(img.naturalWidth, fovxDeg);
                        setFx(_fx); setFy(_fx);
                    }
                }

                // 4) manual FOV fallback
                if ((!fx || !fy) || (fx===0 && fy===0)) {
                    const _fx = fxFromFovX(img.naturalWidth, fovx || 63);
                    setFx(_fx); setFy(_fx);
                }
                if (!Number.isFinite(cx) || !cx) setCx(img.naturalWidth / 2);
                if (!Number.isFinite(cy) || !cy) setCy(img.naturalHeight / 2);

                setOut("Metadata parsed. Click the image to compute ground point.");
            } catch (e) {
                const _fx = fxFromFovX(img.naturalWidth, fovx || 63);
                setFx(_fx); setFy(_fx); setCx(img.naturalWidth/2); setCy(img.naturalHeight/2);
                setOut("No readable metadata. Using FOVx fallback. Fill pose/alt/groundAlt (or AGL) and click on image.");
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

    // ------------ image interactions ------------
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
    const onMouseUp: React.MouseEventHandler<HTMLDivElement> = () => { setPanning(false); panStartRef.current = null; };
    const onMouseLeave: React.MouseEventHandler<HTMLDivElement> = () => { setPanning(false); panStartRef.current = null; };

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
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) { setOut("No GPS in metadata. Fill Latitude/Longitude first."); return; }

        // AMSL/AGL linkage
        if (Number.isFinite(alt_m) && Number.isFinite(agl)) setGroundAlt(alt_m - agl);
        if (!Number.isFinite(alt_m) || !Number.isFinite(groundAlt)) {
            setOut("Set Altitude (AMSL) and either Ground Alt (AMSL) or Height AGL.");
            return;
        }

        const hit = project(uv.u, uv.v) as any;
        if (!hit) { setOut("Ray didn’t hit the ground plane (up/behind). Check AMSL/AGL or pose."); return; }
        setOut([
            `Pixel (${uv.u.toFixed(1)}, ${uv.v.toFixed(1)})`,
            `Lat: ${hit.lat.toFixed(7)}`,
            `Lon: ${hit.lon.toFixed(7)}`,
            `groundAlt=${Number(groundAlt).toFixed(2)} m; alt=${Number(alt_m).toFixed(2)} m; AGL=${(alt_m - groundAlt).toFixed(2)} m`,
            `yaw=${Number(yaw).toFixed(2)}°, pitch=${Number(pitch).toFixed(2)}°, roll=${Number(roll).toFixed(2)}°`,
            `fx=${Number(fx).toFixed(2)}, fy=${Number(fy).toFixed(2)}, cx=${Number(cx).toFixed(2)}, cy=${Number(cy).toFixed(2)}`,
            `orientation: ${orientation}`,
        ].join("\n"));
    };
    const onDoubleClick: React.MouseEventHandler<HTMLDivElement> = () => { setScale(1); setTx(0); setTy(0); };

    // ------------ UI blocks ------------
    const PoseIntrinsicsBlock = (
        <>
            <h3 className={s.h3}>Pose (NADIR)</h3>
            {num("Latitude (°)", lat, setLat, 1e-7)}
            {num("Longitude (°)", lon, setLon, 1e-7)}
            {num("Altitude (m, AMSL)", alt_m, (v)=>{ setAlt(v); setGroundAlt(v - agl); })}
            <div className={s.grid2}>
                {num("Ground Alt (m, AMSL)", groundAlt, (v)=>{ setGroundAlt(v); setAgl(alt_m - v); })}
                {num("Height AGL (m)", agl, (v)=>{ setAgl(v); setGroundAlt(alt_m - v); })}
            </div>
            {num("Yaw (°)", yaw, setYaw, 0.01)}
            {num("Pitch (°, +down)", pitch, setPitch, 0.01)}
            {num("Roll (°, +right)", roll, setRoll, 0.01)}
            <button className={s.btn} onClick={autoFixPose}>Auto-fix pose</button>

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
            <button className={s.btn} onClick={()=>{
                if (!imgW) return;
                const _fx = fxFromFovX(imgW, fovx || 63);
                setFx(_fx); setFy(_fx); setCx(imgW/2); setCy(imgH/2);
                setOut("Intrinsics updated from FOVx.");
            }}>Apply intrinsics</button>

            <div className={s.monoDim}>EXIF Orientation: {String(orientation)}</div>
        </>
    );

    const ResultBlock = (
        <>
            <h3 className={s.h3}>Result</h3>
            <pre className={s.pre}>{out}</pre>

            <h4 className={s.h4}>Parsed Metadata (key fields)</h4>
            <pre className={s.preSmall}>
{metaDump ? JSON.stringify({
    Orientation: orientation,
    GPSLatitude: metaDump.GPSLatitude,
    GPSLongitude: metaDump.GPSLongitude,
    GPSAltitude: metaDump.GPSAltitude,
    GPSAltitudeRef: metaDump.GPSAltitudeRef,
    AbsoluteAltitude: metaDump.AbsoluteAltitude,
    RelativeAltitude: metaDump.RelativeAltitude,
    GimbalYawDegree: metaDump.GimbalYawDegree,
    GimbalPitchDegree: metaDump.GimbalPitchDegree,
    GimbalRollDegree: metaDump.GimbalRollDegree,
    FlightYawDegree: metaDump.FlightYawDegree,
    FlightPitchDegree: metaDump.FlightPitchDegree,
    FlightRollDegree: metaDump.FlightRollDegree,
    CameraYaw: metaDump.CameraYaw,
    CameraPitch: metaDump.CameraPitch,
    CameraRoll: metaDump.CameraRoll,
    FOV: metaDump.FOV,
    FocalLength: metaDump.FocalLength,
    FocalLengthIn35mmFormat: metaDump.FocalLengthIn35mmFormat,
    Model: metaDump.Model,
    Make: metaDump.Make,
    UserComment: metaDump.UserComment,
    ExifImageWidth: metaDump.ExifImageWidth,
    ExifImageHeight: metaDump.ExifImageHeight,
}, null, 2) : "—"}
      </pre>
        </>
    );

    return (
        <>
            <div className={s.rootGrid}>
                {/* Left */}
                <div className={s.panel}>
                    <div className={s.dropzone}>
                        <input type="file" accept="image/*"
                               onChange={(e)=>{ const f = e.target.files?.[0]; if (f) loadFile(f); }} />
                        <div className={s.dropHint}>Load Image (EXIF auto-parse)</div>
                    </div>

                    <div ref={previewRef} className={s.preview}
                         onClick={()=>blobUrl && setViewerOpen(true)}
                         title={blobUrl ? "Open large viewer" : "Load an image first"}>
                        {blobUrl && (<>
                            <ZoomedImage src={blobUrl} imgW={imgW} imgH={imgH} scale={1} tx={0} ty={0} />
                            <div className={s.previewOverlay}>Click to open viewer</div>
                        </>)}
                    </div>
                    <div className={s.monoDim}>zoom: preview</div>
                </div>

                {/* Middle */}
                <div className={s.panel}>{PoseIntrinsicsBlock}</div>

                {/* Right */}
                <div className={s.panel}>{ResultBlock}</div>
            </div>

            {/* ===== Modal Viewer ===== */}
            {viewerOpen && (
                <div role="dialog" aria-modal="true" className={s.modal}
                     onKeyDown={(e)=>{ if (e.key === "Escape") setViewerOpen(false); }}>
                    <div className={s.modalCard}>
                        <div className={s.modalHeader}>
                            <div className={s.title}>Image Viewer</div>
                            <div className={s.headerBtns}>
                                <button onClick={()=>{ setScale(1); setTx(0); setTy(0); }} className={s.btn}>Reset</button>
                                <button onClick={()=>setViewerOpen(false)} className={s.btn}>Close (Esc)</button>
                            </div>
                        </div>

                        <div className={s.modalBody}>
                            <div className={s.imagePane}>
                                <div ref={viewerRef}
                                     className={`${s.viewer} ${panning ? s.grabbing : s.crosshair}`}
                                     onMouseMove={onMove}
                                     onMouseDown={onMouseDown}
                                     onMouseUp={onMouseUp}
                                     onMouseLeave={onMouseLeave}
                                     onWheel={onWheel}
                                     onClick={onClickCompute}
                                     onDoubleClick={onDoubleClick}>
                                    {blobUrl && <ZoomedImage src={blobUrl} imgW={imgW} imgH={imgH} scale={scale} tx={tx} ty={ty} />}
                                </div>
                                <div className={s.monoBright}>{pixelStr} · zoom: {scale.toFixed(2)}</div>
                            </div>

                            <div className={s.infoPane}>{PoseIntrinsicsBlock}</div>
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
            <input type="number" step={step} value={Number.isFinite(value) ? value : 0}
                   onChange={(e)=>set(parseFloat(e.target.value))} className={s.input} />
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
function ZoomedImage({ src, imgW, imgH, scale, tx, ty }:
                         { src:string; imgW:number; imgH:number; scale:number; tx:number; ty:number }) {
    return (
        <div className={s.zoomWrap}>
            <img src={src} alt="loaded" draggable={false}
                 className={s.zoomImg}
                 style={{ transform: `translate(-50%, -50%) translate(${tx}px, ${ty}px) scale(${scale})` }} />
        </div>
    );
}
