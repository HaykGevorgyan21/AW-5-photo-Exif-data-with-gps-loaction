
// ============================================================================
// FILE: src/pages/ImageToMap.tsx
// PURPOSE: Left upload panel + right always-on map (Mission Planner style)
// ============================================================================
import React, { useRef, useState } from "react";
import { fromArrayBuffer } from "geotiff";
import * as exifr from "exifr";
import MapPane, { MapPaneHandle, DEMInfo } from "../components/MapPane";
import "./ImageToMap.scss";

export default function ImageToMap() {
    const mapRef = useRef<MapPaneHandle | null>(null);

    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [gps, setGps] = useState<{ lat: number; lon: number } | null>(null);
    const [dem, setDem] = useState<DEMInfo | null>(null);
    const [status, setStatus] = useState("Load image and DEM...");

    // Image loader (EXIF)
    async function onLoadImage(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;

        const url = URL.createObjectURL(file);
        setImageUrl(url);

        try {
            const meta = await exifr.parse(file);
            const lat = typeof meta?.GPSLatitude === "number" ? meta.GPSLatitude : null;
            const lon = typeof meta?.GPSLongitude === "number" ? meta.GPSLongitude : null;

            if (lat != null && lon != null) {
                setGps({ lat, lon });
                setStatus(`Image loaded.\nGPS: lat=${lat}, lon=${lon}`);
            } else {
                setGps(null);
                setStatus("Image loaded. No GPS in EXIF.");
            }
        } catch (err) {
            console.error(err);
            setGps(null);
            setStatus("Image loaded, but EXIF read failed.");
        }
    }

    // DEM loader (GeoTIFF, tiepoint + scale)
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
            const resY = -Math.abs(Number(scale[1])); // top-left origin

            setDem({ width, height, originX, originY, resX, resY });

            setStatus(
                `DEM loaded: ${file.name}\n` +
                `size = ${width} x ${height}\n` +
                `origin(lon,lat) = (${originX}, ${originY})\n` +
                `res = (${resX}, ${resY})`
            );
        } catch (err: any) {
            console.error(err);
            setDem(null);
            setStatus(`DEM load FAILED: ${err.message ?? err}`);
        }
    }

    // Action: center + overlay
    function locateOnMap() {
        if (!mapRef.current || !gps) return;
        mapRef.current.clearOverlays();
        mapRef.current.setMarker(gps);
        mapRef.current.flyTo(gps, 18);
        if (imageUrl && dem) {
            mapRef.current.setImageOverlay(imageUrl, dem);
        }
    }

    return (
        <div className="mp-layout">
            {/* LEFT: controls like Mission Planner */}
            <div className="mp-left">
                <div className="card">
                    <h2>📸 Upload Image</h2>
                    <label className="upload">
                        <input type="file" accept="image/*" onChange={onLoadImage} />
                        <div className="upload-ui">
                            <div className="title">Choose a photo</div>
                            <div className="hint">EXIF with GPS is required</div>
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
                            <div className="hint">ModelTiepoint + ModelPixelScale</div>
                        </div>
                    </label>
                </div>

                <div className="card">
                    <h2>Status</h2>
                    <pre className="status">{status}</pre>
                    <button
                        className="primary"
                        disabled={!gps}
                        onClick={locateOnMap}
                        title={!gps ? "Load an image with GPS first" : "Center & overlay"}
                    >
                        📍 Locate on Map
                    </button>
                </div>
            </div>

            {/* RIGHT: live map */}
            <div className="mp-right">
                <MapPane ref={mapRef} className="mp-map" />
            </div>
        </div>
    );
}