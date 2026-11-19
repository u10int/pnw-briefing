import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import LocationPage from "./LocationPage"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocationPage />
  </StrictMode>,
)
