// ============================================================================
// FILE: src/Components/SceneOverlay.tsx
// ============================================================================

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

// ArcGIS JS API (ESM)
import Map from "@arcgis/core/Map";
import SceneView from "@arcgis/core/views/SceneView";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Graphic from "@arcgis/core/Graphic";
import MediaLayer from "@arcgis/core/layers/MediaLayer";
import ImageElement from "@arcgis/core/layers/support/ImageElement";
import Extent from "@arcgis/core/geometry/Extent";
import SpatialReference from "@arcgis/core/geometry/SpatialReference";

export type DEMInfo = {
    width: number; height: number;
    originX: number; originY: number;
    resX: number;   resY: number;
};

export type SceneOverlayHandle = {
    flyTo: (lat: number, lon: number, zoom?: number) => void;
    setMarker: (lat: number, lon: number) => void;
    setImageOverlay: (imageUrl: string, dem: DEMInfo) => void;
    clearOverlays: () => void;
};

type Props = { className?: string };

const SceneOverlay = forwardRef<SceneOverlayHandle, Props>(function SceneOverlay({ className }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<SceneView | null>(null);
    const mapRef = useRef<Map | null>(null);
    const gfxLayerRef = useRef<GraphicsLayer | null>(null);
    const markerRef = useRef<Graphic | null>(null);
    const mediaLayerRef = useRef<MediaLayer | null>(null);

    useEffect(() => {
        if (viewRef.current || !hostRef.current) return;

        // why: world-elevation ապահովում է իրական ռելիեֆ
        const map = new Map({
            basemap: "satellite",
            ground: "world-elevation",
        });

        const view = new SceneView({
            container: hostRef.current,
            map,
            center: [44.51, 40.18],
            zoom: 13,
            qualityProfile: "high",
            environment: {
                lighting: { directShadowsEnabled: true, ambientOcclusionEnabled: true },
            },
            // performance-friendly default tilt
            camera: { position: { longitude: 44.51, latitude: 40.18, z: 1200 }, tilt: 45, heading: 0 },
        });

        const gfx = new GraphicsLayer();
        map.add(gfx);

        mapRef.current = map;
        viewRef.current = view;
        gfxLayerRef.current = gfx;

        const ro = new ResizeObserver(() => view.resize());
        ro.observe(hostRef.current);

        return () => {
            ro.disconnect();
            // remove media layer if any to free textures
            if (mediaLayerRef.current) {
                mapRef.current?.remove(mediaLayerRef.current);
                mediaLayerRef.current.destroy();
                mediaLayerRef.current = null;
            }
            view.destroy();
            viewRef.current = null;
            gfxLayerRef.current = null;
            mapRef.current = null;
        };
    }, []);

    useImperativeHandle(ref, (): SceneOverlayHandle => ({
        flyTo: (lat, lon, zoom = 18) => {
            const view = viewRef.current;
            if (!view) return;
            // why: 3D օգտատերային փորձ՝ թեք դիտանկյուն
            view.goTo({
                center: [lon, lat],
                zoom,
                tilt: 65,
                heading: 0,
            }, { animate: true });
        },

        setMarker: (lat, lon) => {
            const view = viewRef.current;
            const gfx = gfxLayerRef.current;
            if (!view || !gfx) return;

            const point = {
                type: "point" as const,
                longitude: lon,
                latitude: lat,
                spatialReference: SpatialReference.WGS84
            };

            const symbol = {
                type: "point-3d" as const,
                symbolLayers: [{
                    type: "icon" as const,
                    size: 16,
                    resource: { primitive: "circle" },
                    outline: { color: "white", size: 1.5 }
                }]
            };

            if (markerRef.current) {
                markerRef.current.geometry = point as any;
            } else {
                markerRef.current = new Graphic({ geometry: point as any, symbol: symbol as any });
                gfx.add(markerRef.current);
            }
        },

        setImageOverlay: (imageUrl, dem) => {
            const map = mapRef.current;
            const view = viewRef.current;
            if (!map || !view) return;

            const lonL = dem.originX;
            const latT = dem.originY;
            const lonR = dem.originX + dem.width * dem.resX;
            const latB = dem.originY + dem.height * dem.resY;

            const xmin = Math.min(lonL, lonR);
            const xmax = Math.max(lonL, lonR);
            const ymin = Math.min(latB, latT);
            const ymax = Math.max(latB, latT);

            const extent = new Extent({
                xmin, ymin, xmax, ymax,
                spatialReference: SpatialReference.WGS84
            });

            // previous media removed before add new
            if (mediaLayerRef.current) {
                map.remove(mediaLayerRef.current);
                mediaLayerRef.current.destroy();
                mediaLayerRef.current = null;
            }

            const img = new ImageElement({
                href: imageUrl,
                extent
            });

            const media = new MediaLayer({
                source: [img],
                spatialReference: SpatialReference.WGS84
            });

            map.add(media);
            mediaLayerRef.current = media;

            // focus to the overlay
            view.goTo(extent.expand(1.15)).catch(() => {});
        },

        clearOverlays: () => {
            if (mediaLayerRef.current && mapRef.current) {
                mapRef.current.remove(mediaLayerRef.current);
                mediaLayerRef.current.destroy();
                mediaLayerRef.current = null;
            }
        },
    }));

    return <div ref={hostRef} className={className ?? "mp-map"} />;
});

export default SceneOverlay;
