// utils/demLoader.ts
import { fromArrayBuffer, GeoTIFFImage } from "geotiff";

export async function loadDEM(file: File) {
    const buf = await file.arrayBuffer();

    // ✔️ Ճիշտ ձև
    const tiff = await fromArrayBuffer(buf);

    const image: GeoTIFFImage = await tiff.getImage();
    const ras = await image.readRasters();

    const [minX, minY, maxX, maxY] = image.getBoundingBox();
    const [resX, resY_raw] = image.getResolution();
    const resY = Math.abs(resY_raw);

    const width = image.getWidth();
    const height = image.getHeight();

    function read(lon: number, lat: number) {
        if (lon < minX || lon > maxX || lat < minY || lat > maxY) return null;

        const x = Math.floor((lon - minX) / resX);
        const y = Math.floor((maxY - lat) / resY);

        if (x < 0 || y < 0 || x >= width || y >= height) return null;

        return ras[0][y * width + x];
    }

    return {
        image,
        width,
        height,
        bbox: [minX, minY, maxX, maxY],
        resX,
        resY,
        read,
    };
}
