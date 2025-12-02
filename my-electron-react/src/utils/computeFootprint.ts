import { projectPixelToDEM, CameraPose, Intrinsics, DEM } from "./projection";

export async function computeFootprint(
    cam: CameraPose,
    intr: Intrinsics,
    dem: DEM
) {
    const W = intr.W;
    const H = intr.H;

    const corners = [
        [0, 0],
        [W, 0],
        [W, H],
        [0, H]
    ];

    const out = [];

    for (const [x, y] of corners) {
        const p = await projectPixelToDEM(x, y, cam, intr, dem);
        out.push(p);
    }

    return out; // [[lat,lon], ...]
}
