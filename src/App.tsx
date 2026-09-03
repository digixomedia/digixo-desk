import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { QueryProvider } from "@/lib/query";
import { RequireAuth } from "@/components/route-guards";
import { ErrorBoundary } from "@/components/error-boundary";
import { AppLayout } from "@/components/app-layout";
import { LoginPage } from "@/pages/login";
import { DashboardPage } from "@/pages/dashboard";
import { CategoriesPage } from "@/pages/categories";
import { ProductsPage } from "@/pages/products";
import { CustomersPage } from "@/pages/customers";
import { CustomerProfilePage } from "@/pages/customer-profile";
import { NewSalePage } from "@/pages/new-sale";
import { SalesPage } from "@/pages/sales";
import { RenewalsPage } from "@/pages/renewals";
import { FinancialReportsPage } from "@/pages/financial-reports";
import { ExportDataPage } from "@/pages/export-data";
import { RefundsPage } from "@/pages/refunds";
import { DemoDataPage } from "@/pages/demo-data";
import { IntegrationsPage } from "@/pages/integrations";
import { SettingsPage } from "@/pages/settings";
import { RequireOwner } from "@/components/route-guards";

export function App() {
  return (
    <AuthProvider>
      <QueryProvider>
        <BrowserRouter>
          <ErrorBoundary>
            <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/*"
              element={
                <RequireAuth>
                  <AppLayout>
                    <Routes>
                      <Route path="/" element={<DashboardPage />} />
                      <Route path="/categories" element={<CategoriesPage />} />
                      <Route path="/products" element={<ProductsPage />} />
                      <Route path="/customers" element={<CustomersPage />} />
                      <Route path="/customers/:id" element={<CustomerProfilePage />} />
                      <Route path="/sales" element={<SalesPage />} />
                      <Route path="/sales/new" element={<NewSalePage />} />
                      <Route path="/renewals" element={<RenewalsPage />} />
                      <Route path="/finance/reports" element={<FinancialReportsPage />} />
                      <Route path="/finance/export" element={<ExportDataPage />} />
                      <Route path="/finance/refunds" element={<RefundsPage />} />
                      <Route path="/demo" element={<DemoDataPage />} />
                      <Route path="/integrations" element={<RequireOwner><IntegrationsPage /></RequireOwner>} />
                      <Route path="/settings" element={<SettingsPage />} />
                      <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                  </AppLayout>
                </RequireAuth>
              }
            />
            </Routes>
          </ErrorBoundary>
        </BrowserRouter>
      </QueryProvider>
    </AuthProvider>
  );
}

export default App;
