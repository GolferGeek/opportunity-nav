import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { takeSigninFromUrl } from "./api.ts";
import { App } from "./App.tsx";
import "./styles.css";

takeSigninFromUrl();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
