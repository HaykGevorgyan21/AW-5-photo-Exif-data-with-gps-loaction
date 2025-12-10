// ============================================================================
// FILE: src/Components/ImageToMapOffline.tsx
// Horizontal image by default (ignore EXIF orientation unless toggled).
// DEM-safe loader. TRUE PHYSICAL SCALE using EXIF + AGL (ray → ground).
// Maps exact 4 image corners to ground via ControlPointsGeoreference.
// Falls back to red extent when EXIF/camera data is missing.
// ============================================================================

import React, { useEffect, useRef, useState } from "react";
import { fromArrayBuffer } from "geotiff";
import * as exifr from "exifr";

import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Graphic from "@arcgis/core/Graphic";
import MediaLayer from "@arcgis/core/layers/MediaLayer";
import ImageElement from "@arcgis/core/layers/support/ImageElement";
import Extent from "@arcgis/core/geometry/Extent";
import SpatialReference from "@arcgis/core/geometry/SpatialReference";
import ControlPointsGeoreference from "@arcgis/core/layers/support/ControlPointsGeoreference";
import TileLayer from "@arcgis/core/layers/TileLayer";
import Basemap from "@arcgis/core/Basemap";

import "./ImageToMap.scss";

const WGS84 = SpatialReference.WGS84;
const EPS = 1e-8;

// ---------------- types ----------------
type DEMInfo = {
    width: number; height: number;
    originX: number; originY: number;
    resX: number; resY: number;
    noData?: number | null;
    _img: any;
};

type ExifKinematics = {
    lat: number | null; lon: number | null;
    altitudeMSL: number | null;
    yawDeg: number; pitchDeg: number; rollDeg: number;
    focalMM: number | null;
    sensorMM: { w: number; h: number } | null;
};

// ---------------- math utils ----------------
const toRad = (d:number)=>d*Math.PI/180;
function metersPerDegree(lat: number) {
    const mLat = 111_320;
    const mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
    return { mPerDegLat: mLat, mPerDegLon: mLon };
}
function enuToLatLon(lat0: number, lon0: number, eastM: number, northM: number) {
    const { mPerDegLat, mPerDegLon } = metersPerDegree(lat0);
    return { lat: lat0 + northM / mPerDegLat, lon: lon0 + eastM / mPerDegLon };
}
function Rx(a:number){ const c=Math.cos(a), s=Math.sin(a); return (v:{x:number;y:number;z:number})=>({x:v.x, y:c*v.y - s*v.z, z:s*v.y + c*v.z}); }
function Rz(a:number){ const c=Math.cos(a), s=Math.sin(a); return (v:{x:number;y:number;z:number})=>({x:c*v.x - s*v.y, y:s*v.x + c*v.y, z:v.z}); }
function intersectGround(altM:number, d:{x:number;y:number;z:number}){ if (d.z>=-1e-9) return null; const t=altM/(-d.z); return { eastM:d.x*t, northM:d.y*t }; }
function cornerDirsCam(imgW:number,imgH:number,fMM:number,sW:number,sH:number){
    const sx=sW/imgW, sy=sH/imgH, f=fMM;
    return [{u:0,v:0},{u:imgW,v:0},{u:0,v:imgH},{u:imgW,v:imgH}].map(p=>{
        const x=(p.u-imgW/2)*sx, y=-(p.v-imgH/2)*sy, z=f; const L=Math.hypot(x,y,z);
        return {x:x/L,y:y/L,z:z/L};
    });
}

// ---------------- helpers ----------------
function dmsToDec(v?: string|number|null){
    if (typeof v==="number") return v; if (!v) return null;
    const m = String(v).match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D*([NSEW])?/i);
    if (!m) return null; const D=+m[1], M=+m[2], S=+m[3]; let out = D + M/60 + S/3600;
    const h=(m[4]||"").toUpperCase(); if (h==="S"||h==="W") out*=-1; return out;
}
function throttle<T extends any[]>(fn:(...a:T)=>void, ms:number){
    let t=0, last=0; let latest: null | T = null;
    const fire=(args:T)=>{ last=Date.now(); t=0; fn(...args); };
    return (...args:T)=>{ latest=args; const now=Date.now(); const rem = ms - (now-last);
        if (rem<=0){ fire(latest); } else if (!t){ t=window.setTimeout(()=>fire(latest!), rem); } };
}
function loadHtmlImage(src:string){
    return new Promise<HTMLImageElement>((resolve,reject)=>{
        const img=new Image(); img.crossOrigin="anonymous"; img.referrerPolicy="no-referrer"; img.decoding="async";
        img.onload=()=>resolve(img); img.onerror=(e)=>reject(e); img.src=src;
    });
}

// ---------------- DEM ----------------
function latLonToRowCol(dem: DEMInfo, lat:number, lon:number){
    const col = (lon - dem.originX) / dem.resX;
    const row = (lat - dem.originY) / dem.resY;
    return { row: Math.floor(row), col: Math.floor(col) };
}
async function sampleDEMAsync(d: DEMInfo, lat:number, lon:number){
    if (!d?._img) return null;
    const {row,col} = latLonToRowCol(d,lat,lon);
    if (row<0||col<0||row>=d.height||col>=d.width) return null;
    const r = await d._img.readRasters({ window: [col,row,col+1,row+1], samples:[0], interleave:true });
    const v = (r as any)[0]; if (v==null) return null;
    const n = d.noData; if (n!=null && Math.abs(Number(v)-Number(n))<1e-9) return null;
    return Number(v);
}

// ---------------- EXIF (robust camera) ----------------
function plausibleMM(v:number){ return Number.isFinite(v) && v>0.1 && v<100; }
function aspectWH(wPx:number,hPx:number){ return wPx>0&&hPx>0 ? wPx/hPx : 1; }
function pxPerMMFromResolution(res:number, unit:number){
    if (!Number.isFinite(res) || res<=0) return null;
    if (unit===2) return res/25.4;
    if (unit===3) return res/10;
    if (unit===4) return res/1;
    if (unit===5) return res/0.001;
    return null;
}
async function parseExifKinematics(file: File, imgW:number, imgH:number): Promise<ExifKinematics>{
    const gps = await (exifr as any).gps(file).catch(()=>null);
    const meta:any = await (exifr as any).parse(file,{xmp:true,userComment:true}).catch(()=>({}));

    let lat:any = gps?.latitude ?? meta?.GPSLatitude ?? null;
    let lon:any = gps?.longitude ?? meta?.GPSLongitude ?? null;
    if (typeof lat==="string") lat=dmsToDec(lat);
    if (typeof lon==="string") lon=dmsToDec(lon);

    const altitudeMSL =
        (Number.isFinite(+meta?.AbsoluteAltitude)?+meta.AbsoluteAltitude:null) ??
        (Number.isFinite(+gps?.altitude)?+gps.altitude:null) ?? null;

    const yawDeg   = Number.isFinite(+meta?.GimbalYawDegree)?+meta.GimbalYawDegree
        : Number.isFinite(+meta?.DroneYawDegree)?+meta.DroneYawDegree
            : Number.isFinite(+meta?.FlightYawDegree)?+meta.FlightYawDegree
                : Number.isFinite(+meta?.GPSImgDirection)?+meta.GPSImgDirection : 0;
    const pitchDeg = Number.isFinite(+meta?.GimbalPitchDegree)?+meta.GimbalPitchDegree
        : Number.isFinite(+meta?.CameraPitch)?+meta.CameraPitch
            : Number.isFinite(+meta?.AircraftPitch)?+meta.AircraftPitch
                : Number.isFinite(+meta?.Pitch)?+meta.Pitch : 0;
    const rollDeg  = Number.isFinite(+meta?.GimbalRollDegree)?+meta.GimbalRollDegree
        : Number.isFinite(+meta?.CameraRoll)?+meta.CameraRoll
            : Number.isFinite(+meta?.AircraftRoll)?+meta.AircraftRoll
                : Number.isFinite(+meta?.Roll)?+meta.Roll : 0;

    // focal
    let focalMM: number | null = null;
    if (typeof meta?.FocalLength === "number" && meta.FocalLength>0) focalMM = meta.FocalLength;
    else if ((meta?.FocalLength as any)?.valueOf) {
        const f = Number((meta.FocalLength as any).valueOf());
        if (Number.isFinite(f) && f>0) focalMM = f;
    }

    // sensor mm (3 paths)
    let sensorWmm = Number(meta?.SensorWidth);
    let sensorHmm = Number(meta?.SensorHeight);
    if (!(plausibleMM(sensorWmm) && plausibleMM(sensorHmm))) { sensorWmm=NaN; sensorHmm=NaN; }

    if (!(plausibleMM(sensorWmm) && plausibleMM(sensorHmm))) {
        const fpX = Number(meta?.FocalPlaneXResolution ?? meta?.FocalPlaneXResoluton);
        const fpY = Number(meta?.FocalPlaneYResolution ?? meta?.FocalPlaneYResoluton);
        const ru  = Number(meta?.ResolutionUnit ?? meta?.FocalPlaneResolutionUnit ?? meta?.FocalPlaneResolutionUnits ?? 2);
        const ppx = pxPerMMFromResolution(fpX, ru);
        const ppy = pxPerMMFromResolution(fpY || fpX, ru);
        if (ppx && ppy) {
            const w = imgW/ppx, h = imgH/ppy;
            if (plausibleMM(w) && plausibleMM(h)) { sensorWmm=w; sensorHmm=h; }
        }
    }
    const focal35 = Number(meta?.FocalLengthIn35mmFilm ?? meta?.FocalLengthIn35mmFormat);
    if (!(plausibleMM(sensorWmm) && plausibleMM(sensorHmm)) && Number.isFinite(focal35) && focal35>0 && focalMM && focalMM>0) {
        const w = 36 * (focalMM / focal35);
        const h = w / aspectWH(imgW,imgH);
        if (plausibleMM(w) && plausibleMM(h)) { sensorWmm=w; sensorHmm=h; }
    }
    if ((!focalMM || !(focalMM>0)) && plausibleMM(sensorWmm) && Number.isFinite(focal35) && focal35>0) {
        focalMM = focal35 * (sensorWmm / 36);
    }

    const sensorMM = (plausibleMM(sensorWmm) && plausibleMM(sensorHmm)) ? { w: sensorWmm, h: sensorHmm } : null;
    return { lat: lat??null, lon: lon??null, altitudeMSL: altitudeMSL??null, yawDeg, pitchDeg, rollDeg, focalMM:focalMM??null, sensorMM };
}

// project four image corners to ground
function computeGroundCorners(
    ex: Required<Pick<ExifKinematics,"lat"|"lon"|"yawDeg"|"pitchDeg"|"rollDeg"|"focalMM"|"sensorMM">> & { altitudeAGL:number; imgPx:{w:number;h:number} }
){
    const yaw   = toRad(ex.yawDeg);
    const pitch = toRad(ex.pitchDeg);
    const roll  = toRad(ex.rollDeg);

    const rays  = cornerDirsCam(ex.imgPx.w, ex.imgPx.h, ex.focalMM, ex.sensorMM.w, ex.sensorMM.h);
    const apply = (v:{x:number;y:number;z:number}) => Rz(yaw)(Rx(-pitch)(Rz(roll)(v)));
    const hits  = rays.map(r => intersectGround(ex.altitudeAGL, apply(r)));
    if (hits.some(h=>!h)) return null;

    return hits.map(h => enuToLatLon(ex.lat!, ex.lon!, h!.eastM, h!.northM)) as Array<{lat:number;lon:number}>;
}

// ============================================================================

export default function ImageToMapOffline(){
    const hostRef = useRef<HTMLDivElement|null>(null);
    const viewRef = useRef<MapView|null>(null);
    const mapRef  = useRef<Map|null>(null);

    const outlineLayerRef = useRef<GraphicsLayer|null>(null);
    const mediaLayerRef   = useRef<MediaLayer|null>(null);
    const imageElementRef = useRef<ImageElement|null>(null);

    const [photoURL,setPhotoURL] = useState<string|null>(null);
    const [photoEl,setPhotoEl]   = useState<HTMLImageElement|null>(null);
    const [imgW,setImgW] = useState(0); const [imgH,setImgH] = useState(0);

    const [exif,setExif] = useState<ExifKinematics|null>(null);

    const [respectExifOrientation,setRespectExifOrientation] = useState(false); // default OFF

    const [dem,setDem] = useState<DEMInfo|null>(null);

    const [status,setStatus] = useState("Ready.");
    const [opacity,setOpacity] = useState(95);
    const [keepInView,setKeepInView] = useState(true);
    const isFittingRef = useRef(false);
    const fitFracRef = useRef(0.95);

    const log = (m:string)=>setStatus(s=>s+"\n"+m);

    async function safeGoTo(target:any){
        const view:any = viewRef.current; if (!view) return;
        try{ await view.when(); await view.goTo(target,{animate:false,duration:0}); }catch{}
    }

    // -- view --
    useEffect(()=>{
        if (!hostRef.current) return;

        if (viewRef.current){ (viewRef.current as any).destroy(); viewRef.current=null; }
        mediaLayerRef.current=null; imageElementRef.current=null;

        const imagery = new TileLayer({ url:"https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer" });
        const labels  = new TileLayer({ url:"https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer" });
        const basemap = new Basemap({ baseLayers:[imagery], referenceLayers:[labels] });

        const map = new Map({ basemap } as any);
        mapRef.current = map;

        const view = new MapView({
            container: hostRef.current!,
            map,
            center:[44.51,40.18], zoom:5,
            constraints: { rotationEnabled: false },
            navigation: { momentumEnabled: false },
            ui: { components: [] },
            highlightOptions: { color:[0,0,0,0], haloOpacity:0, fillOpacity:0 } as any
        });
        viewRef.current = view;

        const outlines = new GraphicsLayer();
        map.add(outlines);
        outlineLayerRef.current = outlines;

        const fitOnChange = throttle(()=>{ if (keepInView) fitOverlayInsideView(); }, 120);
        const w1 = view.watch("extent", fitOnChange);
        const w2 = view.watch("width",  fitOnChange);
        const w3 = view.watch("height", fitOnChange);

        return ()=>{ w1.remove(); w2.remove(); w3.remove(); (view as any).destroy(); };
    },[keepInView]);

    useEffect(()=>{ if (mediaLayerRef.current) mediaLayerRef.current.opacity = Math.max(0,Math.min(1,opacity/100)); },[opacity]);

    // -- media --
    async function ensureMedia(imageEl:HTMLImageElement){
        if (mediaLayerRef.current && imageElementRef.current){
            if ((imageElementRef.current as any).image !== imageEl) (imageElementRef.current as any).image = imageEl;
            return;
        }
        const imgElem=new ImageElement({
            image:imageEl,
            georeference: new ControlPointsGeoreference({ controlPoints:[], width:imgW||1, height:imgH||1 })
        });
        const media = new MediaLayer({ source:[imgElem], spatialReference:WGS84, elevationInfo:({mode:"on-the-ground"} as any), opacity:Math.max(0,Math.min(1,opacity/100)) });
        mapRef.current?.add(media);
        mediaLayerRef.current=media; imageElementRef.current=imgElem;
        try{ await (viewRef.current as any)?.whenLayerView(media); }catch{}
    }

    // -- red frame (only for visualization/fallback) --
    function drawRedExtent(ext:Extent){
        const rings=[[[ext.xmin,ext.ymin],[ext.xmin,ext.ymax],[ext.xmax,ext.ymax],[ext.xmax,ext.ymin],[ext.xmin,ext.ymin]]];
        outlineLayerRef.current?.removeAll();
        outlineLayerRef.current?.add(new Graphic({
            geometry:{ type:"polygon", rings, spatialReference:WGS84 } as any,
            symbol:{ type:"simple-fill", style:"none", outline:{ color:"red", width:2 } } as any
        }));
    }

    function updateGeorefControlPoints(
        corners:[{lat:number;lon:number},{lat:number;lon:number},{lat:number;lon:number},{lat:number;lon:number}],
        opts?: { skipFit?: boolean }
    ){
        if (!imageElementRef.current) return;
        const [TL,TR,BL,BR]=corners;
        const cps = [
            { sourcePoint:{x:0,   y:0},    mapPoint:{ type:"point", x:TL.lon, y:TL.lat, spatialReference:WGS84 } as any },
            { sourcePoint:{x:imgW,y:0},    mapPoint:{ type:"point", x:TR.lon, y:TR.lat, spatialReference:WGS84 } as any },
            { sourcePoint:{x:0,   y:imgH}, mapPoint:{ type:"point", x:BL.lon, y:BL.lat, spatialReference:WGS84 } as any },
            { sourcePoint:{x:imgW,y:imgH}, mapPoint:{ type:"point", x:BR.lon, y:BR.lat, spatialReference:WGS84 } as any },
        ];
        imageElementRef.current.georeference = new ControlPointsGeoreference({ controlPoints:cps, width:imgW, height:imgH });
        if (keepInView && !opts?.skipFit) fitOverlayInsideView();
    }

    function fitOverlayInsideView(){
        if (isFittingRef.current) return;
        const view=viewRef.current; if (!view?.extent) return;
        const e=view.extent; const latMid=(e.ymin+e.ymax)/2;
        const {mPerDegLat,mPerDegLon}=metersPerDegree(latMid);
        const g = outlineLayerRef.current?.graphics.getItemAt(0) as any;
        if (!g?.geometry) return;
        const bb = g.geometry.extent as Extent;
        const w=(bb.xmax-bb.xmin)*mPerDegLon, h=(bb.ymax-bb.ymin)*mPerDegLat;
        const vw=(e.xmax-e.xmin)*mPerDegLon, vh=(e.ymax-e.ymin)*mPerDegLat;
        const s=Math.min((vw*fitFracRef.current)/w, (vh*fitFracRef.current)/h, 1);
        const cx=(bb.xmin+bb.xmax)/2, cy=(bb.ymin+bb.ymax)/2;
        const vx=(e.xmin+e.xmax)/2, vy=(e.ymin+e.ymax)/2;
        const halfW=((bb.xmax-bb.xmin)*s)/2, halfH=((bb.ymax-bb.ymin)*s)/2;
        const newExt=new Extent({ xmin:vx-halfW, xmax:vx+halfW, ymin:vy-halfH, ymax:vy+halfH, spatialReference:WGS84 });
        drawRedExtent(newExt);
    }

    // -- loaders --
    async function onLoadImage(e:React.ChangeEvent<HTMLInputElement>){
        const file=e.target.files?.[0]; if (!file) return;
        const url=URL.createObjectURL(file);
        let raw:HTMLImageElement;
        try{ raw=await loadHtmlImage(url); }catch(err){ log(`Image decode failed: ${(err as any)?.message??err}`); return; }

        // keep horizontal unless toggle ON
        let finalImg = raw, finalUrl = url, W = raw.naturalWidth, H = raw.naturalHeight;
        if (respectExifOrientation){
            try{
                const ori = await (exifr as any).orientation?.(file);
                if (ori && ori!==1){
                    const swap=(ori>=5&&ori<=8);
                    const canvas=document.createElement("canvas");
                    canvas.width=swap?H:W; canvas.height=swap?W:H;
                    const ctx=canvas.getContext("2d")!;
                    // simple orientation handler
                    switch(ori){
                        case 2: ctx.translate(W,0); ctx.scale(-1,1); break;
                        case 3: ctx.translate(W,H); ctx.rotate(Math.PI); break;
                        case 4: ctx.translate(0,H); ctx.scale(1,-1); break;
                        case 5: ctx.translate(H,0); ctx.rotate(Math.PI/2); ctx.scale(-1,1); break;
                        case 6: ctx.translate(0,W); ctx.rotate(-Math.PI/2); break;
                        case 7: ctx.translate(0,W); ctx.rotate(-Math.PI/2); ctx.scale(-1,1); break;
                        case 8: ctx.translate(0,W); ctx.rotate(-Math.PI/2); break;
                    }
                    ctx.drawImage(raw,0,0,W,H);
                    finalUrl=canvas.toDataURL("image/png");
                    finalImg=await loadHtmlImage(finalUrl);
                    W=finalImg.naturalWidth; H=finalImg.naturalHeight;
                }
            }catch{}
        }

        setPhotoURL(finalUrl); setPhotoEl(finalImg); setImgW(W); setImgH(H);

        // parse full camera exif (for physical scale)
        try{
            const k=await parseExifKinematics(file,W,H);
            setExif(k);
            if (k.lat!=null && k.lon!=null) await safeGoTo({ center:[+k.lon,+k.lat], zoom:17 });
            log(`EXIF cam: f=${k.focalMM??"?"}mm, sensor=${k.sensorMM?`${k.sensorMM.w.toFixed(2)}×${k.sensorMM.h.toFixed(2)}mm`:"?"}, yaw/pitch/roll=${k.yawDeg|0}/${k.pitchDeg|0}/${k.rollDeg|0}`);
        }catch{ log("EXIF parse failed."); }
    }

    async function onLoadDEM(e:React.ChangeEvent<HTMLInputElement>){
        const f=e.target.files?.[0]; if(!f) return;
        try{
            setStatus(s=>s+"\nLoading DEM (metadata only)...");
            const tiff=await fromArrayBuffer(await f.arrayBuffer());
            const img=await tiff.getImage();

            const width=img.getWidth(), height=img.getHeight();
            const fd:any=img.getFileDirectory?.() ?? {};
            let tie = img.getTiePoints?.() as any[]|undefined;
            const scale = (fd.ModelPixelScale ?? fd.ModelPixelScaleTag) as number[]|undefined;

            if((!tie||!tie.length) && Array.isArray(fd.ModelTiepoint)){
                const a=fd.ModelTiepoint; if (a.length>=6) tie=[{x:a[3],y:a[4],z:a[5]}];
            }
            if(!tie || !tie.length || !scale || scale.length<2){ setDem(null); log("DEM warning: missing georef — disabled."); return; }

            const originX=Number(tie[0].x), originY=Number(tie[0].y);
            const resX=Number(scale[0]), resY=-Math.abs(Number(scale[1]));
            if (![originX,originY,resX,resY].every(Number.isFinite)){ setDem(null); log("DEM warning: invalid georef — disabled."); return; }

            const noData =
                (typeof img.getGDALNoData==="function"?img.getGDALNoData():undefined) ??
                (typeof fd.GDAL_NODATA==="string"?Number(fd.GDAL_NODATA):undefined) ??
                (img as any).noDataValue ?? null;

            setDem({ width,height,originX,originY,resX,resY,noData,_img:img });
            log(`DEM ready: ${f.name} (${width}×${height})`);
        }catch(err){ setDem(null); log(`DEM load FAILED (safe): ${(err as any)?.message??err}`); }
    }

    // -- place with PHYSICAL SCALE --
    async function ensureMediaAndPlaceAt(seed:{lat:number;lon:number}){
        if (!photoEl) { log("No image loaded."); return; }
        await ensureMedia(photoEl);
        await safeGoTo({ center:[seed.lon,seed.lat], zoom:17 });

        // if we have full camera & DEM AGL -> physical scale
        let didPhysical=false;
        try{
            if (exif?.lat!=null && exif?.lon!=null &&
                exif?.focalMM && exif.focalMM>0 &&
                exif?.sensorMM &&
                dem && exif.altitudeMSL!=null){
                const demElev = await sampleDEMAsync(dem, exif.lat!, exif.lon!);
                if (demElev!=null){
                    const altitudeAGL = Math.max(0, Number(exif.altitudeMSL) - demElev);
                    const corners = computeGroundCorners({
                        lat: exif.lat!, lon: exif.lon!,
                        yawDeg: exif.yawDeg||0, pitchDeg: exif.pitchDeg||0, rollDeg: exif.rollDeg||0,
                        focalMM: exif.focalMM!, sensorMM: exif.sensorMM!,
                        altitudeAGL, imgPx:{w:imgW,h:imgH}
                    });
                    if (corners){
                        updateGeorefControlPoints(
                            [corners[0],corners[1],corners[2],corners[3]],
                            { skipFit:false }
                        );
                        log(`Placed with PHYSICAL scale (AGL=${altitudeAGL.toFixed(2)} m).`);
                        didPhysical=true;
                    }
                }
            }
        }catch(e:any){ log("Physical scale failed: "+(e?.message??e)); }

        if (didPhysical) return;

        // fallback: red frame align (your old behavior)
        const {mPerDegLat,mPerDegLon}=metersPerDegree(seed.lat);
        const wMeters=60, hMeters=60*(imgH>0? imgH/imgW : 1);
        const xmin=seed.lon-(wMeters/2)/mPerDegLon, xmax=seed.lon+(wMeters/2)/mPerDegLon;
        const ymin=seed.lat-(hMeters/2)/mPerDegLat, ymax=seed.lat+(hMeters/2)/mPerDegLat;
        const ext=new Extent({ xmin, ymin, xmax: xmax===xmin?xmin+EPS:xmax, ymax: ymax===ymin?ymin+EPS:ymax, spatialReference:WGS84 });
        drawRedExtent(ext);
        // snap image into the red box corners:
        updateGeorefControlPoints(
            [
                { lat: ext.ymax, lon: ext.xmin },
                { lat: ext.ymax, lon: ext.xmax },
                { lat: ext.ymin, lon: ext.xmin },
                { lat: ext.ymin, lon: ext.xmax },
            ],
            { skipFit:false }
        );
        log("Placed with fallback extent (missing EXIF/DEM).");
    }

    const canPlace = !!photoEl;

    return (
        <div className="mp-layout" style={{height:"100vh"}}>
            <div className="mp-left">
                <div className="card">
                    <h2>📸 Upload Image</h2>
                    <label className="upload">
                        <input type="file" accept="image/*" onChange={onLoadImage}/>
                        <div className="upload-ui">
                            <div className="title">Choose a photo</div>
                            <div className="hint">Default: keep horizontal (ignore EXIF rotate)</div>
                        </div>
                    </label>
                    <label style={{display:"flex",gap:8,alignItems:"center",marginTop:6}}>
                        <input type="checkbox" checked={respectExifOrientation} onChange={e=>setRespectExifOrientation(e.target.checked)}/>
                        <span>Respect EXIF orientation</span>
                    </label>
                    <div className="preview">{photoURL ? <img src={photoURL} alt="preview"/> : <span>No image</span>}</div>
                </div>

                <div className="card">
                    <h2>🗺️ Upload DEM (.tif)</h2>
                    <label className="upload">
                        <input type="file" accept=".tif,.tiff" onChange={onLoadDEM}/>
                        <div className="upload-ui"><div className="title">Choose GeoTIFF DEM</div><div className="hint">AGL = Alt(MSL) − DEM</div></div>
                    </label>
                </div>

                <div className="card">
                    <h2>🧭 Place</h2>
                    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                        <button disabled={!canPlace} onClick={()=>{
                            const view:any=viewRef.current; if(!view) return;
                            const h=view.on("click", async (ev:any)=>{
                                const mp=ev.mapPoint ?? view.toMap({x:ev.x,y:ev.y});
                                h.remove(); await ensureMediaAndPlaceAt({ lat:+(+mp.latitude).toFixed(8), lon:+(+mp.longitude).toFixed(8) });
                            });
                        }}>🧭 Click map to place</button>
                        <button disabled={!canPlace} onClick={async ()=>{
                            if (exif?.lat!=null && exif?.lon!=null) await ensureMediaAndPlaceAt({ lat:Number(exif.lat), lon:Number(exif.lon) });
                            else log("No GPS in EXIF — use click to place.");
                        }}>📍 Place at EXIF GPS</button>
                    </div>

                    <label style={{display:"flex",gap:8,alignItems:"center",marginTop:6}}>
                        <input type="checkbox" checked={keepInView} onChange={e=>setKeepInView(e.target.checked)}/>
                        <span>Always keep overlay inside the map</span>
                    </label>
                </div>

                <div className="card">
                    <h2>Overlay tools</h2>
                    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                        <button onMouseDown={()=>setOpacity(15)} onMouseUp={()=>setOpacity(95)} onMouseLeave={()=>setOpacity(95)}>🌫️ Fade (hold)</button>

                    </div>
                    <label style={{display:"block",marginTop:8}}>Overlay opacity: {opacity}%
                        <input type="range" min={0} max={100} value={opacity} onChange={(e)=>setOpacity(+e.target.value)}/>
                    </label>
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
