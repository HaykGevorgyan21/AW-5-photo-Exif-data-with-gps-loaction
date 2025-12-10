// ============================================================================
// FILE: src/Components/ImageToMapOffline.tsx   (DROP-IN, PLAIN JS/TSX)
// Behavior change: DO NOT place image on map on "Place at EXIF GPS"/map click.
// We only add MediaLayer + apply georeference AFTER user clicks "Apply 4+ pairs"
// with at least 4 CP pairs. Includes previous preview fix (no top-left bug).
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
import SpatialReference from "@arcgis/core/geometry/SpatialReference";
import ControlPointsGeoreference from "@arcgis/core/layers/support/ControlPointsGeoreference";
import TileLayer from "@arcgis/core/layers/TileLayer";
import Basemap from "@arcgis/core/Basemap";

import "./ImageToMap.scss";

const WGS84 = SpatialReference.WGS84;

// ---------- math ----------
const toRad = (d:number)=> d * Math.PI / 180;
function metersPerDegree(lat:number) {
    const mLat = 111_320;
    const mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
    return { mPerDegLat: mLat, mPerDegLon: mLon };
}
function dmsToDec(v:any){
    if (typeof v==="number") return v; if (!v) return null;
    const m = String(v).match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D*([NSEW])?/i);
    if (!m) return null; const D=+m[1], M=+m[2], S=+m[3]; let out = D + M/60 + S/3600;
    const h=(m[4]||"").toUpperCase(); if (h==="S"||h==="W") out*=-1; return out;
}
function throttle<T extends any[]>(fn:(...a:T)=>void, ms:number){
    let t=0, last=0; let latest:T|null=null;
    const fire=(args:T)=>{ last=Date.now(); t=0; fn(...args); };
    return (...args:T)=>{ latest=args; const now=Date.now(); const rem = ms - (now-last);
        if (rem<=0){ fire(latest!); } else if (!t){ t=window.setTimeout(()=>fire(latest!), rem) as any; } };
}
function loadHtmlImage(src:string){
    return new Promise<HTMLImageElement>((resolve,reject)=>{
        const img=new Image(); img.crossOrigin="anonymous"; img.referrerPolicy="no-referrer"; img.decoding="async";
        img.onload=()=>resolve(img); img.onerror=(e)=>reject(e); img.src=src;
    });
}

// ---------- DEM ----------
function latLonToRowCol(dem:any, lat:number, lon:number){
    const col = (lon - dem.originX) / dem.resX;
    const row = (lat - dem.originY) / dem.resY;
    return { row: Math.floor(row), col: Math.floor(col) };
}
async function sampleDEMAsync(d:any, lat:number, lon:number){
    if (!d?._img) return null;
    const {row,col} = latLonToRowCol(d,lat,lon);
    if (row<0||col<0||row>=d.height||col>=d.width) return null;
    const r = await d._img.readRasters({ window: [col,row,col+1,row+1], samples:[0], interleave:true });
    const v = r[0]; if (v==null) return null;
    const n = d.noData; if (n!=null && Math.abs(Number(v)-Number(n))<1e-9) return null;
    return Number(v);
}

// ---------- EXIF ----------
function plausibleMM(v:any){ return Number.isFinite(v) && v>0.1 && v<100; }
function aspectWH(wPx:number,hPx:number){ return wPx>0&&hPx>0 ? wPx/hPx : 1; }
function pxPerMMFromResolution(res:number, unit:number){
    if (!Number.isFinite(res) || res<=0) return null;
    if (unit===2) return res/25.4;
    if (unit===3) return res/10;
    if (unit===4) return res/1;
    if (unit===5) return res/0.001;
    return null;
}
async function parseExifKinematics(file:File, imgW:number, imgH:number){
    const gps = await exifr.gps(file).catch(()=>null as any);
    const meta:any = await exifr.parse(file,{xmp:true,userComment:true}).catch(()=>({}));

    let lat = gps?.latitude ?? meta?.GPSLatitude ?? null;
    let lon = gps?.longitude ?? meta?.GPSLongitude ?? null;
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

    let focalMM:any = null;
    if (typeof meta?.FocalLength === "number" && meta.FocalLength>0) focalMM = meta.FocalLength;
    else if ((meta?.FocalLength)?.valueOf) {
        const f = Number((meta.FocalLength).valueOf());
        if (Number.isFinite(f) && f>0) focalMM = f;
    }

    let sensorWmm:any = Number(meta?.SensorWidth);
    let sensorHmm:any = Number(meta?.SensorHeight);
    if (!(plausibleMM(sensorWmm) && plausibleMM(sensorHmm))) { sensorWmm=NaN; sensorHmm=NaN; }

    if (!(plausibleMM(sensorWmm) && plausibleMM(sensorHmm))) {
        const fpX = Number(meta?.FocalPlaneXResolution ?? meta?.FocalPlaneXResoluton);
        const fpY = Number(meta?.FocalPlaneYResolution ?? meta?.FocalPlaneYResoluton);
        const ru  = Number(meta?.ResolutionUnit ?? meta?.FocalPlaneResolutionUnit ?? meta?.FocalPlaneResolutionUnits ?? 2);
        const ppx = pxPerMMFromResolution(fpX, ru);
        const ppy = pxPerMMFromResolution(fpY || fpX, ru);
        if (ppx && ppy) {
            const w = imgW/ppx!, h = imgH/ppy!;
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
    return { lat: lat??null, lon: lon??null, altitudeMSL: altitudeMSL??null, yawDeg, pitchDeg, rollDeg, focalMM:focalMM??null, sensorMM, _raw:meta };
}

// ---------- WebMercator helpers ----------
const R = 6378137;
function lonLatToMerc(lon:number, lat:number){ return { x: R*(lon*Math.PI/180), y: R*Math.log(Math.tan(Math.PI/4 + (lat*Math.PI/180)/2)) }; }
function mercToLonLat(x:number, y:number){ return { lon: (x/R)*180/Math.PI, lat: (2*Math.atan(Math.exp(y/R)) - Math.PI/2)*180/Math.PI }; }

// Homography (DLT)
function computeHomographyDLT(imgPts:{u:number,v:number}[], mapPts:{X:number,Y:number}[]){
    const A:number[][] = [];
    for (let i=0;i<4;i++){
        const {u,v}=imgPts[i], {X,Y}=mapPts[i];
        A.push([-u,-v,-1, 0, 0, 0, u*X, v*X, X]);
        A.push([ 0, 0, 0,-u,-v,-1, u*Y, v*Y, Y]);
    }
    const M = Array.from({length:8},(_,r)=>A[r].slice(0,8));
    const b = Array.from({length:8},(_,r)=>-A[r][8]);
    for(let c=0;c<8;c++){
        let p=c; for(let r=c+1;r<8;r++) if (Math.abs(M[r][c])>Math.abs(M[p][c])) p=r;
        if (Math.abs(M[p][c])<1e-12) return null;
        if (p!==c){ [M[p],M[c]]=[M[c],M[p]]; [b[p],b[c]]=[b[c],b[p]]; }
        const pv=M[c][c];
        for(let k=c;k<8;k++) M[c][k]/=pv; b[c]/=pv;
        for(let r=0;r<8;r++) if (r!==c){
            const f=M[r][c]; if (!f) continue;
            for(let k=c;k<8;k++) M[r][k]-=f*M[c][k];
            b[r]-=f*b[c];
        }
    }
    return [...b,1];
}
function applyH(h:number[],u:number,v:number){
    const [h0,h1,h2,h3,h4,h5,h6,h7,h8]=h;
    const X=h0*u+h1*v+h2, Y=h3*u+h4*v+h5, W=h6*u+h7*v+h8;
    if (Math.abs(W)<1e-12) return null;
    return {X:X/W, Y:Y/W};
}

// ---------- component ----------
export default function ImageToMapOffline(){
    const hostRef = useRef<HTMLDivElement|null>(null);
    const viewRef = useRef<MapView|null>(null);
    const mapRef  = useRef<Map|null>(null);

    const outlineLayerRef = useRef<GraphicsLayer|null>(null);
    const handleLayerRef  = useRef<GraphicsLayer|null>(null);
    const cpLayerRef      = useRef<GraphicsLayer|null>(null);
    const mediaLayerRef   = useRef<MediaLayer|null>(null);
    const imageElementRef = useRef<ImageElement|null>(null);

    const [photoURL,setPhotoURL] = useState<string|null>(null);
    const [photoEl,setPhotoEl]   = useState<HTMLImageElement|null>(null);
    const [imgW,setImgW] = useState(0);
    const [imgH,setImgH] = useState(0);
    const [exif,setExif] = useState<any>(null);
    const [respectExifOrientation,setRespectExifOrientation] = useState(false);
    const [dem,setDem] = useState<any>(null);

    const [status,setStatus] = useState("Ready.");
    const [opacity,setOpacity] = useState(95);
    const [keepInView,setKeepInView] = useState(true);

    // frame
    const cornersRef = useRef<any[]|null>(null);
    const dragStateRef = useRef<any|null>(null);
    const isFittingRef = useRef(false);
    const fitFracRef = useRef(0.95);

    // CP mode
    const [cpMode, setCpMode] = useState(false);
    const [cpPairs, setCpPairs] = useState<any[]>([]); // [{img:{x,y}, map:{lat,lon}}]
    const nextNeedsImageRef = useRef(true);
    const cpPreviewRef = useRef<HTMLDivElement|null>(null);
    const [previewSize, setPreviewSize] = useState({ w: 0, h: 0 });

    // NEW: defer placement until Apply — remember where user wanted to center
    const pendingCenterRef = useRef<{lon:number,lat:number}|null>(null);

    const log = (m:string)=> setStatus(s=>s+"\n"+m);
    const tuple4 = (a:any[]) => [a[0],a[1],a[2],a[3]];

    // preview mapping (contain)
    function computePreviewMapping(vw:number, vh:number, iw:number, ih:number){
        if (vw<=0 || vh<=0 || iw<=0 || ih<=0) return null;
        const imgAR = iw/ih, viewAR = vw/vh;
        let ox=0, oy=0, sx=1, sy=1, drawW, drawH;
        if (imgAR > viewAR){ drawW=vw; drawH=vw/imgAR; ox=0; oy=(vh-drawH)/2; sx=iw/drawW; sy=ih/drawH; }
        else { drawH=vh; drawW=vh*imgAR; ox=(vw-drawW)/2; oy=0; sx=iw/drawW; sy=ih/drawH; }
        return { ox, oy, sx, sy };
    }
    function previewToImage(px:number, py:number, map:any){ if (!map) return null; return { u:(px-map.ox)*map.sx, v:(py-map.oy)*map.sy }; }
    function imageToPreview(u:number, v:number, map:any){ if (!map) return null; return { x: map.ox + u/map.sx, y: map.oy + v/map.sy }; }

    // observe preview size
    useEffect(()=>{
        const el = cpPreviewRef.current; if (!el) return;
        const ro = new ResizeObserver(entries=>{
            for (const e of entries){
                const cr = e.contentRect;
                setPreviewSize({ w: Math.max(0, cr.width), h: Math.max(0, cr.height) });
            }
        });
        ro.observe(el);
        const r = el.getBoundingClientRect();
        setPreviewSize({ w: Math.max(0, r.width), h: Math.max(0, r.height) });
        return ()=>ro.disconnect();
    },[]);

    // init view
    useEffect(()=>{
        if (!hostRef.current) return;

        if (viewRef.current){ viewRef.current.destroy(); viewRef.current=null; }
        mediaLayerRef.current=null; imageElementRef.current=null;

        const imagery = new TileLayer({ url:"https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer" });
        const labels  = new TileLayer({ url:"https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer" });
        const basemap = new Basemap({ baseLayers:[imagery], referenceLayers:[labels] });

        const map = new Map({ basemap });
        mapRef.current = map;

        const view = new MapView({
            container: hostRef.current!,
            map,
            center:[44.51,40.18], zoom:5,
            constraints: { rotationEnabled: false },
            navigation: { momentumEnabled: false },
            ui: { components: [] },
            highlightOptions: { color:[0,0,0,0], haloOpacity:0, fillOpacity:0 }
        });
        viewRef.current = view;

        const outlines = new GraphicsLayer();
        const handles  = new GraphicsLayer();
        const cpLayer  = new GraphicsLayer();
        map.add(outlines); map.add(handles); map.add(cpLayer);
        outlineLayerRef.current = outlines;
        handleLayerRef.current  = handles;
        cpLayerRef.current      = cpLayer;

        const fitOnChange = throttle(()=>{
            if (!cpMode && keepInView) fitOverlayInsideView();
        }, 120);
        const w1 = view.watch("extent", fitOnChange);
        const w2 = view.watch("width",  fitOnChange);
        const w3 = view.watch("height", fitOnChange);

        // drag (disabled in CP mode)
        view.on("drag", (ev:any)=>{
            if (!cornersRef.current || cpMode) return;
            if (ev.action === "start") {
                const idx = pickHandle(ev.x, ev.y);
                if (idx !== -1) {
                    dragStateRef.current = { mode:"corner", idx, start:{x:ev.x,y:ev.y}, corners0:tuple4(cornersRef.current) };
                    ev.stopPropagation(); return;
                }
                if (isInsidePolygonScreen(ev.x, ev.y)) {
                    dragStateRef.current = { mode:"move", start:{x:ev.x,y:ev.y}, corners0:tuple4(cornersRef.current) };
                    ev.stopPropagation(); return;
                }
                return;
            }
            if (ev.action === "update" && dragStateRef.current) {
                const st = dragStateRef.current;
                if (st.mode === "corner") {
                    const mp = view.toMap({ x: ev.x, y: ev.y }); if (!mp) return;
                    const moved = tuple4(st.corners0);
                    moved[st.idx] = { lat: mp.latitude, lon: mp.longitude };
                    setGeorefFromCorners(moved, { skipFit:true });
                    ev.stopPropagation();
                } else if (st.mode === "move") {
                    const mp0 = view.toMap({x:st.start.x, y:st.start.y});
                    const mp1 = view.toMap({x:ev.x,      y:ev.y}); if (!mp0 || !mp1) return;
                    const dLon = mp1.longitude - mp0.longitude;
                    const dLat = mp1.latitude  - mp0.latitude;
                    const moved = st.corners0.map((p:any)=>({ lat:p.lat+dLat, lon:p.lon+dLon }));
                    setGeorefFromCorners(moved, { skipFit:true });
                    ev.stopPropagation();
                }
            }
            if (ev.action === "end" && dragStateRef.current) {
                dragStateRef.current = null;
                if (keepInView) fitOverlayInsideView();
                ev.stopPropagation();
            }
        });

        // CP map-click
        view.on("click", (ev:any)=>{
            if (!cpMode) {
                if (cornersRef.current && (pickHandle(ev.x, ev.y) !== -1 || isInsidePolygonScreen(ev.x, ev.y))) ev.stopPropagation();
                return;
            }
            if (nextNeedsImageRef.current) return;
            if (!photoEl) return;
            const mp = ev.mapPoint ?? view.toMap({x:ev.x,y:ev.y}); if (!mp) return;
            setCpPairs(prev=>{
                const copy = prev.slice();
                const last = copy[copy.length-1];
                if (!last || last.map) return copy;
                last.map = { lat:+(+mp.latitude).toFixed(8), lon:+(+mp.longitude).toFixed(8) };
                drawCpLayer(copy);
                return copy;
            });
            nextNeedsImageRef.current = true;
            ev.stopPropagation();
        });

        return ()=>{ w1.remove(); w2.remove(); w3.remove(); view.destroy(); };
    },[keepInView, cpMode]);

    useEffect(()=>{ if (mediaLayerRef.current) mediaLayerRef.current.opacity = Math.max(0,Math.min(1,opacity/100)); },[opacity]);

    // frame drawing + georef (separated)
    function drawFrameOnly(c:any[]){
        const [TL,TR,BL,BR] = c;
        const rings=[[[TL.lon,TL.lat],[TR.lon,TR.lat],[BR.lon,BR.lat],[BL.lon,BL.lat],[TL.lon,TL.lat]]];
        outlineLayerRef.current?.removeAll();
        outlineLayerRef.current?.add(new Graphic({
            geometry:{ type:"polygon", rings, spatialReference:WGS84 },
            symbol:{ type:"simple-fill", style:"none", outline:{ color:"red", width:2 } }
        }));
        handleLayerRef.current?.removeAll();
        [TL,TR,BL,BR].forEach((p:any)=>{
            handleLayerRef.current!.add(new Graphic({
                geometry:{ type:"point", x:p.lon, y:p.lat, spatialReference:WGS84 },
                symbol:{ type:"simple-marker", size:8, style:"circle", color:[255,255,255,1], outline:{ color:"red", width:2 } }
            }));
        });
        cornersRef.current = tuple4(c);
    }
    function setGeorefFromCorners(corners:any[], opts?:{skipFit?:boolean}){
        if (!imageElementRef.current) return;
        const [TL,TR,BL,BR]=corners;
        const cps = [
            { sourcePoint:{x:0,   y:0},    mapPoint:{ type:"point", x:TL.lon, y:TL.lat, spatialReference:WGS84 } },
            { sourcePoint:{x:imgW,y:0},    mapPoint:{ type:"point", x:TR.lon, y:TR.lat, spatialReference:WGS84 } },
            { sourcePoint:{x:0,   y:imgH}, mapPoint:{ type:"point", x:BL.lon, y:BL.lat, spatialReference:WGS84 } },
            { sourcePoint:{x:imgW,y:imgH}, mapPoint:{ type:"point", x:BR.lon, y:BR.lat, spatialReference:WGS84 } },
        ];
        imageElementRef.current.georeference = new ControlPointsGeoreference({ controlPoints:cps, width:imgW, height:imgH });
        drawFrameOnly(corners);
        if (!opts?.skipFit && !cpMode && keepInView) fitOverlayInsideView();
    }
    function fitOverlayInsideView(){
        if (isFittingRef.current) return;
        const view=viewRef.current; if (!view?.extent) return;
        const c = cornersRef.current; if (!c) return;

        const xs=c.map((p:any)=>p.lon), ys=c.map((p:any)=>p.lat);
        const bb = { xmin:Math.min(...xs), xmax:Math.max(...xs), ymin:Math.min(...ys), ymax:Math.max(...ys) };

        const e=view.extent; const latMid=(e.ymin+e.ymax)/2;
        const {mPerDegLat,mPerDegLon}=metersPerDegree(latMid);
        const w=(bb.xmax-bb.xmin)*mPerDegLon, h=(bb.ymax-bbymin)*mPerDegLat; // typo fix below
    }
    // fix tiny typo above:
    function fitOverlayInsideView(){
        if (isFittingRef.current) return;
        const view=viewRef.current; if (!view?.extent) return;
        const c = cornersRef.current; if (!c) return;

        const xs=c.map((p:any)=>p.lon), ys=c.map((p:any)=>p.lat);
        const bb = { xmin:Math.min(...xs), xmax:Math.max(...xs), ymin:Math.min(...ys), ymax:Math.max(...ys) };

        const e=view.extent; const latMid=(e.ymin+e.ymax)/2;
        const {mPerDegLat,mPerDegLon}=metersPerDegree(latMid);
        const w=(bb.xmax-bb.xmin)*mPerDegLon, h=(bb.ymax-bb.ymin)*mPerDegLat;
        const vw=(e.xmax-e.xmin)*mPerDegLon, vh=(e.ymax-e.ymin)*mPerDegLat;
        const s=Math.min((vw*fitFracRef.current)/w, (vh*fitFracRef.current)/h, 1);

        const cx=(bb.xmin+bb.xmax)/2, cy=(bb.ymin+bb.ymax)/2;
        const vx=(e.xmin+e.xmax)/2, vy=(e.ymin+e.ymax)/2;

        // move & scale frame only
        const moved = c.map((p:any)=>({ lat: p.lat + (vy-cy), lon: p.lon + (vx-cx) }));
        const {mPerDegLat:mpdLat,mPerDegLon:mpdLon}=metersPerDegree((vy+cy)/2);
        const ctr={ lon:(vx+cx)/2, lat:(vy+cy)/2 };
        const pts = moved.map((p:any)=>({ x:(p.lon-ctr.lon)*mpdLon, y:(p.lat-ctr.lat)*mpdLat }));
        const scaled = s < 1 - 1e-6 ? pts.map((p:any)=>({ x:p.x*s, y:p.y*s })) : pts;
        const out = scaled.map((p:any)=>({ lat: ctr.lat + p.y/mpdLat, lon: ctr.lon + p.x/mpdLon }));
        drawFrameOnly(out);
    }
    function pickHandle(screenX:number, screenY:number){
        const view = viewRef.current; if (!view || !cornersRef.current) return -1;
        const px = cornersRef.current.map((p:any) => view.toScreen({x:p.lon, y:p.lat, spatialReference:WGS84}));
        const tol = 10;
        for (let i=0;i<4;i++){
            const dx = px[i].x - screenX, dy = px[i].y - screenY;
            if (dx*dx + dy*dy <= tol*tol) return i;
        }
        return -1;
    }
    function isInsidePolygonScreen(x:number, y:number){
        const view=viewRef.current; if (!view || !cornersRef.current) return false;
        const pts=cornersRef.current.map((p:any)=>view.toScreen({x:p.lon,y:p.lat,spatialReference:WGS84}));
        let inside=false;
        for(let i=0,j=pts.length-1;i<pts.length;j=i++){
            const xi=pts[i].x, yi=pts[i].y, xj=pts[j].x, yj=pts[j].y;
            const intersect = ((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi);
            if (intersect) inside=!inside;
        }
        return inside;
    }

    // media (created ONLY on Apply)
    async function ensureMedia(imageEl:HTMLImageElement){
        if (mediaLayerRef.current && imageElementRef.current){
            if (imageElementRef.current.image !== imageEl) imageElementRef.current.image = imageEl;
            return;
        }
        const imgElem=new ImageElement({
            image:imageEl,
            georeference: new ControlPointsGeoreference({ controlPoints:[], width:imgW||1, height:imgH||1 })
        });
        const media = new MediaLayer({ source:[imgElem], spatialReference:WGS84, elevationInfo:{mode:"on-the-ground"}, opacity:Math.max(0,Math.min(1,opacity/100)) });
        mapRef.current?.add(media);
        mediaLayerRef.current=media; imageElementRef.current=imgElem;
        try{ await viewRef.current?.whenLayerView(media); }catch{}
    }

    async function safeGoTo(target:any){
        const view = viewRef.current; if (!view) return;
        try{ await view.when(); await view.goTo(target,{animate:false,duration:0}); }catch{}
    }

    // image loader (NO auto-place)
    async function onLoadImage(e:any){
        const file:File = e.target.files?.[0]; if (!file) return;
        const url=URL.createObjectURL(file);
        let raw:HTMLImageElement;
        try{ raw=await loadHtmlImage(url); }catch(err:any){ log(`Image decode failed: ${err?.message??err}`); return; }

        let finalImg = raw, finalUrl = url, W = raw.naturalWidth, H = raw.naturalHeight;
        if (respectExifOrientation){
            try{
                const ori = await exifr.orientation?.(file as any);
                if (ori && ori!==1){
                    const swap=(ori>=5&&ori<=8);
                    const canvas=document.createElement("canvas");
                    canvas.width=swap?H:W; canvas.height=swap?W:H;
                    const ctx=canvas.getContext("2d")!;
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

        try{
            const k=await parseExifKinematics(file,W,H);
            setExif(k);
            // just remember EXIF as default pending center, do not place
            if (k.lat!=null && k.lon!=null) pendingCenterRef.current = { lon:+k.lon, lat:+k.lat };
            log(`Image ready. Add 4+ control-point pairs, then press "Apply 4+ pairs".`);
        }catch{ log("EXIF parse failed."); }
    }

    // DEM loader (unchanged)
    async function onLoadDEM(e:any){
        const f=e.target.files?.[0]; if(!f) return;
        try{
            setStatus(s=>s+"\nLoading DEM (metadata only)...");
            const tiff=await fromArrayBuffer(await f.arrayBuffer());
            const img=await tiff.getImage();

            const width=img.getWidth(), height=img.getHeight();
            const fd=(img as any).getFileDirectory?.() ?? {};
            let tie = (img as any).getTiePoints?.();
            const scale = (fd.ModelPixelScale ?? fd.ModelPixelScaleTag);

            if((!tie||!tie.length) && Array.isArray(fd.ModelTiepoint)){
                const a=fd.ModelTiepoint; if (a.length>=6) tie=[{x:a[3],y:a[4],z:a[5]}];
            }
            if(!tie || !tie.length || !scale || scale.length<2){ setDem(null); log("DEM warning: missing georef — disabled."); return; }

            const originX=Number(tie[0].x), originY=Number(tie[0].y);
            const resX=Number(scale[0]), resY=-Math.abs(Number(scale[1]));
            if (![originX,originY,resX,resY].every(Number.isFinite)){ setDem(null); log("DEM warning: invalid georef — disabled."); return; }

            const noData =
                (typeof (img as any).getGDALNoData==="function"?(img as any).getGDALNoData():undefined) ??
                (typeof fd.GDAL_NODATA==="string"?Number(fd.GDAL_NODATA):undefined) ??
                (img as any).noDataValue ?? null;

            setDem({ width,height,originX,originY,resX,resY,noData,_img:img });
            log(`DEM ready: ${f.name} (${width}×${height})`);
        }catch(err:any){ setDem(null); log(`DEM load FAILED (safe): ${err?.message??err}`); }
    }

    // CP preview click
    function imagePreviewClick(e:React.MouseEvent){
        if (!cpMode || !photoEl) return;
        if (!nextNeedsImageRef.current) return;
        const el = cpPreviewRef.current; if (!el) return;
        const r = el.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const m = computePreviewMapping(previewSize.w, previewSize.h, imgW, imgH); if (!m) return;
        const uv = previewToImage(px, py, m); if (!uv) return;
        const { u, v } = uv;
        if (u<0||v<0||u>imgW||v>imgH) return;
        setCpPairs(prev=>{
            const copy = prev.slice();
            copy.push({ img:{ x:+u.toFixed(2), y:+v.toFixed(2) } });
            drawCpLayer(copy);
            return copy;
        });
        nextNeedsImageRef.current = false;
    }

    function drawCpLayer(pairs:any[]){
        const layer = cpLayerRef.current; if (!layer) return;
        layer.removeAll();
        pairs.forEach((p:any, i:number)=>{
            if (!p.map) return;
            layer.add(new Graphic({
                geometry:{ type:"point", x:p.map.lon, y:p.map.lat, spatialReference:WGS84 },
                symbol:{ type:"text", text:String(i+1), font:{ size:12, weight:"bold" }, color:[255,255,255,1], haloColor:[0,0,0,1], haloSize:1.5 }
            }));
        });
    }

    function cpUndoLast(){
        setCpPairs(prev=>{
            const copy = prev.slice();
            if (copy.length===0) return copy;
            copy.pop();
            drawCpLayer(copy);
            nextNeedsImageRef.current = true;
            return copy;
        });
    }
    function cpClearAll(){
        setCpPairs([]);
        cpLayerRef.current?.removeAll();
        nextNeedsImageRef.current = true;
    }

    // draw frame from homography (visual only)
    function drawFrameFromHomography(pairs:any[]){
        if (pairs.length < 4) return false;
        const four = pairs.slice(0,4);
        if (four.some(p=>!p.img || !p.map)) return false;
        const imgPts = four.map((p:any)=>({ u: p.img.x, v: p.img.y }));
        const mapPtsM = four.map((p:any)=>lonLatToMerc(p.map.lon, p.map.lat));
        const H = computeHomographyDLT(imgPts, mapPtsM); if (!H) return false;
        const cornersPx = [{u:0,v:0},{u:imgW,v:0},{u:0,v:imgH},{u:imgW,v:imgH}];
        const mercCorners = cornersPx.map(c=>applyH(H!,c.u,c.v));
        if (mercCorners.some(m=>!m)) return false;
        const geoCorners = mercCorners.map((m:any)=>mercToLonLat(m.X,m.Y)).map(ll=>({ lon: ll.lon, lat: ll.lat }));
        drawFrameOnly([geoCorners[0], geoCorners[1], geoCorners[2], geoCorners[3]]);
        return true;
    }

    async function cpApply(){
        if (!photoEl){ log("Load image first."); return; }

        if (cpPairs.length < 4){ log("Need at least 4 pairs."); return; }

        // create media now (first time)
        await ensureMedia(photoEl);

        // set georeference from ALL pairs (the real warp)
        const cps = cpPairs.filter(p=>p.img && p.map).map((p:any)=>({
            sourcePoint:{ x:p.img.x, y:p.img.y },
            mapPoint:{ type:"point", x:p.map.lon, y:p.map.lat, spatialReference:WGS84 }
        }));
        imageElementRef.current!.georeference = new ControlPointsGeoreference({
            controlPoints: cps, width: imgW, height: imgH
        });

        // draw helper frame
        const ok = drawFrameFromHomography(cpPairs);
        if (!ok){
            const xs=cps.map((c:any)=>c.mapPoint.x), ys=cps.map((c:any)=>c.mapPoint.y);
            const TL={lon:Math.min(...xs),lat:Math.max(...ys)}, TR={lon:Math.max(...xs),lat:Math.max(...ys)};
            const BL={lon:Math.min(...xs),lat:Math.min(...ys)}, BR={lon:Math.max(...xs),lat:Math.min(...ys)};
            drawFrameOnly([TL,TR,BL,BR]);
        }

        // center where user expected (EXIF or click), only once
        if (pendingCenterRef.current){
            await safeGoTo({ center:[pendingCenterRef.current.lon, pendingCenterRef.current.lat], zoom:17 });
            pendingCenterRef.current = null;
        }
        if (keepInView) fitOverlayInsideView();
        log(`Applied ${cps.length} control point(s). Image placed.`);
    }

    // UI helpers
    const canPlace = !!photoEl;
    function badgeStyleForImagePoint(imgPt:{x:number,y:number}){
        const m = computePreviewMapping(previewSize.w, previewSize.h, imgW, imgH);
        if (!m) return { display: "none" } as React.CSSProperties;
        const p = imageToPreview(imgPt.x, imgPt.y, m);
        if (!p) return { display: "none" } as React.CSSProperties;
        return {
            position: "absolute",
            left: `${p.x}px`,
            top: `${p.y}px`,
            transform: "translate(-50%, -50%)",
            background: "#000c",
            color: "#fff",
            fontSize: 12,
            padding: "1px 4px",
            borderRadius: 4,
            pointerEvents: "none"
        } as React.CSSProperties;
    }

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

                    {/* Clickable preview */}
                    <div
                        ref={cpPreviewRef}
                        onClick={imagePreviewClick}
                        style={{
                            marginTop:8, position:"relative",
                            width:"100%",
                            aspectRatio: (imgW>0 && imgH>0) ? `${imgW}/${imgH}` : "3/2",
                            background:"#111",
                            display:"grid", placeItems:"center",
                            cursor: cpMode ? "crosshair":"default",
                            border: cpMode ? "2px dashed #5fa" : "1px solid #333",
                            borderRadius:8, overflow:"hidden"
                        }}
                        title={cpMode ? (nextNeedsImageRef.current ? "Click image to set next point" : "Now click on the map to set matching point") : ""}
                    >
                        {photoURL ? (
                            <img
                                src={photoURL}
                                alt="preview"
                                style={{maxWidth:"100%", maxHeight:"100%", objectFit:"contain", pointerEvents:"none"}}
                            />
                        ) : <span style={{opacity:0.6}}>No image</span>}
                        {cpMode && cpPairs.map((p,i)=> p.img ? (
                            <span key={"imgpt"+i} style={badgeStyleForImagePoint(p.img)}>{i+1}</span>
                        ) : null)}
                    </div>
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
                            const view=viewRef.current; if(!view) return;
                            const h=view.on("click", async (ev:any)=>{
                                const mp=ev.mapPoint ?? view.toMap({x:ev.x,y:ev.y});
                                h.remove();
                                if (mp){
                                    pendingCenterRef.current = { lat:+(+mp.latitude).toFixed(8), lon:+(+mp.longitude).toFixed(8) };
                                    await safeGoTo({ center:[pendingCenterRef.current.lon, pendingCenterRef.current.lat], zoom:17 });
                                    log("Center set from map click. Add 4+ CPs and press Apply to place image.");
                                }
                            });
                        }}>🧭 Click map to set center</button>
                        <button disabled={!canPlace} onClick={async ()=>{
                            if (exif?.lat!=null && exif?.lon!=null){
                                pendingCenterRef.current = { lat:Number(exif.lat), lon:Number(exif.lon) };
                                await safeGoTo({ center:[pendingCenterRef.current.lon, pendingCenterRef.current.lat], zoom:17 });
                                log("Center set from EXIF GPS. Add 4+ CPs and press Apply to place image.");
                            } else {
                                log("No GPS in EXIF — click on the map to set center.");
                            }
                        }}>📍 Place at EXIF GPS (center only)</button>
                    </div>

                    <label style={{display:"flex",gap:8,alignItems:"center",marginTop:6}}>
                        <input type="checkbox" checked={keepInView} onChange={e=>setKeepInView(e.target.checked)}/>
                        <span>Keep overlay inside the map (after edits)</span>
                    </label>
                </div>

                <div className="card">
                    <h2>📍 Control points (Image → Map)</h2>
                    <label style={{display:"flex",gap:8,alignItems:"center"}}>
                        <input
                            type="checkbox"
                            checked={cpMode}
                            onChange={(e)=>{
                                const on = e.target.checked;
                                setCpMode(on);
                                if (on){ nextNeedsImageRef.current = true; log("CP mode ON: click image, then map."); }
                                else { log("CP mode OFF."); }
                            }}
                        />
                        <span>Enable CP mode (click image → then click map)</span>
                    </label>
                    <div style={{display:"flex",gap:8,marginTop:6}}>
                        <button onClick={cpUndoLast}>Undo last</button>
                        <button onClick={cpClearAll}>Clear all</button>
                        <button onClick={cpApply} disabled={cpPairs.length<4}>Apply 4+ pairs</button>
                    </div>
                    <div style={{marginTop:6, fontSize:12, opacity:0.8}}>
                        Steps: click image i → click map i. Repeat (≥4). Then press Apply to place the image.
                    </div>
                    <div style={{marginTop:6, fontSize:12}}>
                        Pairs: {cpPairs.length}{cpPairs.length? " — " + cpPairs.map((p,i)=>`${i+1}${p.map?"✓":""}`).join(", "):""}
                    </div>
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
