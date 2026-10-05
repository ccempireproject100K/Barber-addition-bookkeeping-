import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import AuthCallback from "@/pages/AuthCallback";
import Clients from "@/pages/Clients";
import PaymentResult from "@/pages/PaymentResult";
import Play from "@/pages/Play";
import { Toaster } from "@/components/ui/sonner";
import AppLayout, { InventoryGate } from "@/components/layout/AppLayout";
import Auth from "@/pages/Auth";
import Dashboard from "@/pages/Dashboard";
import Money from "@/pages/Money";
import Invoices from "@/pages/Invoices";
import Books from "@/pages/Books";
import Expenses from "@/pages/Expenses";
import Products from "@/pages/Products";
import ProductDetailPage from "@/pages/ProductDetail";
import QuickSell from "@/pages/QuickSell";
import Movements from "@/pages/Movements";
import StockCount from "@/pages/StockCount";
import Labels from "@/pages/Labels";
import Reports from "@/pages/Reports";
import Procurement from "@/pages/Procurement";
import Team from "@/pages/Team";
import Settings from "@/pages/Settings";
import CashClosePage from "@/pages/CashClose";
import AuditLog from "@/pages/AuditLog";
import ResetPassword from "@/pages/ResetPassword";

const gated = (el: React.ReactNode) => <InventoryGate>{el}</InventoryGate>;

// One <Route> per page in src/pages; BrowserRouter already wraps this in main.tsx.
export default function App() {
  const location = useLocation(); // Google sign-in returns with #session_id=… — handle it before any route/auth check
  if (location.hash?.includes("session_id=")) return <AuthCallback />;
  return (
    <>
      <Routes>
        <Route path="/login" element={<Auth mode="login" />} />
        <Route path="/signup" element={<Auth mode="signup" />} />
        <Route path="/play/:tenantId" element={<Play />} />
        <Route path="/forgot-password" element={<ResetPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/money" element={<Money />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/books" element={<Books />} />
          <Route path="/inventory" element={gated(<Products />)} />
          <Route path="/inventory/products/:id" element={gated(<ProductDetailPage />)} />
          <Route path="/inventory/sell" element={gated(<QuickSell />)} />
          <Route path="/clients" element={gated(<Clients />)} />
          <Route path="/clients/:id" element={gated(<Clients />)} />
          <Route path="/payment/success" element={gated(<PaymentResult />)} />
          <Route path="/payment/cancel" element={gated(<PaymentResult />)} />
          <Route path="/inventory/count" element={gated(<StockCount />)} />
          <Route path="/inventory/labels" element={gated(<Labels />)} />
          <Route path="/inventory/movements" element={gated(<Movements />)} />
          <Route path="/inventory/reports" element={gated(<Reports />)} />
          <Route path="/procurement" element={gated(<Procurement />)} />
          <Route path="/team" element={<Team />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/cash-close" element={<CashClosePage />} />
          <Route path="/audit" element={<AuditLog />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster richColors />
    </>
  );
}
