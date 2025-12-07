// ============================================================================
// FILE: src/Components/ImageToMapOffline.tsx
// ============================================================================
import React, { useEffect, useRef, useState } from "react";
import { fromArrayBuffer } from "geotiff";
import * as exifr from "exifr";

import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import SceneView from "@arcgis/core/views/SceneView";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Graphic from "@arcgis/core/Graphic";
import MediaLayer from "@arcgis/core/layers/MediaLayer";
import ImageElement from "@arcgis/core/layers/support/ImageElement";
import Extent from "@arcgis/core/geometry/Extent";
import SpatialReference from "@arcgis/core/geometry/SpatialReference";
import ExtentAndRotationGeoreference from "@arcgis/core/layers/support/ExtentAndRotationGeoreference";

import "./ImageToMap.scss";

// ----------------- types/consts -----------------
type DEMInfo = { width:number;height:number;originX:number;originY:number;resX:number;resY:number; };
const WGS84 = SpatialReference.WGS84;
const EPS = 1e-8;

// ----------------- helpers -----------------
function dmsToDec(v?: string | number | null){ if(typeof v==="number") return v; if(!v) return null;
    const m=String(v).match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D*([NSEW])?/i);
    if(!m) return null; const D=+m[1],M=+m[2],S=+m[3]; let out=D+M/60+S/3600; const h=(m[4]||"").toUpperCase();
    if(h==="S"||h==="W") out*=-1; return out;
}
function metersPerDegree(lat:number){ const mLat=111_320; const mLon=111_320*Math.cos((lat*Math.PI)/180); return {mPerDegLat:mLat,mPerDegLon:mLon}; }
function extentAround(lat:number, lon:number, w_m:number, h_m:number){
    const {mPerDegLat,mPerDegLon}=metersPerDegree(lat);
    const xmin = lon-(w_m/2)/mPerDegLon, xmax = lon+(w_m/2)/mPerDegLon;
    const ymin = lat-(h_m/2)/mPerDegLat, ymax = lat+(h_m/2)/mPerDegLat;
    return new Extent({ xmin, ymin, xmax: xmax===xmin ? xmax+EPS : xmax, ymax: ymax===ymin ? ymax+EPS : ymax, spatialReference: WGS84 });
}
function buildExtent(info:DEMInfo, adj?:{scaleX:number;scaleY:number;dx_m:number;dy_m:number}){
    let lonL=info.originX, latT=info.originY;
    let lonR=info.originX+info.width*info.resX, latB=info.originY+info.height*info.resY;
    let xmin=Math.min(lonL,lonR), xmax=Math.max(lonL,lonR), ymin=Math.min(latB,latT), ymax=Math.max(latB,latT);
    const cx=(xmin+xmax)/2, cy=(ymin+ymax)/2; let w=(xmax-xmin), h=(ymax-ymin);
    if(adj){ w*=adj.scaleX/100; h*=adj.scaleY/100; const {mPerDegLon,mPerDegLat}=metersPerDegree(cy);
        xmin=cx-w/2+adj.dx_m/mPerDegLon; xmax=cx+w/2+adj.dx_m/mPerDegLon;
        ymin=cy-h/2+adj.dy_m/mPerDegLat; ymax=cy+h/2+adj.dy_m/mPerDegLat; }
    if (xmax===xmin) xmax+=EPS; if (ymax===ymin) ymax+=EPS;
    return new Extent({ xmin,ymin,xmax,ymax, spatialReference: WGS84 });
}
async function loadHtmlImage(src:string){
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    img.src = src;
    if ("decode" in img) {
        await (img as any).decode().catch(()=>new Promise<void>((ok,err)=>{ img.onload=()=>ok(); img.onerror=(e)=>err(e); }));
    } else {
        await new Promise<void>((ok,err)=>{ img.onload=()=>ok(); img.onerror=(e)=>err(e); });
    }
    return img;
}

// ----------------- component -----------------
export default function ImageToMapOffline() {
    const hostRef = useRef<HTMLDivElement | null>(null);

    const viewRef = useRef<MapView | SceneView | null>(null);
    const mapRef  = useRef<Map | null>(null);

    const markerLayerRef  = useRef<GraphicsLayer | null>(null);
    const outlineLayerRef = useRef<GraphicsLayer | null>(null);

    const mediaLayerRef   = useRef<MediaLayer | null>(null);
    const imageElementRef = useRef<ImageElement | null>(null);

    // image/meta
    const [photoURL, setPhotoURL] = useState<string | null>(null);
    const [photoEl,  setPhotoEl]  = useState<HTMLImageElement | null>(null);
    const [imgW, setImgW] = useState<number>(0); // px
    const [imgH, setImgH] = useState<number>(0); // px

    const [lat, setLat] = useState<number | null>(null);
    const [lon, setLon] = useState<number | null>(null);
    const [headingDeg, setHeading] = useState(0);
    const [dem, setDem] = useState<DEMInfo | null>(null);

    // UI
    const [status, setStatus] = useState("Ready.");
    const [use2D, setUse2D] = useState<boolean>(true);
    const [terrainOff, setTerrainOff] = useState<boolean>(false);
    const [onlyOnImage, setOnlyOnImage] = useState<boolean>(false);
    const [opacity, setOpacity] = useState<number>(95);
    const [lift, setLift] = useState<number>(0.8);

    // no-DEM footprint
    const [wMeters, setWM] = useState<number>(50);
    const [hMeters, setHM] = useState<number>(40);
    const [lockAspect, setLockAspect] = useState<boolean>(true);

    // fine-tune
    const [fine, setFine] = useState<boolean>(false);
    const [sx, setSx] = useState<number>(100);
    const [sy, setSy] = useState<number>(100);
    const [rotDelta, setRot] = useState<number>(0);
    const [dx, setDx] = useState<number>(0);
    const [dy, setDy] = useState<number>(0);

    const log = (m:string) => setStatus(s => s + "\n" + m);

    // ---------- init view ----------
    useEffect(() => {
        if (!hostRef.current) return;

        // Decide 3D availability; auto-fallback
        let shouldUse2D = use2D;
        try {
            const ok = (SceneView as any).supportsBrowserEnvironment?.() ?? true;
            if (!ok) shouldUse2D = true;
        } catch { shouldUse2D = true; }

        if (viewRef.current) { viewRef.current.destroy(); viewRef.current = null; }
        mediaLayerRef.current = null; imageElementRef.current = null;

        const map = new Map({
            basemap: "satellite",
            ground: terrainOff ? (null as any) : "world-elevation",
        });
        map.basemap.load().catch(() => { map.basemap = "topo-vector" as any; log("Basemap 'satellite' aborted → 'topo-vector'."); });

        const common = { map, center: [44.51, 40.18], zoom: 13 } as const;
        const view = shouldUse2D
            ? new MapView({ container: hostRef.current!, ...common })
            : new SceneView({
                container: hostRef.current!, ...common,
                qualityProfile: "high",
                environment: { lighting: { directShadowsEnabled: true, ambientOcclusionEnabled: true } },
                camera: { position: { longitude: 44.51, latitude: 40.18, z: 1200 }, tilt: 45, heading: 0 },
            });

        const marker = new GraphicsLayer({ elevationInfo: { mode: "on-the-ground" } as any });
        const outline = new GraphicsLayer({ elevationInfo: { mode: "on-the-ground" } as any });
        map.addMany([marker, outline]);

        view.on("click", async (ev: any) => {
            if (onlyOnImage && mediaLayerRef.current) {
                const hit = await view.hitTest(ev, { include: [mediaLayerRef.current] });
                if (!hit?.results?.length) return;
            }
            const mp = ev.mapPoint ?? view.toMap({ x: ev.x, y: ev.y } as any);
            if (!mp) return;
            void navigator.clipboard?.writeText(`${(+mp.latitude.toFixed(8))}, ${(+mp.longitude.toFixed(8))}`).catch(()=>{});
            marker.removeAll();
            marker.add(new Graphic({
                geometry: { type: "point", longitude: mp.longitude, latitude: mp.latitude, spatialReference: WGS84 } as any,
                symbol: { type: "simple-marker", size: 6, color: [0,0,0,0], outline: { color: "cyan", width: 1 } } as any,
            }));
        });

        viewRef.current = view; mapRef.current = map;
        markerLayerRef.current = marker; outlineLayerRef.current = outline;

        // if we forced fallback, reflect it in UI
        if (use2D !== shouldUse2D) setUse2D(shouldUse2D);

        return () => { view.destroy(); };
    }, [use2D, terrainOff, onlyOnImage]);

    // live opacity
    useEffect(() => { if (mediaLayerRef.current) mediaLayerRef.current.opacity = Math.max(0, Math.min(1, opacity/100)); }, [opacity]);

    // aspect-lock coupling
    useEffect(() => {
        if (!lockAspect || !imgW || !imgH) return;
        const r = imgH / imgW;
        setHM(Math.max(1, Math.min(1000, Math.round(wMeters * r))));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wMeters]);

    // ---------- loaders ----------
    async function onLoadImage(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0]; if (!file) return;
        const url = URL.createObjectURL(file);
        try {
            const img = await loadHtmlImage(url);
            setPhotoURL(url); setPhotoEl(img); setImgW(img.naturalWidth); setImgH(img.naturalHeight);
            // set initial footprint using aspect
            const initW = 50; const r = img.naturalHeight / img.naturalWidth;
            setWM(initW); setHM(Math.max(1, Math.round(initW * r)));
            log(`Image decoded: ${img.naturalWidth}x${img.naturalHeight}`);
        } catch (err:any) {
            log(`Image decode failed: ${err?.message ?? err}`); return;
        }

        try {
            const gps = await exifr.gps(file).catch(()=> null as any);
            let la: number | null = gps?.latitude ?? null;
            let lo: number | null = gps?.longitude ?? null;
            const meta: any = await exifr.parse(file, { xmp: true, userComment: true }).catch(()=> ({}));
            if (la == null && typeof meta?.GPSLatitude === "number") la = meta.GPSLatitude;
            if (lo == null && typeof meta?.GPSLongitude === "number") lo = meta.GPSLongitude;
            if (la == null && typeof meta?.GPSLatitude === "string") la = dmsToDec(meta.GPSLatitude);
            if (lo == null && typeof meta?.GPSLongitude === "string") lo = dmsToDec(meta.GPSLongitude);
            const hd: number | undefined = meta?.GPSImgDirection ?? meta?.DroneYawDegree ?? meta?.GimbalYawDegree ?? meta?.FlightYawDegree;
            setLat(la); setLon(lo); setHeading(Number.isFinite(hd) ? Number(hd) : 0);
            log(`EXIF: lat=${la ?? "?"}, lon=${lo ?? "?"}, heading=${Number.isFinite(hd)?hd:0}°`);
        } catch { log("EXIF parse failed."); }
    }

    async function onLoadDEM(e: React.ChangeEvent<HTMLInputElement>) {
        const f = e.target.files?.[0]; if (!f) return;
        try {
            const tiff = await fromArrayBuffer(await f.arrayBuffer());
            const img = await tiff.getImage();
            const width = img.getWidth(), height = img.getHeight();
            const tie = img.getTiePoints(); const scale = (img.getFileDirectory() as any).ModelPixelScale;
            if (!tie || !scale) throw new Error("DEM missing tiepoints or pixel scale");
            const originX = tie[0].x, originY = tie[0].y;
            const resX = Number(scale[0]), resY = -Math.abs(Number(scale[1]));
            setDem({ width, height, originX, originY, resX, resY });
            log(`DEM: ${f.name} (${width}x${height})`);
        } catch (err:any) { setDem(null); log(`DEM load FAILED: ${err?.message ?? err}`); }
    }

    // ---------- media layer lifecycle ----------
    async function ensureMedia(imageEl: HTMLImageElement) {
        if (mediaLayerRef.current && imageElementRef.current) {
            if ((imageElementRef.current as any).image !== imageEl) {
                (imageElementRef.current as any).image = imageEl;
            }
            return;
        }
        const georef = new ExtentAndRotationGeoreference({
            extent: new Extent({ xmin:0, ymin:0, xmax:EPS, ymax:EPS, spatialReference: WGS84 }),
            rotation: 0
        });
        const imgElem = new ImageElement({ image: imageEl, georeference: georef });
        const media = new MediaLayer({
            source: [imgElem],
            spatialReference: WGS84,
            elevationInfo: use2D ? ({ mode:"on-the-ground" } as any) : ({ mode:"relative-to-ground", offset: Math.max(0, lift) } as any),
            opacity: Math.max(0, Math.min(1, opacity / 100)),
            blendMode: "normal",
        });

        media.on("layerview-create", ()=>log("Media layerview: created."));
        media.on("layerview-destroy", ()=>log("Media layerview: destroyed."));
        media.on("layerview-create-error", (e:any)=>log(`Media layer error: ${e?.error?.message ?? e}`));

        mapRef.current?.add(media);
        mediaLayerRef.current = media;
        imageElementRef.current = imgElem;

        try {
            await viewRef.current?.whenLayerView(media);
            log("Media layerview: ready.");
        } catch (e:any) {
            log(`whenLayerView failed: ${e?.message ?? e}`);
        }
    }

    function updateGeoref(ext: Extent, rotation: number) {
        if (!imageElementRef.current) return;
        imageElementRef.current.georeference = new ExtentAndRotationGeoreference({ extent: ext, rotation: rotation || 0 });
        if (!use2D && mediaLayerRef.current) (mediaLayerRef.current.elevationInfo as any) = { mode:"relative-to-ground", offset: Math.max(0, lift) };
        const ol = outlineLayerRef.current; if (!ol) return;
        ol.removeAll();
        const r = [[ [ext.xmin,ext.ymin],[ext.xmin,ext.ymax],[ext.xmax,ext.ymax],[ext.xmax,ext.ymin],[ext.xmin,ext.ymin] ]];
        ol.add(new Graphic({ geometry: { type:"polygon", rings:r, spatialReference:WGS84 } as any,
            symbol: { type:"simple-fill", style:"none", outline:{ color:"yellow", width:2 } } as any }));
    }

    // ---------- place/update ----------
    async function onPlaceOrUpdate() {
        const view = viewRef.current; if (!view) return;
        if (!photoEl) { log("No image loaded."); return; }
        await ensureMedia(photoEl);

        let ext: Extent | null = null;
        const rot = headingDeg + (fine ? rotDelta : 0);
        if (dem) {
            ext = buildExtent(dem, fine ? { scaleX:sx, scaleY:sy, dx_m:dx, dy_m:dy } : undefined);
        } else if (lat != null && lon != null) {
            ext = extentAround(lat, lon, wMeters, hMeters);
        } else {
            log("Cannot place image: no DEM and no EXIF GPS.");
            return;
        }

        updateGeoref(ext, rot);
        await view.goTo(ext.expand(1.15)).catch(()=>{});
        log("Image georeferenced.");
    }

    // ---------- UI ----------
    const canPlace = (!!photoEl && (!!dem || (lat!=null && lon!=null))) || (lat!=null && lon!=null);

    return (
        <div className="mp-layout" style={{ height: "100vh" }}>
            <div className="mp-left">
                <div className="card">
                    <h2>📸 Upload Image</h2>
                    <label className="upload">
                        <input type="file" accept="image/*" onChange={onLoadImage}/>
                        <div className="upload-ui"><div className="title">Choose a photo</div><div className="hint">EXIF with GPS/heading helps</div></div>
                    </label>
                    <div className="preview">{photoURL ? <img src={photoURL} alt="preview"/> : <span>No image</span>}</div>
                </div>

                <div className="card">
                    <h2>🌍 Upload DEM (.tif)</h2>
                    <label className="upload">
                        <input type="file" accept=".tif,.tiff" onChange={onLoadDEM}/>
                        <div className="upload-ui"><div className="title">Choose GeoTIFF</div><div className="hint">Tiepoint + PixelScale required</div></div>
                    </label>
                </div>

                <div className="card">
                    <h2>Controls</h2>

                    <label style={{display:"flex",gap:8,alignItems:"center"}}>
                        <input type="checkbox" checked={use2D} onChange={(e)=>setUse2D(e.target.checked)}/>
                        <span>Use 2D MapView (auto fallback if 3D unsupported)</span>
                    </label>
                    {!use2D && (
                        <label style={{display:"flex",gap:8,alignItems:"center"}}>
                            <input type="checkbox" checked={terrainOff} onChange={(e)=>setTerrainOff(e.target.checked)}/>
                            <span>Disable terrain (3D)</span>
                        </label>
                    )}

                    <label style={{display:"flex",gap:8,alignItems:"center"}}>
                        <input type="checkbox" checked={onlyOnImage} onChange={(e)=>setOnlyOnImage(e.target.checked)}/>
                        <span>Report coords only when clicking on the image</span>
                    </label>

                    <label>Overlay opacity: {opacity}%
                        <input type="range" min={10} max={100} value={opacity} onChange={(e)=>setOpacity(+e.target.value)}/>
                    </label>

                    {(!dem && lat!=null && lon!=null) && (
                        <div style={{display:"grid",gap:8,marginTop:6}}>
                            <div style={{fontWeight:600}}>Image footprint (no DEM)</div>
                            <label>Width: {wMeters} m
                                <input type="range" min={1} max={1000} value={wMeters} onChange={(e)=>setWM(+e.target.value)}/>
                            </label>
                            <label>Height: {hMeters} m
                                <input type="range" min={1} max={1000} value={hMeters}
                                       onChange={(e)=>{ const v=+e.target.value; setHM(v); if(lockAspect && imgW && imgH){ setWM(Math.max(1, Math.min(1000, Math.round(v * (imgW/imgH))))); }}}/>
                            </label>
                            <label style={{display:"flex",gap:8,alignItems:"center"}}>
                                <input type="checkbox" checked={lockAspect} onChange={(e)=>setLockAspect(e.target.checked)}/>
                                <span>Lock aspect ({imgW}×{imgH})</span>
                            </label>
                            <button onClick={()=>{ if(!imgW||!imgH) return; const init=50; setWM(init); setHM(Math.max(1, Math.round(init * (imgH/imgW)))); }}>Reset footprint</button>
                            {!use2D && (
                                <label>Lift from ground: {lift.toFixed(1)} m
                                    <input type="range" min={0} max={5} step={0.1} value={lift} onChange={(e)=>setLift(+e.target.value)}/>
                                </label>
                            )}
                            <label>Rotate Δ: {rotDelta}°
                                <input type="range" min={-180} max={180} value={rotDelta} onChange={(e)=>setRot(+e.target.value)}/>
                            </label>
                        </div>
                    )}

                    {dem && (
                        <div style={{display:"grid",gap:8,marginTop:6}}>
                            <div style={{fontWeight:600}}>Fine-tune (DEM)</div>
                            <label>Scale X: {sx}% <input type="range" min={70} max={130} value={sx} onChange={(e)=>setSx(+e.target.value)}/></label>
                            <label>Scale Y: {sy}% <input type="range" min={70} max={130} value={sy} onChange={(e)=>setSy(+e.target.value)}/></label>
                            <label>Rotate Δ: {rotDelta}° <input type="range" min={-180} max={180} value={rotDelta} onChange={(e)=>setRot(+e.target.value)}/></label>
                            <label>Shift X: {dx} m <input type="range" min={-200} max={200} value={dx} onChange={(e)=>setDx(+e.target.value)}/></label>
                            <label>Shift Y: {dy} m <input type="range" min={-200} max={200} value={dy} onChange={(e)=>setDy(+e.target.value)}/></label>
                        </div>
                    )}

                    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:8}}>
                        <button className="primary" disabled={!canPlace} onClick={onPlaceOrUpdate}>📍 Place/Update Image</button>
                    </div>
                </div>

                <div className="card">
                    <h2>Status</h2>
                    <pre className="status">{status}</pre>
                </div>
            </div>

            <div className="mp-right">
                <div ref={hostRef} className="mp-map" style={{width:"100%",height:"100%"}}/>
            </div>
        </div>
    );
}
