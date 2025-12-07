
// ============================================================================
// FILE: src/Components/ImageToScene.tsx
// ============================================================================

import React, { useRef, useState } from "react";
import { fromArrayBuffer } from "geotiff";
import * as exifr from "exifr";
import SceneOverlay, { type DEMInfo, type SceneOverlayHandle } from "./SceneOverlay";
import "./ImageToMap.scss"; // reuse same styles

// DMS → decimal fallback
function dmsToDec(v?: string | number | null): number | null {
    if (typeof v === "number") return v;
    if (!v) return null;
    const m = String(v).match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D*([NSEW])?/i);
    if (!m) return null;
    const D = parseFloat(m[1]), M = parseFloat(m[2]), S = parseFloat(m[3]);
    let out = D + M / 60 + S / 3600;
    const hemi = (m[4] || "").toUpperCase();
    if (hemi === "S" || hemi === "W") out *= -1;
    return out;
}

export default function ImageToScene() {
    const sceneRef = useRef<SceneOverlayHandle | null>(null);

    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [lat, setLat] = useState<number | null>(null);
    const [lon, setLon] = useState<number | null>(null);
    const [dem, setDem] = useState<DEMInfo | null>(null);
    const [status, setStatus] = useState("Load image and DEM...");

    async function onLoadImage(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;

        setImageUrl(URL.createObjectURL(file));

        try {
            const gps = await exifr.gps(file).catch(() => null as any);
            let la: number | null = gps?.latitude ?? null;
            let lo: number | null = gps?.longitude ?? null;

            const meta: any = await exifr.parse(file, { xmp: true, userComment: true }).catch(() => ({}));
            if (la == null && typeof meta?.GPSLatitude === "number") la = meta.GPSLatitude;
            if (lo == null && typeof meta?.GPSLongitude === "number") lo = meta.GPSLongitude;
            if (la == null && typeof meta?.GPSLatitude === "string") la = dmsToDec(meta.GPSLatitude);
            if (lo == null && typeof meta?.GPSLongitude === "string") lo = dmsToDec(meta.GPSLongitude);
            if ((la == null || lo == null) && typeof meta?.GPSPosition === "string") {
                const [a, b] = meta.GPSPosition.split(",").map((s: string) => s.trim());
                if (la == null) la = dmsToDec(a);
                if (lo == null) lo = dmsToDec(b);
            }

            setLat(la);
            setLon(lo);

            setStatus(`Image loaded.\nGPS: lat=${la ?? "?"}, lon=${lo ?? "?"}`);
        } catch (err) {
            console.error(err);
            setStatus("Image loaded, but EXIF/GPS parse failed.");
        }
    }

    async function onLoadDEM(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const buf = await file.arrayBuffer();
            const tiff = await fromArrayBuffer(buf);
            const img = await tiff.getImage();
            const width = img.getWidth();
            const height = img.getHeight();
            const tie = img.getTiePoints();
            const scale = (img.getFileDirectory() as any).ModelPixelScale;
            if (!tie || !scale) throw new Error("DEM missing tiepoints or pixel scale");

            const originX = tie[0].x;
            const originY = tie[0].y;
            const resX = Number(scale[0]);
            const resY = -Math.abs(Number(scale[1]));

            setDem({ width, height, originX, originY, resX, resY });
            setStatus(
                `DEM loaded: ${file.name}\nsize=${width}x${height}\norigin(lon,lat)=(${originX}, ${originY})\nres=(${resX}, ${resY})`
            );
        } catch (err: any) {
            console.error(err);
            setDem(null);
            setStatus(`DEM load FAILED: ${err?.message ?? err}`);
        }
    }

    function onLocate() {
        if (lat == null || lon == null || !sceneRef.current) return;
        sceneRef.current.clearOverlays();
        sceneRef.current.setMarker(lat, lon);
        sceneRef.current.flyTo(lat, lon, 18);
        if (imageUrl && dem) sceneRef.current.setImageOverlay(imageUrl, dem);
    }

    const canLocate = lat != null && lon != null;

    return (
        <div className="mp-layout">
            <div className="mp-left">
                <div className="card">
                    <h2>📸 Upload Image</h2>
                    <label className="upload">
                        <input type="file" accept="image/*" onChange={onLoadImage} />
                        <div className="upload-ui">
                            <div className="title">Choose a photo</div>
                            <div className="hint">EXIF with GPS is required (DMS ok)</div>
                        </div>
                    </label>
                    <div className="preview">
                        {imageUrl ? <img src={imageUrl} alt="preview" /> : <span>No image</span>}
                    </div>
                </div>

                <div className="card">
                    <h2>🌍 Upload DEM (.tif)</h2>
                    <label className="upload">
                        <input type="file" accept=".tif,.tiff" onChange={onLoadDEM} />
                        <div className="upload-ui">
                            <div className="title">Choose GeoTIFF</div>
                            <div className="hint">Tiepoint + PixelScale required</div>
                        </div>
                    </label>
                </div>

                <div className="card">
                    <h2>Status</h2>
                    <pre className="status">{status}</pre>
                    <button className="primary" disabled={!canLocate} onClick={onLocate}>📍 Locate on 3D Map</button>
                </div>
            </div>

            <div className="mp-right">
                <SceneOverlay ref={sceneRef} className="mp-map" />
            </div>
        </div>
    );
}

