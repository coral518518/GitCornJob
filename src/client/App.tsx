import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import RequireAuth from "./components/RequireAuth";
import { ToastProvider } from "./components/Toast";
import { ConfirmProvider } from "./ui/ConfirmDialog";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Jobs from "./pages/Jobs";
import Monitors from "./pages/Monitors";
import Accounts from "./pages/Accounts";
import Runs from "./pages/Runs";
import StatusPage from "./pages/StatusPage";

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* 公开状态页：免登录，独立渲染（不套 Layout/RequireAuth） */}
          <Route path="/status/:slug" element={<StatusPage />} />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/monitors" element={<Monitors />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/runs" element={<Runs />} />
          </Route>
        </Routes>
      </ConfirmProvider>
    </ToastProvider>
  );
}
