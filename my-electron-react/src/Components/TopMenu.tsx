import { Link } from "react-router-dom";
import "./TopMenu.scss";

export default function TopMenu() {
    return (
        <div className="topmenu">
            <Link to="/">Home</Link>
            <Link to="/imagetomap">ImageToMap</Link>
        </div>
    );
}
