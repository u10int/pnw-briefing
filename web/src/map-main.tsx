import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import MapPage from "./MapPage"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MapPage />
  </StrictMode>,
)
