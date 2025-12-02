// ============================================================================
// FILE: src/components/MapPane.tsx
// PURPOSE: Always-on Leaflet map with an imperative API (flyTo, markers, overlay)
// ============================================================================
import React, { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type LatLon = { lat: number; lon: number };
export type DEMInfo = {
    width: number;
    height: number;
    originX: number; // lon of top-left (tiepoint)
    originY: number; // lat of top-left (tiepoint)
    resX: number;    // degrees lon per pixel
    resY: number;    // degrees lat per pixel (usually negative)
};

export type MapPaneHandle = {
    flyTo: (p: LatLon, zoom?: number) => void;
    setMarker: (p: LatLon) => void;
    setImageOverlay: (imgUrl: string, dem: DEMInfo) => void;
    clearOverlays: () => void;
};

const MapPane = forwardRef<MapPaneHandle, { className?: string }>(function MapPane(
    { className },
    ref
) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<L.Map | null>(null);
    const markerRef = useRef<L.Marker | null>(null);
    const overlayRef = useRef<L.ImageOverlay | null>(null);

    // Fix Leaflet icon asset URLs under Vite/Electron
    useEffect(() => {
        const iconUrl = new URL("leaflet/dist/images/marker-icon.png", import.meta.url).toString();
        const iconRetinaUrl = new URL("leaflet/dist/images/marker-icon-2x.png", import.meta.url).toString();
        const shadowUrl = new URL("leaflet/dist/images/marker-shadow.png", import.meta.url).toString();
        L.Icon.Default.mergeOptions({ iconUrl, iconRetinaUrl, shadowUrl });
    }, []);

    // Create the map once
    useEffect(() => {
        if (mapRef.current || !hostRef.current) return;
        const map = L.map(hostRef.current, { zoomControl: true, attributionControl: false })
            .setView([40.18, 44.52], 13); // default Yerevan-ish center

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 21 }).addTo(map);
        mapRef.current = map;
        setTimeout(() => map.invalidateSize(), 0); // ensure full size after mount
    }, []);

    // Expose API
    useImperativeHandle(ref, (): MapPaneHandle => ({
        flyTo: (p, zoom = 17) => {
            if (!mapRef.current) return;
            mapRef.current.flyTo([p.lat, p.lon], zoom);
        },
        setMarker: (p) => {
            if (!mapRef.current) return;
            if (markerRef.current) {
                markerRef.current.setLatLng([p.lat, p.lon]);
            } else {
                markerRef.current = L.marker([p.lat, p.lon]).addTo(mapRef.current);
            }
        },
        setImageOverlay: (imgUrl, dem) => {
            if (!mapRef.current) return;

            // Compute axis-aligned geographic bounds from DEM
            const lonLeft = dem.originX;
            const latTop = dem.originY;
            const lonRight = dem.originX + dem.width * dem.resX;
            const latBottom = dem.originY + dem.height * dem.resY;

            const sw: [number, number] = [
                Math.min(latTop, latBottom),
                Math.min(lonLeft, lonRight),
            ];
            const ne: [number, number] = [
                Math.max(latTop, latBottom),
                Math.max(lonLeft, lonRight),
            ];
            const bounds = L.latLngBounds(sw, ne);

            if (overlayRef.current) {
                overlayRef.current.remove();
                overlayRef.current = null;
            }
            overlayRef.current = L.imageOverlay(imgUrl, bounds, { opacity: 0.85 }).addTo(mapRef.current);
            mapRef.current.fitBounds(bounds);
        },
        clearOverlays: () => {
            if (overlayRef.current) {
                overlayRef.current.remove();
                overlayRef.current = null;
            }
        },
    }));

    return <div ref={hostRef} className={className ?? "leaflet-pane-full"} />;
});

export default MapPane;
