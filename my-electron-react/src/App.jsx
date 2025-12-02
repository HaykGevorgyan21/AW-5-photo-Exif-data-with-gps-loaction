import { BrowserRouter, Routes, Route } from "react-router-dom";
import PixelToMapNoCanvas from "./Components/PixelToMapNoCanvas/PixelToMapNoCanvas_sony_static_cam.tsx";
import ImageToMapOffline from "./Components/ImageToMapOffline.tsx";
import TopMenu from "./Components/TopMenu";

export default function App() {
    return (
        <BrowserRouter>
            <TopMenu />

            <div className="p-4">
                <div className="page-container">
                <Routes>
                    <Route
                        path="/"
                        element={
                            <PixelToMapNoCanvas
                                enableOpenCV={true}
                                opencvUrl="https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0/dist/opencv.js"
                            />
                        }
                    />

                    <Route
                        path="/imagetomap"
                        element={<ImageToMapOffline />}
                    />
                </Routes>
                </div>
            </div>
        </BrowserRouter>
    );
}
