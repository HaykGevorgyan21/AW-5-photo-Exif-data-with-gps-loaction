import * as exifr from "exifr";

export async function readMetadata(file: File) {
    const meta = await exifr.parse(file);

    return {
        lat: meta.latitude,
        lon: meta.longitude,
        alt: meta.GPSAltitude,
        pitch: meta.FlightPitchDegree || meta.Pitch || 0,
        roll: meta.FlightRollDegree || meta.Roll || 0,
        yaw: meta.FlightYawDegree || meta.Yaw || 0
    };
}
