import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { CreatePage } from "./pages/CreatePage";
import { SessionPage } from "./pages/SessionPage";
import { Sparkles } from "./components/Sparkles";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <nav className="topbar">
        <Link to="/" className="brand" aria-label="GameNightly home">
          <Sparkles />
          <span>
            Game<span className="brand-night">Nightly</span>
          </span>
        </Link>
      </nav>
      <Routes>
        <Route path="/" element={<CreatePage />} />
        <Route path="/s/:slug" element={<SessionPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
