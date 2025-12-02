// ============================================================================
// FILE: src/components/ImageMapModal.tsx
// PURPOSE: Show GPS position and optional image footprint on Leaflet map
// ============================================================================

import React, { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { projectPixelToGround } from "../utils/projection";

type GPS = { lat: number; lon: number };
type Meta = { width: number; height: number } & Record<string, unknown>;

type Props = {
    open: boolean;
    onClose: () => void;
    gps: GPS | null;
    meta: Meta | null;      // pass your DEM/meta object; width/height required if footprint used
    image: string | null;   // not required for map, only if you plan overlay
};

export default function ImageMapModal({ open, onClose, gps, meta, image }: Props) {
    const mapHostRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<L.Map | null>(null);

    // ESM-safe icon URLs (Vite/Electron)
    const iconUrl = new URL("leaflet/dist/images/marker-icon.png", import.meta.url).toString();
    const iconRetinaUrl = new URL("leaflet/dist/images/marker-icon-2x.png", import.meta.url).toString();
    const shadowUrl = new URL("leaflet/dist/images/marker-shadow.png", import.meta.url).toString();

    useEffect(() => {
        L.Icon.Default.mergeOptions({ iconUrl, iconRetinaUrl, shadowUrl });
    }, [iconUrl, iconRetinaUrl, shadowUrl]);

    useEffect(() => {
        if (!open) return;
        if (!mapHostRef.current) return;
        if (!gps) return; // why: at least GPS is needed to center the map

        // Create map once per open
        if (!mapRef.current) {
            mapRef.current = L.map(mapHostRef.current, {
                zoomControl: true,
                attributionControl: false,
            }).setView([gps.lat, gps.lon], 17);

            L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                maxZoom: 21,
            }).addTo(mapRef.current);

            L.marker([gps.lat, gps.lon]).addTo(mapRef.current);

            // why: container becomes visible after mount
            setTimeout(() => mapRef.current && mapRef.current.invalidateSize(), 0);
        } else {
            // Recenter if gps changes
            mapRef.current.setView([gps.lat, gps.lon], 17);
        }

        // Optional footprint if meta exists
        if (meta?.width && meta?.height) {
            try {
                const w = Number(meta.width);
                const h = Number(meta.height);

                const pts = [
                    projectPixelToGround(0, 0, meta, gps),
                    projectPixelToGround(w, 0, meta, gps),
                    projectPixelToGround(w, h, meta, gps),
                    projectPixelToGround(0, h, meta, gps),
                ].filter(Boolean) as GPS[];

                if (pts.length === 4 && mapRef.current) {
                    const poly = L.polygon(
                        pts.map((p) => [p.lat, p.lon]) as [number, number][],
                        { weight: 2 } // why: rely on default color to avoid CSS/TS issues
                    ).addTo(mapRef.current);
                    mapRef.current.fitBounds(poly.getBounds());
                }
            } catch (e) {
                console.warn("Footprint projection failed:", e);
            }
        }

        return () => {
            if (mapRef.current) {
                mapRef.current.remove();
                mapRef.current = null;
            }
        };
    }, [open, gps, meta]);

    if (!open) return null;

    return (
        <div className="imagemap-backdrop">
            <div className="imagemap-container">
                <button className="imagemap-close" onClick={onClose} aria-label="Close">✖</button>
                <div ref={mapHostRef} className="imagemap-map" />
            </div>
        </div>
    );
}

// ============================================================================
// FILE: src/pages/ImageToMapOffline.tsx
// PURPOSE: Wire the modal, ensure GPS present, pass DEM/meta
// ============================================================================
import React, { useRef, useState } from "react";
import { fromArrayBuffer } from "geotiff";
import * as exifr from "exifr";
import ImageMapModal from "../components/ImageMapModal";
import "./ImageToMapOffline.scss";

type DEMInfo = {
    width: number;
    height: number;
    originX: number;
    originY: number;
    resX: number;
    resY: number;
    summary: string;
} | null;

export default function ImageToMapOffline() {
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [lat, setLat] = useState<number | null>(null);
    const [lon, setLon] = useState<number | null>(null);
    const [dem, setDem] = useState<DEMInfo>(null);
    const [out, setOut] = useState("Load image and DEM...");
    const [mapOpen, setMapOpen] = useState(false);
    const demFileRef = useRef<File | null>(null);

    async function onLoadImage(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setImageUrl(URL.createObjectURL(file));
        try {
            const meta = await exifr.parse(file);
            if (typeof meta?.GPSLatitude === "number") setLat(meta.GPSLatitude);
            if (typeof meta?.GPSLongitude === "number") setLon(meta.GPSLongitude);
            setOut(`Image loaded.\nGPS: lat=${meta?.GPSLatitude ?? "?"}, lon=${meta?.GPSLongitude ?? "?"}`);
        } catch {
            setOut("Image loaded, but EXIF failed.");
        }
    }

    async function onLoadDEM(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        demFileRef.current = file;
        try {
            const buf = await file.arrayBuffer();
            const tiff = await fromArrayBuffer(buf);
            const img = await tiff.getImage();
            const width = img.getWidth();
            const height = img.getHeight();
            const tie = img.getTiePoints();
            const scale = (img.getFileDirectory() as any).ModelPixelScale;
            if (!tie || !scale) throw new Error("DEM missing tiepoints or scale");
            const originX = tie[0].x;
            const originY = tie[0].y;
            const resX = scale[0];
            const resY = -Math.abs(scale[1]);
            const summary =
                `DEM loaded: ${file.name}\nsize = ${width} x ${height}\norigin(lon,lat) = (${originX}, ${originY})\nres = (${resX}, ${resY})`;
            setDem({ width, height, originX, originY, resX, resY, summary });
            setOut(summary);
        } catch (err: any) {
            setOut(`DEM load FAILED: ${err.message}`);
            setDem(null);
        }
    }

    const gps = lat != null && lon != null ? { lat, lon } : null;

    return (
        <div className="itm-root">
            <h2>Offline Image → DEM Loader</h2>

            <div className="layout">
                <div className="left">
                    <h3>📸 Upload Image</h3>
                    <input type="file" accept="image/*" onChange={onLoadImage} />
                    <h3 style={{ marginTop: 25 }}>🌍 Upload DEM (.tif)</h3>
                    <input type="file" accept=".tif,.tiff" onChange={onLoadDEM} />
                    <div className="image-preview-container">
                        {imageUrl ? <img className="image-preview" src={imageUrl} /> : <div className="im-placeholder">No image selected</div>}
                    </div>
                </div>

                <div className="right">
                    <h3>Status:</h3>
                    <pre className="statusBox">{out}</pre>

                    {dem && (
                        <div className="demBox">
                            <h3>DEM Data</h3>
                            <pre>{dem.summary}</pre>
                        </div>
                    )}

                    <button
                        className="locateBtn"
                        disabled={!gps}
                        onClick={() => setMapOpen(true)}
                        title={!gps ? "Load an image with GPS EXIF" : "Open map"}
                    >
                        📍 Locate on Map
                    </button>
                </div>
            </div>

            <ImageMapModal
                open={mapOpen}
                onClose={() => setMapOpen(false)}
                gps={gps}
                meta={dem}        // contains width/height; projection function can read others as needed
                image={imageUrl}
            />
        </div>
    );
}