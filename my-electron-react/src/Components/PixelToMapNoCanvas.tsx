// PixelToMapNoCanvas_sony_static_cam.tsx
// Static NADIR camera (always looks DOWN). No gimbal needed.
// + Offline Ground Altitude from local DEM GeoTIFF (no internet).
//
// Requires: npm i geotiff
//
// Parses EXIF (Sony/DJI), projects pixel->lat/lon on ground plane,
// and (if DEM is loaded) samples ground altitude at camera GPS to link AMSL↔AGL.
// ENU: x=East, y=North, z=Up. Camera: x_cam→East, y_cam→South, z_cam→Down.

import React, { useRef, useState, useEffect } from "react";
import * as exifr from "exifr";
import { fromUrl, fromArrayBuffer, GeoTIFF, GeoTIFFImage } from "geotiff";
import s from "./PixelToMapNoCanvas.module.scss";

// --- sensor widths for FOV estimation ---
const SENSOR_WIDTH_MM_BY_MODEL: Record<string, number> = { "ILCE-5100": 23.5, "ILCE-6000": 23.5, "ILCE-6100": 23.5, "ILCE-6300": 23.5, "ILCE-6400": 23.5, };
const DEM_OFFSET_M = 34
type HitPoint = {
    id: number;
    name: string;
    pixelU: number;
    pixelV: number;
    lat: number;
    lon: number;
    altAMSL: number;
    groundAltAMSL: number;
    agl: number;
};

// ---- DEM state ----
type DemState = {
    tiff?: GeoTIFF;
    img?: GeoTIFFImage;
    width?: number;
    height?: number;
    originX?: number;     // top-left lon
    originY?: number;     // top-left lat
    resX?: number;        // pixel width in deg (EPSG:4326) or map units
    resY?: number;        // pixel height (usually negative for north-up)
    noData?: number | null;
    isGeographic4326?: boolean; // best-effort check
    unit?: string;        // "metre" typical
    summary?: string;     // printable brief
} | null;

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

    // ------------ pose ------------
    const [lat, setLat] = useState<number>(0);
    const [lon, setLon] = useState<number>(0);
    const [alt_m, setAlt] = useState<number>(0);          // camera AMSL
    const [yaw, setYaw] = useState<number>(0);
    const [pitch, setPitch] = useState<number>(0);
    const [roll, setRoll] = useState<number>(0);
    const [groundAlt, setGroundAlt] = useState<number>(0);
    const [agl, setAgl] = useState<number>(0);
    const [cursorPos, setCursorPos] = useState<{x:number; y:number} | null>(null);

    // ------------ UI / misc ------------
    const [pixelStr, setPixelStr] = useState("");
    const [out, setOut] = useState("Պատկերը բեռնիր, հետո սեղմիր վրա…");
    const [metaDump, setMetaDump] = useState<Record<string, any> | null>(null);
    const [orientation, setOrientation] = useState<string>("Horizontal (normal)");
    const [viewerOpen, setViewerOpen] = useState(false);

    // points for KML
    const [points, setPoints] = useState<HitPoint[]>([]);
    const [nameCounter, setNameCounter] = useState(1);

    // ---- DEM handling ----
    const [dem, setDem] = useState<DemState>(null);
    const [autoSampleDEM, setAutoSampleDEM] = useState<boolean>(true);

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
        const mlat = 111132.92 - 559.82*Math.cos(2*L) + 1.175*Math.cos(4*L) - 0.0023*Math.cos(6*L);
        const mlon = 111412.84*Math.cos(L) - 93.5*Math.cos(3*L) + 0.118*Math.cos(5*L);
        return { mlat, mlon };
    }
    function fxFromFovX(W: number, fovx_deg: number) {
        const half = Math.tan(deg2rad((fovx_deg || 1e-6)/2));
        return W/2 / Math.max(half, 1e-9);
    }

    // ------------ format helpers ------------
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
    function escapeXml(s: string) {
        return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
    }
    function buildKML(points: HitPoint[]) {
        const header = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>AW Points</name>
    <Style id="awPoint">
      <IconStyle><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/red-circle.png</href></Icon></IconStyle>
    </Style>
`;
        const footer = `  </Document>\n</kml>`;
        const body = points.map(p => {
            const coord = toGoogleEarthCoord(p.lon, p.lat, p.groundAltAMSL);
            return `    <Placemark>
      <name>${escapeXml(p.name)}</name>
      <description><![CDATA[
        Pixel: (${Math.round(p.pixelU)}, ${Math.round(p.pixelV)})<br/>
        Lat: ${p.lat.toFixed(7)}<br/>
        Lon: ${p.lon.toFixed(7)}<br/>
        Ground AMSL: ${p.groundAltAMSL.toFixed(2)} m<br/>
        AGL: ${p.agl.toFixed(2)} m
      ]]></description>
      <styleUrl>#awPoint</styleUrl>
      <Point><altitudeMode>absolute</altitudeMode><coordinates>${coord}</coordinates></Point>
    </Placemark>`;
        }).join("\n");
        return header + body + "\n" + footer;
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

    // ------------ Orientation map ------------
    function uvDisplayToSensor(u: number, v: number) {
        switch ((orientation || "").toLowerCase()) {
            case "rotate 90 cw":
            case "right-top":
            case "6":  return { u: v, v: imgW - u };
            case "rotate 270 cw":
            case "left-bottom":
            case "8":  return { u: imgH - v, v: u };
            case "rotate 180":
            case "bottom-right":
            case "3":  return { u: imgW - u, v: imgH - v };
            default:   return { u, v };
        }
    }

    // ------------ Projection to ground (static nadir) ------------
    function project(uDisp: number, vDisp: number) {
        const { u, v } = uvDisplayToSensor(uDisp, vDisp);

        const _fx = Number.isFinite(fx) && fx !== 0 ? fx : fxFromFovX(imgW, fovx);
        const _fy = Number.isFinite(fy) && fy !== 0 ? fy : _fx;
        const _cx = Number.isFinite(cx) ? cx : imgW / 2;
        const _cy = Number.isFinite(cy) ? cy : imgH / 2;

        const baseLat = Number.isFinite(lat) ? lat : 0;
        const baseLon = Number.isFinite(lon) ? lon : 0;

        // camera->ENU at nadir
        const R_base = [[1,0,0],[0,-1,0],[0,0,-1]] as number[][];
        const R_yaw   = Rz( deg2rad(yaw || 0) );
        const R_pitch = Rx( deg2rad(pitch || 0) );
        const R_roll  = Ry( deg2rad(-roll || 0) );
        const R_enu_cam = matMul(R_yaw, matMul(R_pitch, matMul(R_roll, R_base)));

        const x = (u - _cx) / _fx;
        const y = (v - _cy) / _fy;
        const d_cam = normalize([x, y, 1]);
        const d_enu = matVec(R_enu_cam, d_cam);

        const dz = d_enu[2]; // Up component
        if (Math.abs(dz) < 1e-12) return null;

        const camAlt = Number(alt_m) || 0;
        const gAlt   = Number(groundAlt) || 0;
        const t = (gAlt - camAlt) / dz;
        if (t < 0) return null;

        const xE = t * d_enu[0];
        const yN = t * d_enu[1];

        const { mlat, mlon } = metersPerDeg(baseLat);
        return { lat: baseLat + yN / mlat, lon: baseLon + xE / mlon, range: Math.hypot(xE, yN) };
    }

    // ------------ Auto-fix pose (sign opps) ------------
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
        if (!isFinite(best.score)) { setOut("Auto-fix: no valid ground intersection. Check AMSL/AGL."); return; }
        setYaw(best.yaw); setPitch(best.pitch); setRoll(best.roll);
        setOut(`Auto-fix → yaw=${best.yaw.toFixed(3)}  pitch=${best.pitch.toFixed(3)}  roll=${best.roll.toFixed(3)}`);
    }

    // ------------ DEM loader & sampler (offline) ------------
    async function loadDEM(file: File) {
        try {
            const buf = await file.arrayBuffer();
            const t = await fromArrayBuffer(buf);
            const img = await t.getImage(); // first image
            const width = img.getWidth();
            const height = img.getHeight();

            // Spatial info
            // Prefer ModelTiepoint/ModelPixelScale (classic GeoTIFF)
            const tie = img.getTiePoints();
            const scale = img.getFileDirectory().ModelPixelScale; // [resX, resY, resZ]
            const geoKeys = img.getGeoKeys?.() as any;
            const noData = (img as any).fileDirectory?.GDAL_NODATA
                ? parseFloat((img as any).fileDirectory.GDAL_NODATA)
                : undefined;

            let originX: number | undefined;
            let originY: number | undefined;
            let resX: number | undefined;
            let resY: number | undefined;

            if (tie && tie.length > 0 && scale && scale.length >= 2) {
                // Common case: one tiepoint at (0,0)->(lon0,lat0)
                const tp0 = tie[0];
                originX = tp0.x;
                originY = tp0.y;
                resX = scale[0];
                resY = -Math.abs(scale[1]); // enforce north-up negative step
            } else if ((img as any).getOrigin && (img as any).getResolution) {
                // Some geotiff.js builds have helpers
                const [ox, oy] = (img as any).getOrigin();
                const [rx, ry] = (img as any).getResolution();
                originX = ox; originY = oy; resX = rx; resY = ry;
            } else {
                throw new Error("DEM GeoTIFF missing tiepoints/pixel scale; cannot geolocate.");
            }

            // CRS check (best-effort)
            const gtype = geoKeys?.GeographicTypeGeoKey;
            const is4326 = (gtype === 4326) || (geoKeys?.ProjectedCSTypeGeoKey === 4326);
            const unit = geoKeys?.VerticalUnits ? "metre" : "metre";

            const summary = `DEM loaded: ${file.name}
size=${width}x${height}
origin(lon,lat)=(${originX?.toFixed(6)}, ${originY?.toFixed(6)})
res(deg)=(${resX}, ${resY})
CRS≈${is4326 ? "EPSG:4326" : "unknown"}
noData=${noData ?? "n/a"}`;

            setDem({
                tiff: t, img, width, height,
                originX, originY, resX, resY,
                noData: Number.isFinite(noData) ? (noData as number) : null,
                isGeographic4326: !!is4326,
                unit, summary
            });

            setOut(prev => prev + `\n${summary}`);
        } catch (err: any) {
            setDem(null);
            setOut(`DEM load failed: ${err?.message || String(err)}`);
        }
    }

    // map (lat,lon) -> DEM row/col (floating)
    function demLatLonToRC(d: NonNullable<DemState>, latDeg: number, lonDeg: number) {
        if (!d.originX || !d.originY || !d.resX || !d.resY) return null;
        // GeoTIFF north-up: lon = originX + col*resX ; lat = originY + row*resY
        const col = (lonDeg - d.originX) / d.resX;
        const row = (latDeg - d.originY) / d.resY; // resY is negative -> rows increase southward
        return { row, col };
    }

    // bilinear sample with nodata handling
    async function sampleDEM_AMSL(latDeg: number, lonDeg: number): Promise<number | null> {
        if (!dem?.img || dem.width === undefined || dem.height === undefined) return null;
        const rc = demLatLonToRC(dem, latDeg, lonDeg);
        if (!rc) return null;

        const { row, col } = rc;
        const r0 = Math.floor(row), c0 = Math.floor(col);
        if (r0 < 0 || r0 >= (dem.height - 1) || c0 < 0 || c0 >= (dem.width - 1)) return null;

        // Read a 2x2 window efficiently
        const winW = 2, winH = 2;
        const window = [c0, r0, c0 + winW, r0 + winH] as [number, number, number, number];
        const ras = await dem.img.readRasters({ window, width: winW, height: winH, interleave: true }) as Float32Array | number[];
        const z00 = ras[0], z10 = ras[1], z01 = ras[2], z11 = ras[3];

        // nodata check
        const nd = dem.noData;
        function ok(v: number) { return Number.isFinite(v) && (nd === null || v !== nd); }
        if (!ok(z00) || !ok(z10) || !ok(z01) || !ok(z11)) {
            // fall back: nearest neighbor on valid
            const candidates = [z00, z10, z01, z11].filter(ok) as number[];
            if (!candidates.length) return null;
            return candidates[0];
        }

        const dx = col - c0;
        const dy = row - r0;
        // bilinear
        const z0 = z00*(1-dx) + z10*dx;
        const z1 = z01*(1-dx) + z11*dx;
        const z = z0*(1-dy) + z1*dy;
        // return z;
        return z + DEM_OFFSET_M; // 🟢 ուղղում ենք DEM ground altitude՝ +30 մ

    }

    // Convenience: link AMSL↔AGL using DEM at camera lat/lon
    async function relinkAGLWithDEM() {
        if (!dem || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const z = await sampleDEM_AMSL(lat, lon);
        if (z === null) { setOut(prev=>prev + `\nDEM sample failed at camera GPS.`); return; }
        setGroundAlt(z);
        if (Number.isFinite(alt_m)) setAgl(alt_m - z);
        setOut(prev=>prev + `\nDEM@Cam: groundAlt=${z.toFixed(2)} m AMSL → AGL=${(alt_m - z).toFixed(2)} m`);
    }

    // If user toggles auto-sample and we have DEM + valid lat/lon/alt, relink.
    useEffect(() => {
        (async () => {
            if (autoSampleDEM && dem && Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(alt_m)) {
                await relinkAGLWithDEM();
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoSampleDEM, dem, lat, lon, alt_m]);

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
            setPoints([]); setNameCounter(1);

            try {
                const meta: any = await exifr.parse(f, {
                    xmp: true, icc: false, tiff: true, jfif: true, ihdr: true,
                    userComment: true, makerNote: true, multiSegment: true,
                });
                setMetaDump(meta ?? {});
                const ori = meta.CameraOrientation ?? meta.Orientation ?? meta["IFD0:Orientation"] ?? meta["orientation"];
                setOrientation(String(ori ?? "Horizontal (normal)"));

                // UserComment robust decode
                let userComment = "";
                const ucRaw = meta.UserComment ?? meta.userComment ?? meta["User Comment"] ?? meta.makerNote;
                if (ucRaw) {
                    if (typeof ucRaw === "string") userComment = ucRaw;
                    else if (ucRaw instanceof Uint8Array || Array.isArray(ucRaw)) {
                        try {
                            const bytes = ucRaw instanceof Uint8Array ? ucRaw : new Uint8Array(ucRaw as any);
                            let start = 0;
                            if (bytes.length >= 8 &&
                                bytes[0]===0x41 && bytes[1]===0x53 && bytes[2]===0x43 && bytes[3]===0x49 && bytes[4]===0x49) start = 8; // "ASCII\0\0\0"
                            userComment = new TextDecoder("ascii").decode(bytes.slice(start)).trim();
                            if (!/Lat|Lon|Pitch|Roll|Yaw/i.test(userComment)) {
                                userComment = new TextDecoder("utf-8").decode(bytes.slice(start)).trim();
                            }
                        } catch { userComment = ""; }
                    }
                }
                const kc = parseUserComment(userComment);

                // GPS
                const latRef = meta.GPSLatitudeRef ?? meta.gpslatituderef ?? "N";
                const lonRef = meta.GPSLongitudeRef ?? meta.gpslongituderef ?? "E";
                const mLat = kc.lat ?? pickFirst<number>(meta, ["GPSLatitude", "latitude"], (v)=>toDecimalDegrees(v, latRef));
                const mLon = kc.lon ?? pickFirst<number>(meta, ["GPSLongitude", "longitude"], (v)=>toDecimalDegrees(v, lonRef));
                if (Number.isFinite(mLat)) setLat(mLat as number);
                if (Number.isFinite(mLon)) setLon(mLon as number);

                // Altitudes
                const absAltPref =
                    numberFromMixedString(pickFirst(meta, ["AbsoluteAltitude"])) ??
                    numberFromMixedString(pickFirst(meta, ["GPSAltitude", "altitude"]));
                const relAlt = numberFromMixedString(pickFirst(meta, ["RelativeAltitude"]));
                if (Number.isFinite(absAltPref)) setAlt(absAltPref as number);
                if (Number.isFinite(relAlt)) {
                    setAgl(relAlt as number);
                    if (Number.isFinite(absAltPref)) setGroundAlt((absAltPref as number) - (relAlt as number));
                } else {
                    // If DEM is present we’ll relink later; else minimal fallback
                    const initAGL = (agl && agl>0) ? agl : 2;
                    if (Number.isFinite(absAltPref)) {
                        setAgl(initAGL);
                        setGroundAlt((absAltPref as number) - initAGL);
                    }
                }

                // Attitude
                const yawPref = numberFromMixedString(pickFirst(meta, ["GimbalYawDegree","FlightYawDegree","CameraYaw","Yaw"])) ?? kc.yaw;
                const pitchPref = numberFromMixedString(pickFirst(meta, ["GimbalPitchDegree","FlightPitchDegree","CameraPitch","Pitch"])) ?? kc.pitch;
                const rollPref  = numberFromMixedString(pickFirst(meta, ["GimbalRollDegree","FlightRollDegree","CameraRoll","Roll"])) ?? kc.roll;
                if (Number.isFinite(yawPref))   setYaw(yawPref as number);
                if (Number.isFinite(pitchPref)) setPitch(pitchPref as number);
                if (Number.isFinite(rollPref))  setRoll(rollPref as number);

                // Intrinsics
                let fovxDeg = numberFromMixedString(pickFirst(meta, ["FOV","HFOV","HorizontalFOV"])) ?? undefined;

                if (!Number.isFinite(fovxDeg)) {
                    const f35 = numberFromMixedString(pickFirst(meta, ["FocalLengthIn35mmFormat","ExifIFD:FocalLengthIn35mmFilm"]));
                    if (Number.isFinite(f35) && (f35 as number) > 0) {
                        const fx35 = (Number(f35) / 36) * img.naturalWidth;
                        setFx(fx35); setFy(fx35);
                    }
                }
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
                if ((!fx || !fy) || (fx===0 && fy===0)) {
                    const _fx = fxFromFovX(img.naturalWidth, fovx || 63);
                    setFx(_fx); setFy(_fx); setCx(img.naturalWidth/2); setCy(img.naturalHeight/2);
                } else {
                    if (!Number.isFinite(cx) || !cx) setCx(img.naturalWidth / 2);
                    if (!Number.isFinite(cy) || !cy) setCy(img.naturalHeight / 2);
                }

                setOut("Մետատվյալները կարդացված են. սեղմիր պատկերին՝ գետնի կետը հաշվարկելու համար։");

                // If DEM is loaded and we have lat/lon/alt, auto link
                if (autoSampleDEM && dem && Number.isFinite(mLat) && Number.isFinite(mLon) && Number.isFinite(absAltPref)) {
                    await relinkAGLWithDEM();
                }
            } catch (e) {
                const _fx = fxFromFovX(img.naturalWidth, fovx || 63);
                setFx(_fx); setFy(_fx); setCx(img.naturalWidth/2); setCy(img.naturalHeight/2);
                setOut("Մետատվյալ չհաջողվեց կարդալ. օգտագործում ենք FOVx fallback. Լրացրու pose/alt/groundAlt/AGL և սեղմիր պատկերին։");
            }
        };
        img.src = url;
    }

    // ------------ draw metrics ------------
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

    // ------------ interactions ------------
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
        if (uv) setCursorPos({ x: uv.x, y: uv.y }); // 👈 պահում ենք խաչի դիրքը
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
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) { setOut("No GPS in metadata. Fill Latitude/Longitude first."); return; }

        // If DEM present and opted-in, (re)sample ground at camera GPS
        if (autoSampleDEM && dem) {
            const z = await sampleDEM_AMSL(lat, lon);
            if (z !== null) {
                setGroundAlt(z);
                if (Number.isFinite(alt_m)) setAgl(alt_m - z);
            }
        } else {
            // If no DEM, keep manual linkage
            if (Number.isFinite(alt_m) && Number.isFinite(agl)) setGroundAlt(alt_m - agl);
        }

        if (!Number.isFinite(alt_m) || !Number.isFinite(groundAlt)) {
            setOut("Set Altitude (AMSL) and either Ground Alt (AMSL) or Height AGL.");
            return;
        }

        const hit = project(uv.u, uv.v) as any;
        if (!hit) { setOut("Ray didn’t hit the ground plane (up/behind). Check AMSL/AGL or pose."); return; }

        const decLat = hit.lat;
        const decLon = hit.lon;
        const dmsLat = toDMS(decLat, true);
        const dmsLon = toDMS(decLon, false);
        const gePoint = toGoogleEarthCoord(decLon, decLat, groundAlt);

        const id = Date.now();
        const name = `P${nameCounter}`;
        setNameCounter(c => c + 1);
        const newPoint: HitPoint = {
            id, name, pixelU: uv.u, pixelV: uv.v,
            lat: decLat, lon: decLon,
            altAMSL: alt_m, groundAltAMSL: groundAlt, agl: alt_m - groundAlt
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


    const DEMBlock = (
        <>
            <h3 className={s.h3}>Offline Ground Elevation (DEM)</h3>
            <div className={s.monoDim}>
                DEM GeoTIFF (օր. SRTM/ASTER, EPSG:4326),։
            </div>
            <div className={s.rowBtns}>
                <input
                    type="file"
                    accept=".tif,.tiff,image/tiff,application/octet-stream"
                    onChange={(e)=>{
                        const f = e.target.files?.[0];
                        if (f) loadDEM(f);
                    }}
                />
                <label className={s.chk}>
                    <input type="checkbox" checked={autoSampleDEM} onChange={(e)=>setAutoSampleDEM(e.target.checked)} />
                    Auto-sample DEM @ camera GPS (link AMSL↔AGL)
                </label>
                <button className={s.btn} onClick={relinkAGLWithDEM} disabled={!dem || !Number.isFinite(lat) || !Number.isFinite(lon)}>
                    Sample now @ (lat,lon)
                </button>
            </div>
            <pre className={s.preSmall}>{dem?.summary || "— DEM not loaded —"}</pre>
            {!dem?.isGeographic4326 && dem && (
                <div className={s.warn}>⚠ DEM CRS անծանոթ է (կամ ոչ EPSG:4326). Արդյունքը կարող է լինել սխալ, ցանկալի է 4326 GeoTIFF։</div>
            )}
        </>
    );

    const GoogleEarthTools = (
        <>
            <h3 className={s.h3}>Google Earth / KML</h3>
            <div className={s.monoDim}>(lon,lat,alt=ground AMSL)։</div>
            <div className={s.rowBtns}>
                <button className={s.btn} onClick={()=>{
                    if (!points.length) { setOut("No points to export."); return; }
                    const kml = buildKML(points);
                    download("aw_points.kml", kml);
                    setOut(prev=>prev + `\nExported ${points.length} point(s) to aw_points.kml`);
                }}>Download KML</button>
                <button className={s.btn} onClick={()=>{
                    if (!points.length) { setOut("No points to copy."); return; }
                    const last = points[points.length - 1];
                    copy(toGoogleEarthCoord(last.lon, last.lat, last.groundAltAMSL));
                }}>Copy last (lon,lat,alt)</button>
                <button className={s.btn} onClick={()=>{
                    if (!points.length) { setOut("No points to copy."); return; }
                    const last = points[points.length - 1];
                    copy(`${last.lat.toFixed(7)}, ${last.lon.toFixed(7)}`);
                }}>Copy last (lat, lon)</button>
                <button className={s.btn} onClick={()=>{
                    if (!points.length) { setOut("No points to copy."); return; }
                    const last = points[points.length - 1];
                    copy(`${toDMS(last.lat,true)}  ${toDMS(last.lon,false)}`);
                }}>Copy last (DMS)</button>
                <button className={s.btnDanger} onClick={()=>{ setPoints([]); setOut("Cleared points."); }}>Clear points</button>
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
                    {points.map((p,idx)=>(
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

                    <div className={s.sep} />
                    {DEMBlock}
                </div>

                {/* Middle */}
                <div className={s.panel}>{PoseIntrinsicsBlock}</div>

                {/* Right */}
                <div className={s.panel}>
                    {GoogleEarthTools}
                    {ResultBlock}
                </div>
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
                                    {cursorPos && <div className={s.aim} style={{ left: cursorPos.x, top: cursorPos.y }} />}
                                </div>
                                <div className={s.monoBright}>{pixelStr} · zoom: {scale.toFixed(2)}</div>
                            </div>

                            <div className={s.infoPane}>{PoseIntrinsicsBlock}</div>
                            <div className={s.resultPane}>
                                {GoogleEarthTools}
                                {ResultBlock}
                            </div>
                        </div>
                    </div>
                </div>
            )}

        </>
    );
}

// ---- inputs ----
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
