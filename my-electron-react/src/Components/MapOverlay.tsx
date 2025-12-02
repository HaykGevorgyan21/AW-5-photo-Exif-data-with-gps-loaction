// ============================================================================
// FILE: src/Components/MapOverlay.tsx
// ============================================================================
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type DEMInfo = {
    width: number; height: number;
    originX: number; originY: number;
    resX: number;   resY: number;
};

export type MapOverlayHandle = {
    flyTo: (lat: number, lon: number, zoom?: number) => void;
    setMarker: (lat: number, lon: number) => void;
    setImageOverlay: (imageUrl: string, dem: DEMInfo) => void;
    clearOverlays: () => void;
};

type Props = { className?: string };

const MapOverlay = forwardRef<MapOverlayHandle, Props>(function MapOverlay({ className }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<L.Map | null>(null);
    const markerRef = useRef<L.Marker | null>(null);
    const overlayRef = useRef<L.ImageOverlay | null>(null);

    useEffect(() => {
        // fix marker icons (Vite/Electron)
        const iconUrl = new URL("leaflet/dist/images/marker-icon.png", import.meta.url).toString();
        const iconRetinaUrl = new URL("leaflet/dist/images/marker-icon-2x.png", import.meta.url).toString();
        const shadowUrl = new URL("leaflet/dist/images/marker-shadow.png", import.meta.url).toString();
        L.Icon.Default.mergeOptions({ iconUrl, iconRetinaUrl, shadowUrl });
    }, []);

    useEffect(() => {
        if (mapRef.current || !hostRef.current) return;

        const map = L.map(hostRef.current, { zoomControl: true, attributionControl: true })
            .setView([40.18, 44.51], 13);

        const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 21, attribution: "&copy; OpenStreetMap",
        }).addTo(map);

        const esri = L.tileLayer(
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            { maxZoom: 21, attribution: "Tiles © Esri" }
        );

        L.control.layers({ "OSM Streets": osm, "Esri Satellite": esri }).addTo(map);

        mapRef.current = map;

        // why: Leaflet needs this when container size changes after mount
        const ro = new ResizeObserver(() => map.invalidateSize());
        ro.observe(hostRef.current);
        const onResize = () => map.invalidateSize();
        window.addEventListener("resize", onResize);

        // first tick -> ensure full width
        setTimeout(() => map.invalidateSize(), 0);

        return () => {
            ro.disconnect();
            window.removeEventListener("resize", onResize);
            map.remove();
            mapRef.current = null;
        };
    }, []);

    useImperativeHandle(ref, (): MapOverlayHandle => ({
        flyTo: (lat, lon, zoom = 18) => mapRef.current?.flyTo([lat, lon], zoom),
        setMarker: (lat, lon) => {
            if (!mapRef.current) return;
            if (markerRef.current) markerRef.current.setLatLng([lat, lon]);
            else markerRef.current = L.marker([lat, lon]).addTo(mapRef.current);
        },
        setImageOverlay: (imageUrl, dem) => {
            if (!mapRef.current) return;

            const lonL = dem.originX, latT = dem.originY;
            const lonR = dem.originX + dem.width * dem.resX;
            const latB = dem.originY + dem.height * dem.resY;

            const sw: [number, number] = [Math.min(latT, latB), Math.min(lonL, lonR)];
            const ne: [number, number] = [Math.max(latT, latB), Math.max(lonL, lonR)];
            const bounds = L.latLngBounds(sw, ne);

            overlayRef.current?.remove();
            overlayRef.current = L.imageOverlay(imageUrl, bounds, { opacity: 0.85 }).addTo(mapRef.current);
            mapRef.current.fitBounds(bounds);
        },
        clearOverlays: () => {
            overlayRef.current?.remove();
            overlayRef.current = null;
        },
    }));

    return <div ref={hostRef} className={className ?? "mp-map"} />;
});

export default MapOverlay;
