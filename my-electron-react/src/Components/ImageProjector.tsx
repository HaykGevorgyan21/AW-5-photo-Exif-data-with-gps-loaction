    import React, { useEffect, useRef } from "react";
    import L from "leaflet";
    import "leaflet/dist/leaflet.css";
    import { computeFootprint } from "../utils/computeFootprint";
    import { CameraPose, DEM, Intrinsics } from "../utils/projection";

    type Props = {
        open: boolean;
        onClose: () => void;
        img: string;
        cam: CameraPose;
        intr: Intrinsics;
        dem: DEM;
    };

    export default function ImageProjector({
                                               open, onClose, img, cam, intr, dem
                                           }: Props) {

        const mapRef = useRef<HTMLDivElement>(null);

        useEffect(() => {
            if (!open) return;

            async function run() {
                const map = L.map(mapRef.current!, {
                    zoom: 17,
                    center: [cam.lat, cam.lon]
                });

                L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                    maxZoom: 19
                }).addTo(map);

                const fp = await computeFootprint(cam, intr, dem);

                L.imageOverlay(img, fp as any, { opacity: 0.7 }).addTo(map);
            }

            run();
        }, [open]);

        if (!open) return null;

        return (
            <div className="proj-overlay">
                <button className="close-btn" onClick={onClose}>✖</button>
                <div ref={mapRef} className="proj-map"></div>
            </div>
        );
    }
