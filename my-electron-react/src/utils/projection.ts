    // ==========================
    // projection.ts — Pixel → DEM
    // ==========================
    import { fromArrayBuffer } from "geotiff";

    export type CameraPose = {
        lat: number;        // deg
        lon: number;        // deg
        alt: number;        // meters AMSL
        yaw: number;        // deg
        pitch: number;      // deg
        roll: number;       // deg
    };

    export type Intrinsics = {
        W: number;
        H: number;
        fx: number;
        fy: number;
        cx: number;
        cy: number;
    };

    export type DEMInfo = {
        raster: any;
        width: number;
        height: number;
        originX: number;
        originY: number;
        resX: number;
        resY: number;
    };

    // -----------------------------
    const toRad = (d: number) => d * Math.PI / 180;

    // -----------------------------
    export async function loadDEM(file: File): Promise<DEMInfo> {
        const buf = await file.arrayBuffer();
        const tiff = await fromArrayBuffer(buf);
        const img = await tiff.getImage();

        const width = img.getWidth();
        const height = img.getHeight();

        const tie = img.getTiePoints();
        const scale = img.getFileDirectory().ModelPixelScale;

        const raster = (await img.readRasters())[0];

        return {
            raster,
            width,
            height,
            originX: tie[0].x,
            originY: tie[0].y,
            resX: scale[0],
            resY: -Math.abs(scale[1]),
        };
    }

    // -----------------------------
    // DEM read (lon,lat → elevation)
    // -----------------------------
    export function readDEM(dem: DEMInfo, lon: number, lat: number): number | null {
        const col = Math.floor((lon - dem.originX) / dem.resX);
        const row = Math.floor((lat - dem.originY) / dem.resY);

        if (col < 0 || row < 0 || col >= dem.width || row >= dem.height)
            return null;

        return dem.raster[row * dem.width + col];
    }

    // -----------------------------
    // Rotation matrices
    // -----------------------------
    function rotX(a: number) {
        return [
            [1, 0, 0],
            [0, Math.cos(a), -Math.sin(a)],
            [0, Math.sin(a), Math.cos(a)]
        ];
    }

    function rotY(a: number) {
        return [
            [Math.cos(a), 0, Math.sin(a)],
            [0, 1, 0],
            [-Math.sin(a), 0, Math.cos(a)]
        ];
    }

    function rotZ(a: number) {
        return [
            [Math.cos(a), -Math.sin(a), 0],
            [Math.sin(a), Math.cos(a), 0],
            [0, 0, 1]
        ];
    }

    function matMul(A: number[][], B: number[][]) {
        return A.map((r, i) =>
            r.map((_, j) =>
                A[i][0] * B[0][j] +
                A[i][1] * B[1][j] +
                A[i][2] * B[2][j]
            )
        );
    }

    function vecMul(M: number[][], v: number[]) {
        return [
            M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
            M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
            M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
        ];
    }

    // -----------------------------
    // Pixel → Ground (DEM intersect)
    // -----------------------------
    export function projectPixelToDEM(
        px: number,
        py: number,
        cam: CameraPose,
        K: Intrinsics,
        dem: DEMInfo
    ): { lat: number; lon: number; ground: number } | null {

        // 1) Camera ray in camera frame
        const xn = (px - K.cx) / K.fx;
        const yn = (py - K.cy) / K.fy;
        const rayCam = [xn, yn, 1];

        // 2) Rotation
        const Rz = rotZ(toRad(cam.yaw));
        const Ry = rotY(toRad(cam.pitch));
        const Rx = rotX(toRad(cam.roll));

        let R = Rz;
        R = matMul(R, Ry);
        R = matMul(R, Rx);

        const ray = vecMul(R, rayCam);

        // 3) Ray march
        let lat = cam.lat;
        let lon = cam.lon;
        let alt = cam.alt;

        for (let i = 0; i < 5000; i++) {
            const zGround = readDEM(dem, lon, lat);
            if (zGround !== null && alt <= zGround)
                return { lat, lon, ground: zGround };

            // Step: adjust by small meter steps
            const step = 3; // meters

            // Convert meters to deg
            const degLat = step / 111320;
            const degLon = step / (111320 * Math.cos(toRad(lat)));

            alt -= ray[2] * step;
            lon += ray[0] * degLon * step;
            lat += ray[1] * degLat * step;
        }

        return null;
    }
