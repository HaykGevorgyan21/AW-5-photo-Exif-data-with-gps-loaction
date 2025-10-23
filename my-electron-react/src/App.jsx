import PixelToMapNoCanvas from "./components/PixelToMapNoCanvas";

export default function App(){
    return (
        <div className="p-4">
            {/* enableOpenCV ցուցիչը բացում է undistort UI-ն (պահիր opencv.js-ը public/ կամ specify url) */}
            <PixelToMapNoCanvas
                enableOpenCV={true}
                opencvUrl="https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0/dist/opencv.js"
            />


        </div>
    );
}
