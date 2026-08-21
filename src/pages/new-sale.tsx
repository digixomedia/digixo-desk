import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { PageContainer, PageHeader } from "@/components/ui-shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Search, UserCheck, Package, IndianRupee, CreditCard, Calendar, Check } from "lucide-react";
import { normalizePhone, formatMoney, formatDate } from "@/lib/format";
import type { Customer, Product, ProductPlan, FulfilmentStatus, PurchaseType } from "@/lib/types";

export function NewSalePage() {
  const { isOwner } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  // Step state
  const [step, setStep] = useState(1);

  // Step 1: Customer
  const [phoneSearch, setPhoneSearch] = useState("");
  const [searchedPhone, setSearchedPhone] = useState("");
  const [existingCustomer, setExistingCustomer] = useState<Customer | null>(null);
  const [useExisting, setUseExisting] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newType, setNewType] = useState("retail");
  const [newSource, setNewSource] = useState("WhatsApp");

  // Step 2: Product
  const [isCustom, setIsCustom] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const [customProductName, setCustomProductName] = useState("");
  const [customPlanName, setCustomPlanName] = useState("");
  const [customPurchaseType, setCustomPurchaseType] = useState<PurchaseType>("one_time");
  const [customDuration, setCustomDuration] = useState("");
  const [customWarranty, setCustomWarranty] = useState("");

  // Step 3: Prices
  const [listPrice, setListPrice] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [sellingPrice, setSellingPrice] = useState("");
  const [paymentFee, setPaymentFee] = useState("");
  const [updateDefaults, setUpdateDefaults] = useState(false);

  // Step 4: Payment & fulfilment
  const [amountReceived, setAmountReceived] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [txnRef, setTxnRef] = useState("");
  const [fulfilmentStatus, setFulfilmentStatus] = useState<FulfilmentStatus>("payment_confirmation");
  const [saleDate, setSaleDate] = useState(new Date().toISOString().slice(0, 10));

  // Step 5: Subscription dates
  const [subStartDate, setSubStartDate] = useState(saleDate);
  const [renewalDate, setRenewalDate] = useState("");
  const [warrantyEndDate, setWarrantyEndDate] = useState("");


  // Step 6: Notes
  const [note, setNote] = useState("");

  // Pre-fill customer from URL
  useEffect(() => {
    const customerId = searchParams.get("customer");
    if (customerId) {
      supabase
        .from("customers")
        .select("*")
        .eq("id", customerId)
        .maybeSingle()
        .then(({ data, error }) => {
          if (!error && data) {
            setExistingCustomer(data as Customer);
            setUseExisting(true);
            setPhoneSearch(data.phone_display ?? data.phone_normalized);
            setSearchedPhone(data.phone_normalized);
            setStep(2);
          }
        });
    }
  }, [searchParams]);

  const { data: products } = useQuery({
    queryKey: ["products"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("*, category:categories(*)")
        .is("archived_at", null)
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return data as Product[];
    },
  });

  const selectedProduct = products?.find((p) => p.id === selectedProductId);

  const { data: plans } = useQuery({
    queryKey: ["plans-for-product", selectedProductId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_plans")
        .select("*")
        .eq("product_id", selectedProductId!)
        .is("archived_at", null)
        .eq("is_active", true)
        .order("created_at");
      if (error) throw error;
      return data as ProductPlan[];
    },
    enabled: !!selectedProductId,
  });

  const selectedPlan = plans?.find((p) => p.id === selectedPlanId);

  // Auto-fill prices when plan selected
  useEffect(() => {
    if (selectedPlan) {
      setCostPrice(selectedPlan.default_cost_price.toString());
      setSellingPrice(selectedPlan.default_selling_price.toString());
      setListPrice(selectedPlan.optional_list_price?.toString() ?? "");
      // Auto-calculate dates
      const sd = saleDate;
      setSubStartDate(sd);
      if (selectedPlan.purchase_type === "recurring" && selectedPlan.duration_days) {
        const rd = new Date(sd);
        rd.setDate(rd.getDate() + selectedPlan.duration_days);
        setRenewalDate(rd.toISOString().slice(0, 10));
      }
      if (selectedPlan.warranty_days) {
        const wd = new Date(sd);
        wd.setDate(wd.getDate() + selectedPlan.warranty_days);
        setWarrantyEndDate(wd.toISOString().slice(0, 10));
      }
    }
  }, [selectedPlanId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Search customer by phone
  const searchMutation = useMutation({
    mutationFn: async (phone: string) => {
      const norm = normalizePhone(phone);
      if (!norm) throw new Error("Invalid phone number");
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .eq("phone_normalized", norm)
        .maybeSingle();
      if (error) throw error;
      return data as Customer | null;
    },
    onSuccess: (data) => {
      setExistingCustomer(data);
      setUseExisting(!!data);
      setSearchedPhone(normalizePhone(phoneSearch));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const { data: recentSales } = useQuery({
    queryKey: ["customer-recent-sales", existingCustomer?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("*")
        .eq("customer_id", existingCustomer!.id)
        .order("sale_date", { ascending: false })
        .limit(3);
      if (error) throw error;
      return data;
    },
    enabled: !!existingCustomer?.id,
  });

  const createSaleMutation = useMutation({
    mutationFn: async (redirectAction: "view" | "another" | "list") => {
      const payload: Record<string, unknown> = {
        sale_date: saleDate,
        fulfilment_status: fulfilmentStatus,
        payment_method: paymentMethod || null,
        transaction_reference: txnRef || null,
        note: note || null,
        is_custom: isCustom,
        final_selling_price: parseFloat(sellingPrice) || 0,
        cost_price: parseFloat(costPrice) || 0,
        payment_fee: parseFloat(paymentFee) || 0,
        amount_received: parseFloat(amountReceived) || 0,
      };

      if (listPrice) payload.list_price = parseFloat(listPrice);

      // Customer
      if (useExisting && existingCustomer) {
        payload.customer_id = existingCustomer.id;
      } else {
        payload.new_customer_name = newName || null;
        payload.new_customer_phone = phoneSearch;
        payload.new_customer_email = newEmail || null;
        payload.new_customer_type = newType;
        payload.new_customer_source = newSource;
      }

      // Product
      if (isCustom) {
        payload.product_name = customProductName;
        payload.plan_name = customPlanName || "Custom";
        payload.purchase_type = customPurchaseType;
        if (customDuration) payload.duration_days = parseInt(customDuration);
        if (customWarranty) payload.warranty_days = parseInt(customWarranty);
      } else {
        payload.product_plan_id = selectedPlanId;
      }

      // Subscription dates
      if (selectedPlan?.purchase_type === "recurring" || (isCustom && customPurchaseType === "recurring")) {
        payload.subscription_start_date = subStartDate || saleDate;
        payload.renewal_date = renewalDate || null;
      }
      if (warrantyEndDate) payload.warranty_end_date = warrantyEndDate;

      const { data, error } = await supabase.rpc("create_sale", { p_payload: payload });
      if (error) throw error;
      return { data, redirectAction };
    },
    onSuccess: ({ data, redirectAction }) => {
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["sales"] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast.success(`Sale ${data.sale_number} created`);

      if (redirectAction === "view" && data.customer_id) {
        navigate(`/customers/${data.customer_id}`);
      } else if (redirectAction === "another") {
        // Reset form
        setStep(1);
        setPhoneSearch("");
        setSearchedPhone("");
        setExistingCustomer(null);
        setUseExisting(false);
        setSelectedProductId("");
        setSelectedPlanId("");
        setIsCustom(false);
        setCostPrice("");
        setSellingPrice("");
        setListPrice("");
        setPaymentFee("");
        setAmountReceived("");
        setPaymentMethod("");
        setTxnRef("");
        setNote("");
        setRenewalDate("");
        setWarrantyEndDate("");
      } else {
        navigate("/sales");
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Calculations
  const selling = parseFloat(sellingPrice) || 0;
  const cost = parseFloat(costPrice) || 0;
  const fee = parseFloat(paymentFee) || 0;
  const expectedProfit = selling - cost - fee;
  const margin = selling > 0 ? (expectedProfit / selling) * 100 : 0;

  const isRecurring = isCustom ? customPurchaseType === "recurring" : selectedPlan?.purchase_type === "recurring";

  const canProceed = () => {
    if (step === 1) {
      if (useExisting && existingCustomer) return true;
      if (!useExisting && phoneSearch.trim()) return true;
      return false;
    }
    if (step === 2) {
      if (isCustom) return !!customProductName.trim();
      return !!selectedPlanId;
    }
    if (step === 3) return selling > 0 && cost >= 0;
    return true;
  };

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader title="New Sale" description="Create a sale in a few quick steps" />

        {/* Step indicator */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {[
            { n: 1, label: "Customer" },
            { n: 2, label: "Product" },
            { n: 3, label: "Prices" },
            { n: 4, label: "Payment" },
            { n: 5, label: "Subscription" },
            { n: 6, label: "Review" },
          ].map((s) => (
            <div
              key={s.n}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                step >= s.n
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              <span className="flex h-4 w-4 items-center justify-center rounded-full">
                {step > s.n ? <Check className="h-3 w-3" /> : s.n}
              </span>
              {s.label}
            </div>
          ))}
        </div>

        {/* Step 1: Customer */}
        {step === 1 && (
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><UserCheck className="h-4 w-4" /> Customer</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="phone-search">Phone Number</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="phone-search"
                      value={phoneSearch}
                      onChange={(e) => setPhoneSearch(e.target.value)}
                      placeholder="Enter phone number to search…"
                      className="pl-9"
                      autoFocus
                    />
                  </div>
                  <Button onClick={() => searchMutation.mutate(phoneSearch)} disabled={!phoneSearch.trim() || searchMutation.isPending}>
                    Search
                  </Button>
                </div>
              </div>

              {existingCustomer && useExisting && (
                <div className="rounded-lg border border-success/20 bg-success/5 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{existingCustomer.name ?? "Unnamed"}</p>
                      <p className="text-sm text-muted-foreground">{existingCustomer.phone_display ?? existingCustomer.phone_normalized}</p>
                      <p className="text-xs text-muted-foreground">Type: {existingCustomer.customer_type}</p>
                    </div>
                    <span className="rounded-md bg-success/10 px-2 py-1 text-xs font-medium text-success">Existing</span>
                  </div>
                  {recentSales && recentSales.length > 0 && (
                    <div className="mt-3 border-t pt-3">
                      <p className="text-xs font-medium text-muted-foreground">Recent purchases:</p>
                      {recentSales.map((s: any) => (
                        <div key={s.id} className="mt-1 flex justify-between text-xs">
                          <span>{s.product_name_snapshot} · {s.plan_name_snapshot}</span>
                          <span className="text-muted-foreground">{formatDate(s.sale_date)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {searchedPhone && !existingCustomer && (
                <div className="rounded-lg border border-info/20 bg-info/5 p-4">
                  <p className="text-sm font-medium">No existing customer found for this phone.</p>
                  <p className="text-xs text-muted-foreground">Fill in the details below to create a new customer.</p>
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="new-name">Name</Label>
                      <Input id="new-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Optional" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="new-email">Email</Label>
                      <Input id="new-email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Optional" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="new-type">Customer Type</Label>
                      <Select value={newType} onValueChange={setNewType}>
                        <SelectTrigger id="new-type"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="retail">Retail</SelectItem>
                          <SelectItem value="reseller">Reseller</SelectItem>
                          <SelectItem value="business">Business</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="new-source">Source</Label>
                      <Select value={newSource} onValueChange={setNewSource}>
                        <SelectTrigger id="new-source"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="WhatsApp">WhatsApp</SelectItem>
                          <SelectItem value="Telegram">Telegram</SelectItem>
                          <SelectItem value="Website">Website</SelectItem>
                          <SelectItem value="Referral">Referral</SelectItem>
                          <SelectItem value="Reseller">Reseller</SelectItem>
                          <SelectItem value="Other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <Button onClick={() => setStep(2)} disabled={!canProceed()}>
                  Next
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 2: Product */}
        {step === 2 && (
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Package className="h-4 w-4" /> Product & Plan</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Switch id="custom-product" checked={isCustom} onCheckedChange={setIsCustom} />
                <Label htmlFor="custom-product">Custom / Unlisted Product</Label>
              </div>

              {isCustom ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="custom-name">Product Name</Label>
                    <Input id="custom-name" value={customProductName} onChange={(e) => setCustomProductName(e.target.value)} required autoFocus />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="custom-plan">Plan Name</Label>
                    <Input id="custom-plan" value={customPlanName} onChange={(e) => setCustomPlanName(e.target.value)} placeholder="e.g. 1 Year" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="custom-type">Purchase Type</Label>
                    <Select value={customPurchaseType} onValueChange={(v) => setCustomPurchaseType(v as PurchaseType)}>
                      <SelectTrigger id="custom-type"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="one_time">One-time</SelectItem>
                        <SelectItem value="recurring">Recurring</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="custom-duration">Duration (days)</Label>
                    <Input id="custom-duration" type="number" min={0} value={customDuration} onChange={(e) => setCustomDuration(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="custom-warranty">Warranty (days)</Label>
                    <Input id="custom-warranty" type="number" min={0} value={customWarranty} onChange={(e) => setCustomWarranty(e.target.value)} />
                  </div>
                </div>
              ) : (
                <>
                  {!products ? (
                    <Skeleton className="h-10" />
                  ) : products.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No products available. Create products first or use a custom product.</p>
                  ) : (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="product-select">Product</Label>
                        <Select value={selectedProductId} onValueChange={(v) => { setSelectedProductId(v); setSelectedPlanId(""); }}>
                          <SelectTrigger id="product-select"><SelectValue placeholder="Select product" /></SelectTrigger>
                          <SelectContent>
                            {products.map((p) => (
                              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {selectedProductId && (
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="plan-select">Plan</Label>
                          {!plans ? (
                            <Skeleton className="h-10" />
                          ) : plans.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No plans for this product. Add plans in the Products page or use custom.</p>
                          ) : (
                            <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
                              <SelectTrigger id="plan-select"><SelectValue placeholder="Select plan" /></SelectTrigger>
                              <SelectContent>
                                {plans.map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    {p.plan_name} — {formatMoney(p.default_selling_price)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      )}

                      {selectedPlan && (
                        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Type:</span>
                            <span className="font-medium">{selectedPlan.purchase_type === "recurring" ? "Recurring" : "One-time"}</span>
                          </div>
                          {selectedPlan.duration_days && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Duration:</span>
                              <span className="font-medium">{selectedPlan.duration_days} days</span>
                            </div>
                          )}
                          {selectedPlan.warranty_days && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Warranty:</span>
                              <span className="font-medium">{selectedPlan.warranty_days} days</span>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
                <Button onClick={() => setStep(3)} disabled={!canProceed()}>Next</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Prices */}
        {step === 3 && (
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><IndianRupee className="h-4 w-4" /> Prices</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="list-price">List Price (optional)</Label>
                  <Input id="list-price" type="number" min={0} step="0.01" value={listPrice} onChange={(e) => setListPrice(e.target.value)} placeholder="0.00" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cost-price">Product Cost</Label>
                  <Input id="cost-price" type="number" min={0} step="0.01" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} required />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="selling-price">Customer Selling Price</Label>
                  <Input id="selling-price" type="number" min={0} step="0.01" value={sellingPrice} onChange={(e) => setSellingPrice(e.target.value)} required />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="payment-fee">Payment Fee (optional)</Label>
                  <Input id="payment-fee" type="number" min={0} step="0.01" value={paymentFee} onChange={(e) => setPaymentFee(e.target.value)} placeholder="0.00" />
                </div>
              </div>

              {isOwner && !isCustom && selectedPlanId && (
                <div className="flex items-center gap-2 rounded-lg border p-3">
                  <Switch id="update-defaults" checked={updateDefaults} onCheckedChange={setUpdateDefaults} />
                  <Label htmlFor="update-defaults" className="text-sm">
                    Update product defaults using these prices
                    <span className="block text-xs text-muted-foreground">Owner-only. Does not affect existing sales.</span>
                  </Label>
                </div>
              )}

              {/* Live summary */}
              <div className="rounded-lg border bg-muted/30 p-4">
                <p className="mb-3 text-sm font-medium">Transaction Summary</p>
                <div className="flex flex-col gap-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Selling Price</span>
                    <span className="font-medium">{formatMoney(selling)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Product Cost</span>
                    <span>{formatMoney(cost)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Payment Fee</span>
                    <span>{formatMoney(fee)}</span>
                  </div>
                  <div className="border-t pt-1.5">
                    <div className="flex justify-between">
                      <span className="font-medium">Expected Profit</span>
                      <span className={`font-semibold ${expectedProfit >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(expectedProfit)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Profit Margin</span>
                      <span className="font-medium">{margin.toFixed(1)}%</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
                <Button onClick={() => setStep(4)} disabled={!canProceed()}>Next</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 4: Payment & fulfilment */}
        {step === 4 && (
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><CreditCard className="h-4 w-4" /> Payment & Fulfilment</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sale-date">Sale Date</Label>
                  <Input id="sale-date" type="date" value={saleDate} onChange={(e) => setSaleDate(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="amount-received">Amount Received</Label>
                  <Input id="amount-received" type="number" min={0} step="0.01" value={amountReceived} onChange={(e) => setAmountReceived(e.target.value)} placeholder="0.00" />
                  {(() => {
                    const received = parseFloat(amountReceived) || 0;
                    const derived = received >= selling && selling > 0 ? "Paid" : received > 0 ? "Partial" : "Pending";
                    const tone = derived === "Paid" ? "text-success" : derived === "Partial" ? "text-warning" : "text-muted-foreground";
                    return <p className={`text-xs font-medium ${tone}`}>Payment will be marked: {derived}</p>;
                  })()}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="payment-method">Payment Method</Label>
                  <Select value={paymentMethod || "none"} onValueChange={(v) => setPaymentMethod(v === "none" ? "" : v)}>
                    <SelectTrigger id="payment-method"><SelectValue placeholder="Select method" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="UPI">UPI</SelectItem>
                      <SelectItem value="Bank Transfer">Bank Transfer</SelectItem>
                      <SelectItem value="Cash">Cash</SelectItem>
                      <SelectItem value="Card">Card</SelectItem>
                      <SelectItem value="Crypto">Crypto</SelectItem>
                      <SelectItem value="Other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="txn-ref">Transaction Reference</Label>
                  <Input id="txn-ref" value={txnRef} onChange={(e) => setTxnRef(e.target.value)} placeholder="Optional" />
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="fulfilment-status">Fulfilment Status</Label>
                  <Select value={fulfilmentStatus} onValueChange={(v) => setFulfilmentStatus(v as FulfilmentStatus)}>
                    <SelectTrigger id="fulfilment-status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="payment_confirmation">Payment Confirmation</SelectItem>
                      <SelectItem value="activation_pending">Activation Pending</SelectItem>
                      <SelectItem value="processing">Processing</SelectItem>
                      <SelectItem value="activated">Activated</SelectItem>
                      <SelectItem value="replacement_required">Replacement Required</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                      <SelectItem value="cancelled">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(3)}>Back</Button>
                <Button onClick={() => { if (isRecurring) setStep(5); else setStep(6); }} disabled={!canProceed()}>
                  {isRecurring ? "Next" : "Skip to Review"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 5: Subscription dates */}
        {step === 5 && isRecurring && (
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Calendar className="h-4 w-4" /> Subscription & Warranty</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sub-start">Subscription Start Date</Label>
                  <Input id="sub-start" type="date" value={subStartDate} onChange={(e) => setSubStartDate(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="renewal-date">Renewal Date</Label>
                  <Input id="renewal-date" type="date" value={renewalDate} onChange={(e) => setRenewalDate(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="warranty-end">Warranty End Date</Label>
                  <Input id="warranty-end" type="date" value={warrantyEndDate} onChange={(e) => setWarrantyEndDate(e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                A subscription record and the first renewal entry will be created automatically.
              </p>
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(4)}>Back</Button>
                <Button onClick={() => setStep(6)}>Next</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 6: Review & Save */}
        {step === 6 && (
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Check className="h-4 w-4" /> Review & Save</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="rounded-lg border p-4 text-sm">
                <p className="mb-2 font-medium">Customer</p>
                <p className="text-muted-foreground">
                  {useExisting && existingCustomer
                    ? `${existingCustomer.name ?? "Unnamed"} — ${existingCustomer.phone_display ?? existingCustomer.phone_normalized}`
                    : `${newName || "New customer"} — ${phoneSearch}`}
                </p>
              </div>
              <div className="rounded-lg border p-4 text-sm">
                <p className="mb-2 font-medium">Product</p>
                <p className="text-muted-foreground">
                  {isCustom
                    ? `${customProductName} — ${customPlanName || "Custom"}`
                    : `${selectedProduct?.name ?? "—"} — ${selectedPlan?.plan_name ?? "—"}`}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 rounded-lg border p-4 text-sm">
                <div><p className="text-muted-foreground">Selling Price</p><p className="font-medium">{formatMoney(selling)}</p></div>
                <div><p className="text-muted-foreground">Product Cost</p><p className="font-medium">{formatMoney(cost)}</p></div>
                <div><p className="text-muted-foreground">Payment Fee</p><p className="font-medium">{formatMoney(fee)}</p></div>
                <div><p className="text-muted-foreground">Expected Profit</p><p className="font-semibold text-success">{formatMoney(expectedProfit)}</p></div>
              </div>
              <div className="rounded-lg border p-4 text-sm">
                <p className="mb-2 font-medium">Payment</p>
                <div className="flex gap-4 text-muted-foreground">
                  {(() => {
                    const received = parseFloat(amountReceived) || 0;
                    const derived = received >= selling && selling > 0 ? "Paid" : received > 0 ? "Partial" : "Pending";
                    return <span>Status: <span className="font-medium text-foreground">{derived}</span></span>;
                  })()}
                  {amountReceived && <span>Received: <span className="font-medium text-foreground">{formatMoney(parseFloat(amountReceived))}</span></span>}
                  {paymentMethod && <span>Method: <span className="font-medium text-foreground">{paymentMethod}</span></span>}
                </div>
              </div>
              {isRecurring && renewalDate && (
                <div className="rounded-lg border p-4 text-sm">
                  <p className="mb-2 font-medium">Subscription</p>
                  <p className="text-muted-foreground">Start: {formatDate(subStartDate)} · Renewal: {formatDate(renewalDate)}</p>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-note">Note</Label>
                <Textarea id="sale-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Optional" />
              </div>

              <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-card px-4 py-3 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={() => (isRecurring ? setStep(5) : setStep(4))}>Back</Button>
                <Button variant="outline" onClick={() => createSaleMutation.mutate("list")} disabled={createSaleMutation.isPending}>
                  Save Sale
                </Button>
                <Button variant="outline" onClick={() => createSaleMutation.mutate("another")} disabled={createSaleMutation.isPending}>
                  Save & Add Another
                </Button>
                <Button onClick={() => createSaleMutation.mutate("view")} disabled={createSaleMutation.isPending}>
                  {createSaleMutation.isPending ? "Saving…" : "Save & View Customer"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </PageContainer>
  );
}
