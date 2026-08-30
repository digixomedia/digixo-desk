import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { PageContainer, PageHeader, EmptyState, StatusBadge } from "@/components/ui-shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  KeyRound,
  Plus,
  Copy,
  Check,
  RefreshCw,
  Ban,
  Activity,
  Clock,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  ALL_API_SCOPES,
  type ApiKey,
  type ApiKeyAnalytics,
  type ApiRequestLog,
  type ApiRequestLogsResult,
  type CreateApiKeyResult,
} from "@/lib/types";

function keyStatus(key: ApiKey): { label: string; status: string } {
  if (key.revoked_at) return { label: "Revoked", status: "cancelled" };
  if (key.expires_at && new Date(key.expires_at) <= new Date())
    return { label: "Expired", status: "overdue" };
  if (!key.is_active) return { label: "Inactive", status: "cancelled" };
  return { label: "Active", status: "activated" };
}

function CreateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [expiry, setExpiry] = useState("");
  const [newKey, setNewKey] = useState<CreateApiKeyResult | null>(null);
  const [copied, setCopied] = useState(false);

  const createKey = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Integration name is required");
      const expiresAt = expiry ? new Date(expiry + "T23:59:59").toISOString() : null;
      const { data, error } = await supabase.rpc("create_api_key", {
        p_integration_name: name.trim(),
        p_scopes: selectedScopes,
        p_expires_at: expiresAt,
      });
      if (error) throw error;
      return data as CreateApiKeyResult;
    },
    onSuccess: (data) => {
      setNewKey(data);
      queryClient.invalidateQueries({ queryKey: ["api-analytics"] });
      toast.success("API key created");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleScope = (scope: string) => {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  };

  const handleClose = () => {
    setNewKey(null);
    setName("");
    setSelectedScopes([]);
    setExpiry("");
    setCopied(false);
    onOpenChange(false);
  };

  const copyKey = async () => {
    if (!newKey) return;
    await navigator.clipboard.writeText(newKey.api_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        {newKey ? (
          <>
            <DialogHeader>
              <DialogTitle>API Key Created</DialogTitle>
              <DialogDescription>
                Copy this key now. It will not be shown again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <code className="break-all text-sm font-mono">{newKey.api_key}</code>
                  <Button size="sm" variant="ghost" onClick={copyKey} className="shrink-0">
                    {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                <p className="text-sm text-warning">
                  Store this key securely. You will not be able to see it again. If you lose it, you will need to rotate the key.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Generate New API Key</DialogTitle>
              <DialogDescription>
                Create a key for an external integration. The key will be shown only once.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="int-name">Integration Name</Label>
                <Input
                  id="int-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Store Bot, Telegram Bot"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Scopes</Label>
                <p className="text-xs text-muted-foreground">Select the permissions this key grants.</p>
                <div className="grid grid-cols-2 gap-2">
                  {ALL_API_SCOPES.map((scope) => (
                    <label
                      key={scope}
                      className="flex items-center gap-2 rounded-md border p-2 text-sm cursor-pointer hover:bg-muted/50"
                    >
                      <input
                        type="checkbox"
                        checked={selectedScopes.includes(scope)}
                        onChange={() => toggleScope(scope)}
                        className="h-4 w-4"
                      />
                      <span className="font-mono text-xs">{scope}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expiry">Expiry Date (optional)</Label>
                <Input
                  id="expiry"
                  type="date"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Leave blank for no expiry.</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}>Cancel</Button>
              <Button onClick={() => createKey.mutate()} disabled={createKey.isPending || !name.trim()}>
                {createKey.isPending ? "Generating..." : "Generate Key"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RotateKeyDialog({
  open,
  onOpenChange,
  keyId,
  keyName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  keyId: string | null;
  keyName: string;
}) {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState<CreateApiKeyResult | null>(null);
  const [copied, setCopied] = useState(false);

  const rotateKey = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("rotate_api_key", { p_key_id: keyId });
      if (error) throw error;
      return data as CreateApiKeyResult;
    },
    onSuccess: (data) => {
      setNewKey(data);
      queryClient.invalidateQueries({ queryKey: ["api-analytics"] });
      toast.success("Key rotated");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleClose = () => {
    setNewKey(null);
    setCopied(false);
    onOpenChange(false);
  };

  const copyKey = async () => {
    if (!newKey) return;
    await navigator.clipboard.writeText(newKey.api_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        {newKey ? (
          <>
            <DialogHeader>
              <DialogTitle>Key Rotated</DialogTitle>
              <DialogDescription>
                The old key has been revoked. Copy the new key now — it will not be shown again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <code className="break-all text-sm font-mono">{newKey.api_key}</code>
                  <Button size="sm" variant="ghost" onClick={copyKey} className="shrink-0">
                    {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                <p className="text-sm text-warning">
                  Store this new key securely. The old key no longer works.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Rotate API Key</DialogTitle>
              <DialogDescription>
                This will revoke the current key for "{keyName}" and generate a new one with the same scopes. The old key will stop working immediately.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => rotateKey.mutate()}
                disabled={rotateKey.isPending}
              >
                {rotateKey.isPending ? "Rotating..." : "Rotate Key"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeKeyDialog({
  open,
  onOpenChange,
  keyId,
  keyName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  keyId: string | null;
  keyName: string;
}) {
  const queryClient = useQueryClient();
  const revokeKey = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("revoke_api_key", { p_key_id: keyId });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-analytics"] });
      onOpenChange(false);
      toast.success("Key revoked");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke API Key?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently revoke the key for "{keyName}". The key will stop working immediately. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => revokeKey.mutate()}
            disabled={revokeKey.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {revokeKey.isPending ? "Revoking..." : "Revoke Key"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RequestLogsSection() {
  const [page, setPage] = useState(0);
  const limit = 50;

  const { data, isLoading } = useQuery({
    queryKey: ["api-request-logs", page],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_api_request_logs", {
        p_limit: limit,
        p_offset: page * limit,
      });
      if (error) throw error;
      return data as ApiRequestLogsResult;
    },
  });

  const logs = (data?.logs ?? []) as ApiRequestLog[];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" /> Recent API Requests
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No API requests logged yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Time</th>
                    <th className="py-2 pr-3 font-medium">Endpoint</th>
                    <th className="py-2 pr-3 font-medium">Integration</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Result</th>
                    <th className="py-2 font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 text-muted-foreground">{formatDateTime(log.created_at)}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{log.method} {log.endpoint}</td>
                      <td className="py-2 pr-3">{log.integration_name ?? "—"}</td>
                      <td className="py-2 pr-3">
                        <span className={log.status_code < 400 ? "text-success" : log.status_code < 500 ? "text-warning" : "text-destructive"}>
                          {log.status_code}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <span className={
                          log.result === "success" ? "text-success" :
                          log.result === "auth_error" ? "text-destructive" :
                          log.result === "rate_limited" ? "text-warning" :
                          "text-destructive"
                        }>
                          {log.result.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {log.duration_ms != null ? `${log.duration_ms}ms` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-3">
                <p className="text-xs text-muted-foreground">
                  {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}
                </p>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={page === 0}
                    onClick={() => setPage(p => p - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage(p => p + 1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function IntegrationsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<{ id: string; name: string } | null>(null);

  const { data: analytics, isLoading } = useQuery({
    queryKey: ["api-analytics"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_api_key_analytics");
      if (error) throw error;
      return data as ApiKeyAnalytics;
    },
  });

  const keys = (analytics?.keys ?? []) as ApiKey[];
  const stats = analytics?.stats;

  const openRotate = (key: ApiKey) => {
    setSelectedKey({ id: key.id, name: key.integration_name });
    setRotateOpen(true);
  };

  const openRevoke = (key: ApiKey) => {
    setSelectedKey({ id: key.id, name: key.integration_name });
    setRevokeOpen(true);
  };

  const summaryCards = [
    {
      label: "Total Keys",
      value: stats?.total_keys ?? 0,
      icon: <KeyRound className="h-5 w-5" />,
      tone: "text-primary bg-primary/10",
    },
    {
      label: "Active",
      value: stats?.active_keys ?? 0,
      icon: <Check className="h-5 w-5" />,
      tone: "text-success bg-success/10",
    },
    {
      label: "Total Requests",
      value: stats?.total_requests ?? 0,
      icon: <Activity className="h-5 w-5" />,
      tone: "text-info bg-info/10",
    },
    {
      label: "Requests Today",
      value: stats?.requests_today ?? 0,
      icon: <Clock className="h-5 w-5" />,
      tone: "text-muted-foreground bg-muted/50",
    },
  ];

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Integrations"
          description="Manage DigiXO Desk API keys for external integrations"
          actions={
            <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Generate Key</span>
            </Button>
          }
        />

        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {isLoading
            ? Array.from({ length: 4 }).map((_, i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <Skeleton className="h-10 w-10 rounded-lg" />
                    <Skeleton className="mt-2 h-4 w-20" />
                    <Skeleton className="mt-1 h-6 w-16" />
                  </CardContent>
                </Card>
              ))
            : summaryCards.map((card) => (
                <Card key={card.label}>
                  <CardContent className="flex items-center gap-3 p-4">
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${card.tone}`}>
                      {card.icon}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-muted-foreground">{card.label}</p>
                      <p className="text-lg font-semibold tracking-tight">{card.value}</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
        </div>

        {/* Keys list */}
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : keys.length === 0 ? (
          <EmptyState
            icon={<KeyRound className="h-5 w-5" />}
            title="No API keys yet"
            description="Generate a key to allow an external integration to connect to DigiXO Desk."
            action={
              <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" /> Generate Key
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {keys.map((key) => {
              const status = keyStatus(key);
              const isActive = status.label === "Active";
              return (
                <Card key={key.id}>
                  <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{key.integration_name}</span>
                        <StatusBadge status={status.status} label={status.label} />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="font-mono">{key.key_prefix}...</span>
                        <span>Created {formatDate(key.created_at)}</span>
                        {key.created_by_name && <span>By {key.created_by_name}</span>}
                        {key.expires_at && <span>Expires {formatDate(key.expires_at)}</span>}
                        {key.last_used_at && <span>Last used {formatDate(key.last_used_at)}</span>}
                        {key.request_count > 0 && <span>{key.request_count} requests</span>}
                      </div>
                      {key.scopes.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {key.scopes.map((scope) => (
                            <span key={scope} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
                              {scope}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {isActive && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => openRotate(key)}>
                          <RefreshCw className="mr-1 h-3.5 w-3.5" /> Rotate
                        </Button>
                        <Button size="sm" variant="outline" className="text-destructive" onClick={() => openRevoke(key)}>
                          <Ban className="mr-1 h-3.5 w-3.5" /> Revoke
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Request logs */}
        <RequestLogsSection />

        {/* Dialogs */}
        <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} />
        {selectedKey && (
          <>
            <RotateKeyDialog
              open={rotateOpen}
              onOpenChange={setRotateOpen}
              keyId={selectedKey.id}
              keyName={selectedKey.name}
            />
            <RevokeKeyDialog
              open={revokeOpen}
              onOpenChange={setRevokeOpen}
              keyId={selectedKey.id}
              keyName={selectedKey.name}
            />
          </>
        )}
      </div>
    </PageContainer>
  );
}
