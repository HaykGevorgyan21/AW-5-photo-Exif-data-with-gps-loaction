import PixelToMapNoCanvas from "./components/PixelToMapNoCanvas/PixelToMapNoCanvas_sony_static_cam"

export default function App() {
    return (
        <div className="p-4">
            {/* enableOpenCV true => UI բացվում է; CDN օգտագործելիս installer-ում ինտերնետ է պետք */}
            <PixelToMapNoCanvas
                enableOpenCV={true}
                opencvUrl="https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0/dist/opencv.js"
            />
        </div>
    );
}
