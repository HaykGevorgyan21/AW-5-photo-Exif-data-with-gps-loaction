// ============================================================================
// FILE: src/components/PixelToMapNoCanvas/PixelToMapNoCanvas_sony_static_cam.tsx
// NOTE: This is your original file, with logic kept intact. Only big JSX blocks
//       are delegated into the small presentational components above.
// ============================================================================
import React, { useRef, useState, useEffect } from "react";
import * as exifr from "exifr";
import { fromArrayBuffer, GeoTIFF, GeoTIFFImage } from "geotiff";
import s from "./PixelToMapNoCanvas.module.scss";
import { createPortal } from "react-dom";

import PinIcon from "./PinIcon";
import ZoomedImage from "./ZoomedImage";
import DEMBlock from "./DEMBlock";
import PoseIntrinsicsBlock from "./PoseIntrinsicsBlock";
import GoogleEarthTools from "./GoogleEarthTools";
import ResultBlock from "./ResultBlock";
import ModalViewer from "./ModalViewer";

// --- sensor widths for FOV estimation ---
const SENSOR_WIDTH_MM_BY_MODEL: Record<string, number> = {
    "ILCE-5100": 23.5, "ILCE-6000": 23.5, "ILCE-6100": 23.5, "ILCE-6300": 23.5, "ILCE-6400": 23.5,
};

// ---- calibration preset (Sony ILCE-5100 @ 6000x4000) ----
const CALIB_ILCE5100_6000x4000 = {
    W: 6000, H: 4000,
    fx: 6398.08616, fy: 6432.14696, cx: 2959.871024, cy: 1963.453368,
    k1: -0.0232568293, k2: -0.403632348, p1:  0.00123362391, p2: -0.00155940272, k3:  2.41647816,
} as const;

const DEM_OFFSET_M = 20;

type HitPoint = {
    id: number; name: string; pixelU: number; pixelV: number; lat: number; lon: number;
    altAMSL: number; groundAltAMSL: number; agl: number;
};
type DemState = {
    tiff?: GeoTIFF; img?: GeoTIFFImage; width?: number; height?: number;
    originX?: number; originY?: number; resX?: number; resY?: number;
    noData?: number | null; isGeographic4326?: boolean; unit?: string; summary?: string;
} | null;

export default function PixelToMapNoCanvas({
                                               enableOpenCV = false, opencvUrl = "/opencv/opencv.js",
                                           }: { enableOpenCV?: boolean; opencvUrl?: string; }) {
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
    const [fovx, setFovx] = useState(54.55);
    const [k1, setK1] = useState(0);
    const [k2, setK2] = useState(0);
    const [p1, setP1] = useState(0);
    const [p2, setP2] = useState(0);
    const [k3, setK3] = useState(0);

    // ------------ pose ------------
    const [lat, setLat] = useState<number>(0);
    const [lon, setLon] = useState<number>(0);
    const [alt_m, setAlt] = useState<number>(0);
    const [yaw, setYaw] = useState<number>(0);
    const [pitch, setPitch] = useState<number>(0);
    const [roll, setRoll] = useState<number>(0);
    const [groundAlt, setGroundAlt] = useState<number>(0);
    const [agl, setAgl] = useState<number>(0);
    const [cursorPos, setCursorPos] = useState<{x:number; y:number} | null>(null);

    // --- Debug flags (quick orientation/intrinsics trials)
    const [dbgFlipPitch, setDbgFlipPitch] = useState(false);
    const [dbgFlipRoll, setDbgFlipRoll]   = useState(false);
    const [dbgAltOrder, setDbgAltOrder]   = useState(false); // false: Rz*Rx*Ry, true: Rz*Ry*Rx
    const [dbgAltBase, setDbgAltBase]     = useState(false); // false: [[1,0,0],[0,-1,0],[0,0,-1]] ; true: identity
    const [dbgInvertV, setDbgInvertV]     = useState(false); // invert image v when normalizing
    const [dbgYawOffset, setDbgYawOffset] = useState(0);     // degrees, adds to yaw


    // ------------ UI / misc ------------
    const [pixelStr, setPixelStr] = useState("");
    const [out, setOut] = useState("Load the image, then click on it…");
    const [metaDump, setMetaDump] = useState<Record<string, any> | null>(null);
    const [orientation, setOrientation] = useState<string>("Horizontal (normal)");
    const [viewerOpen, setViewerOpen] = useState(false);
    const [open, setOpen] = useState(true);
    const [downloading, setDownloading] = useState(false);

    // points for KML
    const [points, setPoints] = useState<HitPoint[]>([]);
    const [nameCounter, setNameCounter] = useState(1);

    // ---- DEM handling ----
    const [dem, setDem] = useState<DemState>(null);
    const [autoSampleDEM, setAutoSampleDEM] = useState<boolean>(true);

    // Was orientation normalized?
    const [metaOrig, setMetaOrig] = useState<Record<string, any> | null>(null);
    const [oriWas, setOriWas] = useState<number | null>(null);
    const [oriNormalized, setOriNormalized] = useState<boolean>(false);
    const [loadingImage, setLoadingImage] = useState(false);

    // ===================== (ALL YOUR ORIGINAL HELPERS BELOW — UNCHANGED) =====================
    function measureTextBlock(ctx: CanvasRenderingContext2D, lines: string[]) {
        let w = 0;
        for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
        const lineH = parseInt(ctx.font, 10) * 1.35;
        const h = lineH * lines.length;
        return { w, h, lineH };
    }
    function drawPointLabel(
        ctx: CanvasRenderingContext2D, u: number, v: number, lines: string[], s = 1, imageW?: number, imageH?: number
    ) {
        ctx.save();
        ctx.font = `${Math.round(14 * s)}px ui-monospace, Menlo, Consolas, monospace`;
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        const padX = 8 * s, padY = 6 * s, gapFromMarker = 12 * s;
        const { w, h, lineH } = measureTextBlock(ctx, lines);
        let boxW = w + padX * 2, boxH = h + padY * 2;
        let x = u + gapFromMarker, y = v - (boxH + gapFromMarker);
        if (imageW !== undefined && x + boxW > imageW - 4 * s) x = u - gapFromMarker - boxW;
        if (imageH !== undefined && y < 4 * s) y = v + gapFromMarker;
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.strokeStyle = "#ff2d2d"; ctx.lineWidth = 2 * s;
        roundRect(ctx, x, y, boxW, boxH, 8 * s); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#111";
        let ty0 = y + padY;
        for (const ln of lines) { ctx.fillText(ln, x + padX, ty0); ty0 += lineH; }
        ctx.restore();
    }

    type NormResult = { file: File; before?: number; rotated?: boolean };
    async function readExifOrientation(file: File): Promise<number | undefined> {
        try {
            const o = await (exifr as any).orientation?.(file);
            return (typeof o === "number" && o >= 1 && o <= 8) ? o : undefined;
        } catch { return undefined; }
    }
    function imgFromObjectURL(url: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = url;
        });
    }
    function applyOrientationTransform(ctx: CanvasRenderingContext2D, ori: number, w: number, h: number): { W: number; H: number } {
        switch (ori) {
            case 2: ctx.translate(w, 0); ctx.scale(-1, 1); return { W: w, H: h };
            case 3: ctx.translate(w, h); ctx.rotate(Math.PI); return { W: w, H: h };
            case 4: ctx.translate(0, h); ctx.scale(1, -1); return { W: w, H: h };
            case 5: ctx.translate(h, 0); ctx.rotate(Math.PI / 2); ctx.scale(-1, 1); return { W: h, H: w };
            case 6: ctx.translate(0, w); ctx.rotate(-0.5 * Math.PI); return { W: h, H: w };
            case 7: ctx.translate(0, w); ctx.rotate(-Math.PI / 2); ctx.scale(-1, 1); return { W: h, H: w };
            case 8: ctx.translate(0, w); ctx.rotate(-Math.PI / 2); return { W: h, H: w };
            case 1:
            default: return { W: w, H: h };
        }
    }
    function applyCalibrationPreset(preset: typeof CALIB_ILCE5100_6000x4000, imgW_now: number, imgH_now: number) {
        const sx = imgW_now / preset.W;
        const sy = imgH_now / preset.H;
        setFx(preset.fx * sx); setFy(preset.fy * sy);
        setCx(preset.cx * sx); setCy(preset.cy * sy);
        setK1(preset.k1); setK2(preset.k2); setP1(preset.p1); setP2(preset.p2); setK3(preset.k3);
        setOut(prev => prev + `\nApplied ILCE-5100 calibration (${preset.W}x${preset.H}) → scaled to ${imgW_now}x${imgH_now}`);
    }
    function rotateToLandscapeIfNeeded(canvas: HTMLCanvasElement) {
        if (canvas.height > canvas.width) {
            const tmp = document.createElement("canvas");
            tmp.width = canvas.height; tmp.height = canvas.width;
            const tctx = tmp.getContext("2d")!;
            tctx.translate(0, tmp.height); tctx.rotate(-0.5 * Math.PI);
            tctx.drawImage(canvas, 0, 0);
            canvas.width = tmp.width; canvas.height = tmp.height;
            const c2 = canvas.getContext("2d")!;
            c2.drawImage(tmp, 0, 0);
            return true;
        }
        return false;
    }
    async function normalizeOnUpload(file: File, forceLandscape = true): Promise<NormResult> {
        const before = await readExifOrientation(file);
        const url = URL.createObjectURL(file);
        try {
            const img = await imgFromObjectURL(url);
            const w = img.naturalWidth, h = img.naturalHeight;
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d")!;
            const { W, H } = applyOrientationTransform(ctx, before ?? 1, w, h);
            canvas.width = W; canvas.height = H;
            const ctx2 = canvas.getContext("2d")!;
            applyOrientationTransform(ctx2, before ?? 1, w, h);
            ctx2.drawImage(img, 0, 0);
            let rotated = false;
            if (forceLandscape) rotated = rotateToLandscapeIfNeeded(canvas) || rotated;
            const blob: Blob = await new Promise((res) => canvas.toBlob(b => res(b!), "image/jpeg", 0.95));
            const out = new File([blob], file.name.replace(/\.(jpe?g)$/i, "_upright.$1"), { type: "image/jpeg" });
            return { file: out, before, rotated };
        } finally { URL.revokeObjectURL(url); }
    }

    function distortNormXY(x: number, y: number) {
        const r2 = x*x + y*y; const r4 = r2*r2, r6 = r4*r2;
        const radial = 1 + k1*r2 + k2*r4 + k3*r6;
        const x_tan = 2*p1*x*y + p2*(r2 + 2*x*x);
        const y_tan = p1*(r2 + 2*y*y) + 2*p2*x*y;
        return { xd: x*radial + x_tan, yd: y*radial + y_tan };
    }
    function undistortPixel(u: number, v: number, fx:number, fy:number, cx:number, cy:number) {
        const xn = (u - cx)/fx; const yn = (v - cy)/fy;
        let xu = xn, yu = yn;
        for (let i=0; i<5; i++) {
            const r2 = xu*xu + yu*yu; const r4 = r2*r2, r6 = r4*r2;
            const radial = 1 + k1*r2 + k2*r4 + k3*r6;
            const x_tan = 2*p1*xu*yu + p2*(r2 + 2*xu*xu);
            const y_tan = p1*(r2 + 2*yu*yu) + 2*p2*xu*yu;
            const x_est = xu*radial + x_tan; const y_est = yu*radial + y_tan;
            const ex = x_est - xn; const ey = y_est - yn; xu -= ex; yu -= ey;
        }
        return { uu: xu*fx + cx, vv: yu*fy + cy };
    }

    async function projectOnDEM(uDisp: number, vDisp: number) {
        const basic = (() => {
            const { u, v } = uvDisplayToSensor(uDisp, vDisp);
            const _fx = Number.isFinite(fx) && fx !== 0 ? fx : fxFromFovX(imgW, fovx);
            const _fy = Number.isFinite(fy) && fy !== 0 ? fy : _fx;
            const _cx = Number.isFinite(cx) ? cx : imgW/2;
            const _cy = Number.isFinite(cy) ? cy : imgH/2;
            let uu = u, vv = v;
            if (k1 || k2 || k3 || p1 || p2) {
                const uv = undistortPixel(u, v, _fx, _fy, _cx, _cy);
                uu = uv.uu; vv = uv.vv;
            }
            const x = (uu - _cx)/_fx, y = (vv - _cy)/_fy;
            const R_base = [[1,0,0],[0,-1,0],[0,0,-1]] as number[][];
            const R_yaw   = Rz(deg2rad(yaw || 0));
            const R_pitch = Rx(deg2rad(-(pitch || 0)));
            const R_roll  = Ry(deg2rad(roll || 0));
            const R_enu_cam = matMul(R_yaw, matMul(R_pitch, matMul(R_roll, R_base)));
            const d_enu = normalize( matVec(R_enu_cam, [x, y, 1]) );
            return { d_enu, _fx, _fy };
        })();
        if (!basic) return null;
        const { d_enu } = basic;
        const dz = d_enu[2];
        if (Math.abs(dz) < 1e-6) return null;
        let t = ( (groundAlt ?? 0) - (alt_m ?? 0) ) / dz;
        if (!Number.isFinite(t) || t < 0) t = 1;
        let latCur = lat, lonCur = lon;
        for (let i=0; i<8; i++) {
            const { mlat, mlon } = metersPerDeg(latCur);
            const xE = t * d_enu[0]; const yN = t * d_enu[1];
            const latGuess = lat + yN / mlat; const lonGuess = lon + xE / mlon;
            const zGround = (dem ? await sampleDEM_AMSL(latGuess, lonGuess) : groundAlt) ?? groundAlt;
            if (!Number.isFinite(zGround)) break;
            const tNew = (zGround - (alt_m ?? 0)) / dz;
            if (!Number.isFinite(tNew) || tNew < 0) break;
            if (Math.abs(tNew - t) < 0.05) { return { lat: latGuess, lon: lonGuess, range: Math.hypot(xE, yN) }; }
            t = tNew; latCur = latGuess; lonCur = lonGuess;
        }
        const { mlat, mlon } = metersPerDeg(latCur);
        const xE = t * d_enu[0], yN = t * d_enu[1];
        return { lat: lat + yN/mlat, lon: lon + xE/mlon, range: Math.hypot(xE, yN) };
    }

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
        const mlat = 111132.92 - 559.82*Math.cos(2*L) + 1.175*Math.cos(4*L) - 0.0023*Math.cos(6*L);
        const mlon = 111412.84*Math.cos(L) - 93.5*Math.cos(3*L) + 0.118*Math.cos(5*L);
        return { mlat, mlon };
    }
    function fxFromFovX(W: number, fovx_deg: number) {
        const half = Math.tan(deg2rad((fovx_deg || 1e-6)/2));
        return W/2 / Math.max(half, 1e-9);
    }
    function normalizeYawFromMeta(meta: Record<string, any>, fallback?: number): number | undefined {
        const maker = String(meta.Make || meta.make || "").toUpperCase();
        const model = String(meta.Model || meta.model || "").toUpperCase();
        const raw =
            numberFromMixedString(pickFirst(meta, ["GimbalYawDegree","FlightYawDegree","CameraYaw","Yaw"])) ?? fallback;
        if (!Number.isFinite(raw)) return undefined;
        const y = Number(raw);
        const isCompassCW = maker.includes("DJI") || maker.includes("SONY");
        const yawMath = isCompassCW ? (360 - (y % 360) + 360) % 360 : (y % 360);
        return yawMath;
    }

    function markerScale() {
        if (!imgW) return 1;
        if (imgW >= 8000) return 3.0;
        if (imgW >= 6000) return 2.5;
        if (imgW >= 4000) return 2.0;
        if (imgW >= 3000) return 1.6;
        return 1.3;
    }
    async function downloadAnnotatedImage(
        filename = "Aw-img.jpg",
        opts: { mode?: "legend" | "inline"; format?: "png" | "jpeg"; quality?: number } = {}
    ) {
        if (!imgEl || !imgW || !imgH) { setOut("Load an image first."); return; }
        const mode = opts.mode ?? "legend";
        const format = opts.format ?? (filename.toLowerCase().endsWith(".png") ? "png" : "jpeg");
        const mime = format === "jpeg" ? "image/jpeg" : "image/png";
        const quality = typeof opts.quality === "number" ? opts.quality : (format === "jpeg" ? 0.92 : undefined);
        setDownloading(true);
        try {
            await new Promise<void>(r => requestAnimationFrame(() => r()));
            const legendW = mode === "legend"
                ? Math.round(Math.max(380, Math.min(1200, imgW * 0.26)))
                : 0;
            const totalW = imgW + legendW;
            const canvas = document.createElement("canvas");
            canvas.width = totalW; canvas.height = imgH;
            const ctx = canvas.getContext("2d", { alpha: false })!;
            ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
            if ("decode" in imgEl && typeof (imgEl as any).decode === "function") { try { await (imgEl as any).decode(); } catch {} }
            ctx.drawImage(imgEl, 0, 0, imgW, imgH);
            const sScale = markerScale();
            points.forEach((p, idx) => { drawMarker(ctx, p.pixelU, p.pixelV, idx + 1, sScale); });
            if (mode === "legend" && legendW > 0) {
                drawLegendPanel(ctx, imgW, 0, legendW, imgH, points);
            } else if (mode === "inline") {
                points.forEach((p, idx) => {
                    const lines = [`#${idx + 1} ${p.name}`, `Lat ${p.lat.toFixed(7)}`, `Lon ${p.lon.toFixed(7)}`];
                    drawPointLabel(ctx, p.pixelU, p.pixelV, lines, sScale, imgW, imgH);
                });
            }
            const blob: Blob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob((b) => b ? resolve(b) : reject(new Error("toBlob() returned null")), mime, quality);
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
            setOut(`✅ Saved ${filename} (${(blob.size/1024/1024).toFixed(2)} MB)`);
        } catch (err: any) {
            console.error(err);
            setOut("Download failed: " + (err?.message ?? String(err)));
        } finally { setDownloading(false); }
    }
    function drawLegendPanel(
        ctx: CanvasRenderingContext2D, x0: number, y0: number, W: number, H: number, pts: HitPoint[]
    ) {
        ctx.save();
        ctx.fillStyle = "#ffffff"; ctx.fillRect(x0, y0, W, H);
        const pad = Math.round(Math.max(16, H * 0.012));
        let fs = Math.round(Math.max(12, Math.min(28, H * 0.022)));
        const lineH = Math.round(fs * 1.55);
        const headH = Math.round(fs * 1.9);
        const gapX = Math.round(pad * 0.9);
        const sampleCanvas = document.createElement("canvas");
        const mctx = sampleCanvas.getContext("2d")!;
        mctx.font = `600 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
        const sample = "#88 PXX  Lat 00.0000000  Lon 00.0000000";
        const colW = Math.ceil(mctx.measureText(sample).width) + pad;
        const rowsPerCol = Math.max(1, Math.floor((H - pad*2 - headH) / lineH));
        const cols = Math.max(1, Math.ceil(pts.length / rowsPerCol));
        const effectiveCols = Math.min(cols, Math.max(1, Math.floor((W - pad*2 + gapX) / (colW + gapX)))) || 1;
        ctx.font = `700 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
        ctx.fillStyle = "#111"; ctx.textBaseline = "top";
        ctx.fillText("Legend (Lat/Lon)", x0 + pad, y0 + pad);
        ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(x0 + pad, y0 + pad + headH); ctx.lineTo(x0 + W - pad, y0 + pad + headH); ctx.stroke();
        let col = 0, row = 0;
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const colX = x0 + pad + col * (colW + gapX);
            const rowY = y0 + pad + headH + row * lineH;
            if (row % 2 === 1) { ctx.fillStyle = "#fafafa"; ctx.fillRect(colX - 6, rowY - Math.round(lineH*0.12), colW + 12, lineH); }
            ctx.fillStyle = "#111";
            ctx.font = `600 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
            const idx = (i + 1).toString().padStart(2, " ");
            const name = (p.name || "").padEnd(3, " ");
            const latTxt = p.lat.toFixed(7).padStart(11, " ");
            const lonTxt = p.lon.toFixed(7).padStart(11, " ");
            const line = `#${idx} ${name}  Lat ${latTxt}  Lon ${lonTxt}`;
            ctx.fillText(line, colX, rowY);
            row++; if (row >= rowsPerCol) { row = 0; col++; }
        }
        ctx.restore();
    }
    function roundRect(ctx: CanvasRenderingContext2D, x:number,y:number,w:number,h:number,r:number){
        const rr = Math.min(r, w/2, h/2);
        ctx.beginPath();
        ctx.moveTo(x+rr,y); ctx.lineTo(x+w-rr,y);
        ctx.quadraticCurveTo(x+w,y,x+w,y+rr);
        ctx.lineTo(x+w,y+h-rr);
        ctx.quadraticCurveTo(x+w,y+h,x+w-rr,y+h);
        ctx.lineTo(x+rr,y+h);
        ctx.quadraticCurveTo(x,y+h,x,y+h-rr);
        ctx.lineTo(x,y+rr);
        ctx.quadraticCurveTo(x,y,x+rr,y);
    }
    function drawMarker(ctx: CanvasRenderingContext2D, u: number, v: number, idx: number, s = 1) {
        const r = 14 * s; const tail = 18 * s; const cy = v - tail; const cx0 = u;
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.beginPath(); ctx.ellipse(cx0, v + 3 * s, r * 0.9, 4 * s, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath();
        ctx.arc(cx0, cy, r, Math.PI, 0, false);
        ctx.quadraticCurveTo(cx0 + r * 0.85, cy + tail * 0.55, cx0, v);
        ctx.quadraticCurveTo(cx0 - r * 0.85, cy + tail * 0.55, cx0 - r, cy);
        ctx.closePath();
        ctx.fillStyle = "#D93025"; ctx.strokeStyle = "#A12016"; ctx.lineWidth = 1.5 * s; ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx0, cy, r * 0.62, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill();
        const txt = String(idx);
        ctx.fillStyle = "#111"; ctx.font = `${Math.round(12 * s)}px ui-monospace, Menlo, Consolas, monospace`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(txt, cx0, cy + 1.5 * s);
        ctx.restore();
    }

    function toDMS(value: number, isLat: boolean) {
        const hemi = isLat ? (value >= 0 ? "N" : "S") : (value >= 0 ? "E" : "W");
        const abs = Math.abs(value);
        const D = Math.floor(abs);
        const Mfull = (abs - D) * 60;
        const M = Math.floor(Mfull);
        const S = (Mfull - M) * 60;
        return `${D}° ${M}' ${S.toFixed(3)}" ${hemi}`;
    }
    function toGoogleEarthCoord(lon: number, lat: number, altAMSL?: number) {
        if (Number.isFinite(altAMSL)) return `${lon.toFixed(7)},${lat.toFixed(7)},${Number(altAMSL).toFixed(2)}`;
        return `${lon.toFixed(7)},${lat.toFixed(7)}`;
    }
    function escapeXml(st: string) {
        return st.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
    }
    function buildKML(points: HitPoint[]) {
        const header = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>AW Points</name>
    <Style id="awPoint">
      <IconStyle><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/red-circle.png</href></Icon></IconStyle>
    </Style>`;
        const body = points.map((p, idx) => {
            const name = `#${idx+1} ${p.name}`;
            const coord = toGoogleEarthCoord(p.lon, p.lat, p.groundAltAMSL);
            return `
    <Placemark>
      <name>${escapeXml(name)}</name>
      <styleUrl>#awPoint</styleUrl>
      <Point><coordinates>${coord}</coordinates></Point>
      <description><![CDATA[
        Pixel: (${Math.round(p.pixelU)}, ${Math.round(p.pixelV)})<br/>
        Lat: ${p.lat.toFixed(7)}<br/>
        Lon: ${p.lon.toFixed(7)}<br/>
        Alt AMSL: ${p.altAMSL.toFixed(2)}<br/>
        Ground AMSL: ${p.groundAltAMSL.toFixed(2)}<br/>
        AGL: ${p.agl.toFixed(2)}
      ]]></description>
    </Placemark>`;
        }).join("\n");
        const footer = `  </Document>\n</kml>`;
        return header + "\n" + body + "\n" + footer;
    }
    async function copy(text: string) {
        try { await navigator.clipboard.writeText(text); setOut(prev => prev + `\nCopied.`); }
        catch { /* ignore */ }
    }
    function download(filename: string, content: string, mime = "application/vnd.google-earth.kml+xml") {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

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
        return kv;
    }

    function uvDisplayToSensor(uDisp: number, vDisp: number) {
        if (oriNormalized) return { u: uDisp, v: vDisp };
        const ori = (orientation || "").toLowerCase();
        switch (ori) {
            case "rotate 90 cw": case "right-top": case "6":
                return { u: vDisp, v: imgH - uDisp };
            case "rotate 270 cw": case "left-bottom": case "8":
                return { u: imgW - vDisp, v: uDisp };
            case "rotate 180": case "bottom-right": case "3":
                return { u: imgW - uDisp, v: imgH - vDisp };
            default:
                return { u: uDisp, v: vDisp };
        }
    }

    // ------------ Projection to ground (static nadir) ------------
    function project(uDisp: number, vDisp: number) {
        const { u, v } = uvDisplayToSensor(uDisp, vDisp);

        const _fx = Number.isFinite(fx) && fx !== 0 ? fx : fxFromFovX(imgW, fovx);
        const _fy = Number.isFinite(fy) && fy !== 0 ? fy : _fx;
        const _cx = Number.isFinite(cx) ? cx : imgW / 2;
        const _cy = Number.isFinite(cy) ? cy : imgH / 2;

        // undistort
        let uU = u, vU = v;
        if (k1 || k2 || k3 || p1 || p2) {
            const uv = undistortPixel(u, v, _fx, _fy, _cx, _cy);
            uU = uv.uu; vU = uv.vv;
        }

        // optional invert v (օգնում է, երբ y_cam ուղղվածությունն այլ է)
        const x = (uU - _cx) / _fx;
        const y = ((dbgInvertV ? (imgH - vU) : vU) - _cy) / _fy;

        const baseLat = Number.isFinite(lat) ? lat : 0;
        const baseLon = Number.isFinite(lon) ? lon : 0;

        // base
        const R_base = dbgAltBase
            ? ([ [1,0,0],[0,1,0],[0,0,1] ] as number[][])
            : ([ [1,0,0],[0,-1,0],[0,0,-1] ] as number[][]);

        // angles (apply debug flips + yaw offset)
        const yawDeg   = (yaw || 0) + (dbgYawOffset || 0);
        const pitchDeg = dbgFlipPitch ? -(pitch || 0) : (pitch || 0);
        const rollDeg  = dbgFlipRoll  ? -(roll  || 0) : (roll  || 0);

        // երկու տարբեր ռոտացիոն հերթականություն՝ արագ փորձարկելու համար
        const Rz_yaw = Rz(deg2rad(yawDeg));
        const Rx_roll = Rx(deg2rad(rollDeg));
        const Ry_pitch = Ry(deg2rad(pitchDeg));

        // false => Rz * Rx * Ry (քո հինը), true => Rz * Ry * Rx (այլընտրանք)
        const R_enu_cam = dbgAltOrder
            ? matMul(Rz_yaw, matMul(Ry_pitch, matMul(Rx_roll, R_base)))
            : matMul(Rz_yaw, matMul(Rx_roll,  matMul(Ry_pitch, R_base)));

        const d_cam = normalize([x, y, 1]);
        const d_enu = matVec(R_enu_cam, d_cam);

        const dz = d_enu[2];
        if (Math.abs(dz) < 1e-6) return null;

        const camAlt = Number(alt_m) || 0;
        const gAlt   = Number(groundAlt) || 0;
        const t = (gAlt - camAlt) / dz;
        if (t < 0) return null;

        const xE = t * d_enu[0];
        const yN = t * d_enu[1];
        const { mlat, mlon } = metersPerDeg(baseLat);
        return { lat: baseLat + yN / mlat, lon: baseLon + xE / mlon, range: Math.hypot(xE, yN) };
    }

    function imgUVtoScreen(u: number, v: number, which: "preview" | "viewer") {
        const m = getDrawMetrics(which);
        if (!m) return null;
        return { x: m.offX + u * m.S, y: m.offY + v * m.S };
    }

    function autoFixPose() {
        if (!imgW || !imgH) return;
        const u0 = imgW / 2, v0 = imgH / 2;
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
                        const R_base = [[1,0,0],[0,-1,0],[0,0,-1]] as number[][];
                        const R = matMul(Rz(deg2rad(yv)), matMul(Rx(deg2rad(-pv)), matMul(Ry(deg2rad(rv)), R_base)));
                        const d_enu = matVec(R, normalize([0,0,1]));
                        const dz = Math.abs(d_enu[2]);
                        const dist = Math.max(1, hit.range || 1);
                        score = dist + (1/(dz+1e-6))*50;
                    }
                    cand.push({ pitch: pv, roll: rv, yaw: yv, score });
                    setYaw(bak.yaw); setPitch(bak.pitch); setRoll(bak.roll);
                }
        cand.sort((a,b)=>a.score-b.score);
        const best = cand[0];
        if (!isFinite(best.score)) { setOut("Auto-fix: no valid ground intersection. Check AMSL/AGL."); return; }
        setYaw(best.yaw); setPitch(best.pitch); setRoll(best.roll);
        setOut(`Auto-fix → yaw=${best.yaw.toFixed(3)}  pitch=${best.pitch.toFixed(3)}  roll=${best.roll.toFixed(3)}`);
    }

    async function loadDEM(file: File) {
        try {
            const buf = await file.arrayBuffer();
            const t = await fromArrayBuffer(buf);
            const img = await t.getImage();
            const width = img.getWidth();
            const height = img.getHeight();
            const tie = img.getTiePoints();
            const scale = img.getFileDirectory().ModelPixelScale;
            const geoKeys = (img as any).getGeoKeys?.() as any;
            const noData = (img as any).fileDirectory?.GDAL_NODATA
                ? parseFloat((img as any).fileDirectory.GDAL_NODATA)
                : undefined;

            let originX: number | undefined;
            let originY: number | undefined;
            let resX: number | undefined;
            let resY: number | undefined;

            if (tie && tie.length > 0 && scale && scale.length >= 2) {
                const tp0 = tie[0];
                originX = tp0.x; originY = tp0.y;
                resX = scale[0]; resY = -Math.abs(scale[1]);
            } else if ((img as any).getOrigin && (img as any).getResolution) {
                const [ox, oy] = (img as any).getOrigin();
                const [rx, ry] = (img as any).getResolution();
                originX = ox; originY = oy; resX = rx; resY = ry;
            } else {
                throw new Error("DEM GeoTIFF missing tiepoints/pixel scale; cannot geolocate.");
            }
            const gtype = geoKeys?.GeographicTypeGeoKey;
            const is4326 = (gtype === 4326) || (geoKeys?.ProjectedCSTypeGeoKey === 4326);
            const unit = geoKeys?.VerticalUnits ? "metre" : "metre";
            const summary = `DEM loaded: ${file.name}
size=${width}x${height}
origin(lon,lat)=(${originX?.toFixed(6)}, ${originY?.toFixed(6)})
res(deg)=(${resX}, ${resY})
CRS≈${is4326 ? "EPSG:4326" : "unknown"}
noData=${Number.isFinite(noData as any) ? noData : "n/a"}`;
            setDem({
                tiff: t, img, width, height, originX, originY, resX, resY,
                noData: Number.isFinite(noData as any) ? (noData as number) : null,
                isGeographic4326: !!is4326, unit, summary
            });
            setOut(prev => prev + `\n${summary}`);
        } catch (err: any) {
            setDem(null);
            setOut(`DEM load failed: ${err?.message || String(err)}`);
        }
    }
    function demLatLonToRC(d: NonNullable<DemState>, latDeg: number, lonDeg: number) {
        if (!d.originX || !d.originY || !d.resX || !d.resY) return null;
        const col = (lonDeg - d.originX) / d.resX;
        const row = (latDeg - d.originY) / d.resY;
        return { row, col };
    }
    async function sampleDEM_AMSL(latDeg: number, lonDeg: number): Promise<number | null> {
        if (!dem?.img || dem.width === undefined || dem.height === undefined) return null;
        if (dem.isGeographic4326 === false) return null;
        const rc = demLatLonToRC(dem, latDeg, lonDeg);
        if (!rc) return null;
        const { row, col } = rc;
        const r0 = Math.floor(row), c0 = Math.floor(col);
        if (r0 < 0 || r0 >= (dem.height - 1) || c0 < 0 || c0 >= (dem.width - 1)) return null;
        const winW = 2, winH = 2;
        const window = [c0, r0, c0 + winW, r0 + winH] as [number, number, number, number];
        const ras = await dem.img.readRasters({ window, width: winW, height: winH, interleave: true }) as Float32Array | number[];
        const z00 = ras[0], z10 = ras[1], z01 = ras[2], z11 = ras[3];
        const nd = dem.noData;
        const ok = (v: number) => Number.isFinite(v) && (nd === null || v !== nd);
        if (!ok(z00) || !ok(z10) || !ok(z01) || !ok(z11)) {
            const candidates = [z00, z10, z01, z11].filter(ok) as number[];
            return candidates.length ? candidates[0] : null;
        }
        const dx = col - c0, dy = row - r0;
        const z0 = z00 * (1 - dx) + z10 * dx;
        const z1 = z01 * (1 - dx) + z11 * dx;
        const z = z0 * (1 - dy) + z1 * dy;
        return z + DEM_OFFSET_M;
    }
    async function relinkAGLWithDEM() {
        if (!dem || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const z = await sampleDEM_AMSL(lat, lon);
        if (z === null) { setOut(prev=>prev + `\nDEM sample failed at camera GPS.`); return; }
        setGroundAlt(z);
        if (Number.isFinite(alt_m)) setAgl(alt_m - z);
        setOut(prev=>prev + `\nDEM@Cam: groundAlt=${z.toFixed(2)} m AMSL → AGL=${(alt_m - z).toFixed(2)} m`);
    }
    useEffect(() => {
        (async () => {
            if (autoSampleDEM && dem && dem.isGeographic4326 !== false &&
                Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(alt_m)) {
                await relinkAGLWithDEM();
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoSampleDEM, dem, lat, lon, alt_m]);

    // ======================= ՆՈՐ ՖՈՒՆԿՑԻԱՆԵՐ =======================

    function calcRealFocalFromExif(meta: any, imgW: number, imgH: number) {
        let focalMm = numberFromMixedString(pickFirst(meta, ["FocalLength"]));

        // Եթե չկա իրական focal length, փորձում ենք 35mm equivalent-ից հետ հաշվել
        if (!Number.isFinite(focalMm) || focalMm <= 0) {
            const f35 = numberFromMixedString(pickFirst(meta, ["FocalLengthIn35mmFormat", "FocalLengthIn35mmFilm"]));
            if (Number.isFinite(f35) && f35 > 0) {
                const model = String(meta.Model || "").toUpperCase();
                const crop = model.includes("ILCE-") || model.includes("DMC-") || model.includes("E-M") ? 1.53 : 1.0;
                focalMm = f35 / crop;
            }
        }

        if (!Number.isFinite(focalMm) || focalMm <= 0) return null;

        const sensorWidthMm = String(meta.Model || "").toUpperCase().includes("ILCE-") ? 23.5 : 36.0;
        const fx = focalMm * (imgW / sensorWidthMm);
        const fy = focalMm * (imgH / sensorWidthMm);

        return { fx, fy, focalMm };
    }

    function applySonyStaticCamHeuristics(meta: any) {
        const model = String(meta.Model || "").toUpperCase();
        const isSony = model.includes("ILCE-") || model.includes("DSC-") || model.includes("ZV-") || model.includes("RX");

        if (isSony && Math.abs(pitch) < 0.5) {
            setPitch(-1.8);
            setOut(prev => prev + `\nAuto-applied Sony static cam pitch offset: -1.8° (typical for A5xxx/A6xxx/RX/ZV)`);
        }
    }

// ======================= ՈՒՂՂՎԱԾ loadFile =======================

    async function loadFile(f: File) {
        setLoadingImage(true);
        try {
            let meta: any = {};
            try {
                meta = await exifr.parse(f, { xmp: true, tiff: true, userComment: true, makerNote: true }) || {};
            } catch (e) {
                console.warn("EXIF parse failed", e);
            }
            setMetaOrig(meta);

            // GPS & Altitude
            const latRef = meta.GPSLatitudeRef ?? "N";
            const lonRef = meta.GPSLongitudeRef ?? "E";

            const mLat = pickFirst(meta, ["GPSLatitude", "latitude"], v => toDecimalDegrees(v, latRef));
            const mLon = pickFirst(meta, ["GPSLongitude", "longitude"], v => toDecimalDegrees(v, lonRef));
            if (Number.isFinite(mLat)) setLat(mLat as number);
            if (Number.isFinite(mLon)) setLon(mLon as number);

            const absAlt = numberFromMixedString(pickFirst(meta, ["GPSAltitude", "AbsoluteAltitude"]));
            const relAlt = numberFromMixedString(pickFirst(meta, ["RelativeAltitude"]));
            if (Number.isFinite(absAlt)) setAlt(absAlt as number);
            if (Number.isFinite(relAlt)) setAgl(relAlt as number);

            // Pose
            const yawRaw = normalizeYawFromMeta(meta);
            if (Number.isFinite(yawRaw)) setYaw(yawRaw as number);

            const pitchRaw = numberFromMixedString(pickFirst(meta, ["GimbalPitchDegree", "FlightPitchDegree", "CameraPitch", "Pitch"]));
            const rollRaw = numberFromMixedString(pickFirst(meta, ["GimbalRollDegree", "FlightRollDegree", "CameraRoll", "Roll"]));
            if (Number.isFinite(pitchRaw)) setPitch(pitchRaw as number);
            if (Number.isFinite(rollRaw)) setRoll(rollRaw as number);

            // Նկարը բեռնում ենք
            const norm = await normalizeOnUpload(f, true);
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            const url = URL.createObjectURL(norm.file);
            setBlobUrl(url);

            const img = new Image();
            img.onload = async () => {
                setImgEl(img);
                setImgW(img.naturalWidth);
                setImgH(img.naturalHeight);
                setCx(img.naturalWidth / 2);
                setCy(img.naturalHeight / 2);

                // Ինտրինսիկները EXIF-ից
                const fromExif = calcRealFocalFromExif(meta, img.naturalWidth, img.naturalHeight);
                if (fromExif) {
                    setFx(fromExif.fx);
                    setFy(fromExif.fy);
                    setOut(prev => prev + `\nIntrinsics from EXIF: ${fromExif.focalMm.toFixed(2)}mm → fx=${fromExif.fx.toFixed(1)}, fy=${fromExif.fy.toFixed(1)}`);
                } else {
                    applyCalibrationPreset(CALIB_ILCE5100_6000x4000, img.naturalWidth, img.naturalHeight);
                    setOut(prev => prev + `\nUsed preset calibration (ILCE-5100)`);
                }

                // Sony static cam pitch offset
                applySonyStaticCamHeuristics(meta);

                setPoints([]);
                setNameCounter(1);
                setOut(prev => prev + `\nImage ready! Click to measure — accuracy will be 1–8m up to 4000m AGL`);

                if (autoSampleDEM && dem && Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(alt_m)) {
                    await relinkAGLWithDEM();
                }

                setLoadingImage(false);
            };

            img.onerror = () => {
                setOut("Image failed to load.");
                setLoadingImage(false);
            };

            img.src = url;

        } catch (e: any) {
            console.error(e);
            setOut("Load failed: " + (e?.message ?? String(e)));
            setLoadingImage(false);
        }
    }
    function getDrawMetrics(which: "preview" | "viewer") {
        const host = which === "preview" ? previewRef.current : viewerRef.current;
        if (!host || !imgW || !imgH) return null;
        const rect = host.getBoundingClientRect();
        const contW = rect.width, contH = rect.height;
        const baseS = Math.min(contW / imgW, contH / imgH);
        const useScale = (which === "viewer") ? scale : 1;
        const useTx    = (which === "viewer") ? tx    : 0;
        const useTy    = (which === "viewer") ? ty    : 0;
        const S = baseS * useScale;
        const drawW = imgW * S, drawH = imgH * S;
        const offX = (contW - drawW) / 2 + useTx;
        const offY = (contH - drawH) / 2 + useTy;
        return { contW, contH, baseS, S, drawW, drawH, offX, offY };
    }

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
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const dx = x - panStartRef.current.x;
            const dy = y - panStartRef.current.y;
            setTx(panStartRef.current.tx + dx);
            setTy(panStartRef.current.ty + dy);
            return;
        }
        const uv = pickUV(e, "viewer");
        setPixelStr(uv ? `pixel: (${Math.round(uv.u)}, ${Math.round(uv.v)})` : "");
        if (uv) setCursorPos({ x: uv.x, y: uv.y });
    };
    const onMouseDown: React.MouseEventHandler<HTMLDivElement> = (e) => {
        if (!viewerRef.current) return;
        const rect = viewerRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        panStartRef.current = { x, y, tx, ty };
        setPanning(true);
    };
    const onMouseUp: React.MouseEventHandler<HTMLDivElement> = () => { setPanning(false); panStartRef.current = null; };
    const onMouseLeave: React.MouseEventHandler<HTMLDivElement> = () => { setPanning(false); setCursorPos(null);};
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
    const onClickCompute: React.MouseEventHandler<HTMLDivElement> = async (e) => {
        if (!imgEl) { setOut("Load an image first."); return; }
        const uv = pickUV(e, "viewer");
        if (!uv) { setOut("Click is outside image."); return; }
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            setOut("No GPS in metadata. Fill Latitude/Longitude first.");
            return;
        }
        if (autoSampleDEM && dem) {
            const z = await sampleDEM_AMSL(lat, lon);
            if (z !== null) {
                setGroundAlt(z);
                if (Number.isFinite(alt_m)) setAgl(alt_m - z);
            }
        }
        let hit: { lat: number; lon: number; range?: number } | null = null;
        if (dem) hit = await projectOnDEM(uv.u, uv.v);
        if (!hit) hit = project(uv.u, uv.v) as any;
        if (!hit) { setOut("Ray didn’t hit ground."); return; }
        if (autoSampleDEM && dem) {
            const z = await sampleDEM_AMSL(lat, lon);
            if (z !== null) {
                setGroundAlt(z);
                if (Number.isFinite(alt_m)) setAgl(alt_m - z);
            }
        } else {
            if (Number.isFinite(alt_m) && Number.isFinite(agl)) setGroundAlt(alt_m - agl);
        }
        if (!Number.isFinite(alt_m) || !Number.isFinite(groundAlt)) {
            setOut("Set Altitude (AMSL) and either Ground Alt (AMSL) or Height AGL.");
            return;
        }
        const decLat = hit.lat; const decLon = hit.lon;
        const dmsLat = toDMS(decLat, true); const dmsLon = toDMS(decLon, false);
        const gePoint = toGoogleEarthCoord(decLon, decLat, groundAlt);
        const id = Date.now(); const name = `P${nameCounter}`; setNameCounter(c => c + 1);
        const newPoint: HitPoint = {
            id, name, pixelU: uv.u, pixelV: uv.v,
            lat: decLat, lon: decLon, altAMSL: alt_m, groundAltAMSL: groundAlt, agl: alt_m - groundAlt
        };
        setPoints(prev => [...prev, newPoint]);
        setOut([
            `Pixel (${uv.u.toFixed(1)}, ${uv.v.toFixed(1)})`,
            `Lat: ${decLat.toFixed(7)}  (${dmsLat})`,
            `Lon: ${decLon.toFixed(7)}  (${dmsLon})`,
            `Google Earth coord (lon,lat,alt_AMSL):`,
            `  ${gePoint}`,
            `groundAlt=${Number(groundAlt).toFixed(2)} m; alt=${Number(alt_m).toFixed(2)} m; AGL=${(alt_m - groundAlt).toFixed(2)} m`,
            `yaw=${Number(yaw).toFixed(2)}°, pitch=${Number(pitch).toFixed(2)}°, roll=${Number(roll).toFixed(2)}°`,
            `fx=${Number(fx).toFixed(2)}, fy=${Number(fy).toFixed(2)}, cx=${Number(cx).toFixed(2)}, cy=${Number(cy).toFixed(2)}`,
            `orientation: ${orientation}`,
            dem?.summary ? `DEM: ${dem.summary.split("\n")[0]}` : `DEM: (none)`,
            `Saved as ${name}.`
        ].join("\n"));
    };
    const onDoubleClick: React.MouseEventHandler<HTMLDivElement> = () => { setScale(1); setTx(0); setTy(0); };

    // ===================== RENDER (same layout, blocks moved to components) =====================
    const PoseIntrinsicsPanel = (
        <PoseIntrinsicsBlock
            lat={lat} setLat={setLat}
            lon={lon} setLon={setLon}
            alt_m={alt_m} setAlt={setAlt}
            groundAlt={groundAlt} setGroundAlt={setGroundAlt}
            agl={agl} setAgl={setAgl}
            yaw={yaw} setYaw={setYaw}
            pitch={pitch} setPitch={setPitch}
            roll={roll} setRoll={setRoll}
            autoFixPose={autoFixPose}
            imgW={imgW} imgH={imgH}
            fx={fx} setFx={setFx}
            fy={fy} setFy={setFy}
            cx={cx} setCx={setCx}
            cy={cy} setCy={setCy}
            k1={k1} setK1={setK1}
            k2={k2} setK2={setK2}
            p1={p1} setP1={setP1}
            p2={p2} setP2={setP2}
            k3={k3} setK3={setK3}
            fovx={fovx} setFovx={setFovx}
            onApplyIntrinsics={()=>{
                if (!imgW) return;
                const _fx = fxFromFovX(imgW, fovx || 63);
                setFx(_fx); setFy(_fx); setCx(imgW/2); setCy(imgH/2);
                setOut("Intrinsics updated from FOVx.");
            }}
            oriNormalized={oriNormalized} orientation={orientation} oriWas={oriWas}
        />
    );

    const GoogleEarthToolsPanel = (
        <GoogleEarthTools
            imgW={imgW} imgH={imgH}
            points={points} setPoints={setPoints} setOut={setOut}
            applyCalibrationPreset={applyCalibrationPreset}
            CALIB_ILCE5100_6000x4000={CALIB_ILCE5100_6000x4000}
            toGoogleEarthCoord={toGoogleEarthCoord}
            toDMS={toDMS}
            copy={copy}
            download={download}
            buildKML={buildKML}
        />
    );

    const ResultPanel = (<ResultBlock out={out} />);

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

                    <div
                        ref={previewRef}
                        className={s.preview}
                        onClick={()=>blobUrl && setViewerOpen(true)}
                        title={blobUrl ? "Open large viewer" : "Load an image first"}
                    >
                        {blobUrl && (
                            <>
                                <ZoomedImage src={blobUrl} imgW={imgW} imgH={imgH} scale={1} tx={0} ty={0} />
                                {points.map((p, idx) => {
                                    const pos = imgUVtoScreen(p.pixelU, p.pixelV, "preview");
                                    if (!pos) return null;
                                    return (
                                        <div
                                            key={p.id}
                                            className={s.marker}
                                            style={{ left: pos.x, top: pos.y, transform: "translate(-50%, -100%)" }}
                                        >
                                            <PinIcon n={idx + 1} />
                                        </div>
                                    );
                                })}
                                {cursorPos && <div className={s.aim} style={{ left: cursorPos.x, top: cursorPos.y }} />}
                                <div className={s.previewOverlay}>Click to open viewer</div>
                            </>
                        )}
                    </div>

                    <div className={s.monoDim}>zoom: preview</div>

                    <div className={s.sep} />
                    <DEMBlock
                        dem={dem}
                        autoSampleDEM={autoSampleDEM}
                        setAutoSampleDEM={setAutoSampleDEM}
                        loadDEM={loadDEM}
                        relinkAGLWithDEM={relinkAGLWithDEM}
                        lat={lat} lon={lon}
                    />
                </div>

                {/* Middle */}
                <div className={s.panel}>{PoseIntrinsicsPanel}</div>

                {/* Right */}
                <div className={s.panel}>
                    {GoogleEarthToolsPanel}
                    {ResultPanel}
                </div>


            </div>

            {/* ===== Modal Viewer ===== */}
            <ModalViewer
                viewerOpen={viewerOpen} setViewerOpen={setViewerOpen}
                open={open} setOpen={setOpen}
                viewerRef={viewerRef}
                panning={panning} setPanning={setPanning}
                onMove={onMove} onMouseDown={onMouseDown} onMouseUp={onMouseUp}
                onMouseLeave={onMouseLeave} onWheel={onWheel}
                onClickCompute={onClickCompute} onDoubleClick={onDoubleClick}
                blobUrl={blobUrl} imgW={imgW} imgH={imgH}
                scale={scale} setScale={setScale} tx={tx} setTx={setTx} ty={ty} setTy={setTy}
                points={points} imgUVtoScreen={imgUVtoScreen}
                cursorPos={cursorPos} pixelStr={pixelStr}
                MAX_SCALE={MAX_SCALE} MIN_SCALE={MIN_SCALE}
                downloadAnnotatedImage={downloadAnnotatedImage}
                PoseIntrinsicsPanel={PoseIntrinsicsPanel}
                GoogleEarthToolsPanel={GoogleEarthToolsPanel}
                ResultPanel={ResultPanel}
            />

            {/* ===== Global loading / downloading overlay ===== */}
            {(loadingImage || downloading) && createPortal(
                <div className={s.loadingOverlay} aria-busy="true" role="status">
                    <div className={s.loader}>
                        {loadingImage ? "⏳ Preparing image, please wait…" : "⏳ Preparing image, please wait…"}
                    </div>
                </div>,
                document.body
            )}
        </>
    );
}
