import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Nav } from "./components/Nav.tsx";
import { Footer } from "./components/Footer.tsx";
import { ScrollToTop } from "./components/ScrollToTop.tsx";
import { Home } from "./pages/Home/Home.tsx";
import { Cloud } from "./pages/Cloud/Cloud.tsx";

export function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ScrollToTop />
      <Nav />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/cloud" element={<Cloud />} />
        </Routes>
      </main>
      <Footer />
    </BrowserRouter>
  );
}
