import { useState, useEffect } from "react";
import { PageContainer, PageHeader } from "@/components/ui-shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTheme } from "@/components/theme-provider";
import { toast } from "sonner";
import { Save, Settings as SettingsIcon, Palette, CreditCard } from "lucide-react";

const STORAGE_KEY = "digixodesk-settings";

interface UserSettings {
  defaultPaymentMethod: string;
  defaultCustomerType: string;
  defaultAcquisitionSource: string;
  compactTables: boolean;
}

const DEFAULT_SETTINGS: UserSettings = {
  defaultPaymentMethod: "UPI",
  defaultCustomerType: "retail",
  defaultAcquisitionSource: "WhatsApp",
  compactTables: false,
};

function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: UserSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function getSettings(): UserSettings {
  return loadSettings();
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setSettings(loadSettings());
    setLoaded(true);
  }, []);

  const update = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    saveSettings(settings);
    toast.success("Settings saved");
  };

  if (!loaded) return null;

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Settings"
          description="Customize your preferences — these will be used to pre-fill the New Sale form"
          actions={
            <Button onClick={handleSave}>
              <Save className="mr-1.5 h-4 w-4" /> Save
            </Button>
          }
        />

        {/* Appearance */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Palette className="h-4 w-4" /> Appearance
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm">Theme</Label>
                <p className="text-xs text-muted-foreground">Choose light or dark mode</p>
              </div>
              <Select value={theme} onValueChange={setTheme}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm">Compact Tables</Label>
                <p className="text-xs text-muted-foreground">Reduce row padding in tables</p>
              </div>
              <Switch
                checked={settings.compactTables}
                onCheckedChange={(v) => update("compactTables", v)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Default sale preferences */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <CreditCard className="h-4 w-4" /> New Sale Defaults
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm">Default Payment Method</Label>
                <p className="text-xs text-muted-foreground">Pre-selected when creating a sale</p>
              </div>
              <Select
                value={settings.defaultPaymentMethod}
                onValueChange={(v) => update("defaultPaymentMethod", v)}
              >
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="UPI">UPI</SelectItem>
                  <SelectItem value="Bank Transfer">Bank Transfer</SelectItem>
                  <SelectItem value="Cash">Cash</SelectItem>
                  <SelectItem value="Card">Card</SelectItem>
                  <SelectItem value="Crypto">Crypto</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm">Default Customer Type</Label>
                <p className="text-xs text-muted-foreground">Pre-selected for new customers</p>
              </div>
              <Select
                value={settings.defaultCustomerType}
                onValueChange={(v) => update("defaultCustomerType", v)}
              >
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="retail">Retail</SelectItem>
                  <SelectItem value="reseller">Reseller</SelectItem>
                  <SelectItem value="business">Business</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm">Default Acquisition Source</Label>
                <p className="text-xs text-muted-foreground">Pre-selected for new customers</p>
              </div>
              <Select
                value={settings.defaultAcquisitionSource}
                onValueChange={(v) => update("defaultAcquisitionSource", v)}
              >
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
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
          </CardContent>
        </Card>

        {/* About */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <SettingsIcon className="h-4 w-4" /> About
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-1 text-sm text-muted-foreground">
              <p>DigiXO Desk — Admin Panel</p>
              <p>Version 2.0</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
